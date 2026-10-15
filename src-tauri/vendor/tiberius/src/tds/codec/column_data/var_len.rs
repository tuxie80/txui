use crate::{sql_read_bytes::SqlReadBytes, tds::codec::VarLenContext, ColumnData, VarLenType};

pub(crate) async fn decode<R>(
    src: &mut R,
    ctx: &VarLenContext,
) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    use VarLenType::*;

    let ty = ctx.r#type();
    let len = ctx.len();
    let collation = ctx.collation();

    let res = match ty {
        Bitn => super::bit::decode(src).await?,
        Intn => super::int::decode(src, len).await?,
        Floatn => super::float::decode(src, len).await?,
        Guid => super::guid::decode(src).await?,
        BigChar | BigVarChar | NChar | NVarchar => {
            ColumnData::String(super::string::decode(src, ty, len, collation).await?)
        }
        Money => {
            let len = src.read_u8().await?;
            super::money::decode(src, len).await?
        }
        Datetimen => {
            let rlen = src.read_u8().await?;
            super::datetimen::decode(src, rlen, len as u8).await?
        }
        #[cfg(feature = "tds73")]
        Daten => super::date::decode(src).await?,
        #[cfg(feature = "tds73")]
        Timen => super::time::decode(src, len).await?,
        #[cfg(feature = "tds73")]
        Datetime2 => super::datetime2::decode(src, len).await?,
        #[cfg(feature = "tds73")]
        DatetimeOffsetn => super::datetimeoffsetn::decode(src, len).await?,
        BigBinary | BigVarBin => super::binary::decode(src, len).await?,
        Text => super::text::decode(src, collation).await?,
        NText => super::text::decode(src, None).await?,
        Image => super::image::decode(src).await?,
        // TxUI vendored patch — CLR UDTs (geometry, geography, hierarchyid,
        // custom types) are length-prefixed binary on the wire (PLP at max
        // length), exactly like varbinary; keep the raw serialization as
        // Binary and let the caller decide how to render it.
        Udt => super::binary::decode(src, len).await?,
        // TxUI vendored patch — an unsupported type must be a query error,
        // never a panic (panic=abort makes a decode panic a process crash).
        t => {
            return Err(crate::Error::Protocol(
                format!("unsupported varlen column type: {:?}", t).into(),
            ))
        }
    };

    Ok(res)
}
