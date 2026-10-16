use crate::{sql_read_bytes::SqlReadBytes, ColumnData};

pub(crate) async fn decode<R>(src: &mut R, type_len: usize) -> crate::Result<ColumnData<'static>>
where
    R: SqlReadBytes + Unpin,
{
    let recv_len = src.read_u8().await? as usize;

    let res = match (recv_len, type_len) {
        (0, 1) => ColumnData::U8(None),
        (0, 2) => ColumnData::I16(None),
        (0, 4) => ColumnData::I32(None),
        (0, _) => ColumnData::I64(None),
        (1, _) => ColumnData::U8(Some(src.read_u8().await?)),
        (2, _) => ColumnData::I16(Some(src.read_i16_le().await?)),
        (4, _) => ColumnData::I32(Some(src.read_i32_le().await?)),
        (8, _) => ColumnData::I64(Some(src.read_i64_le().await?)),
        // TxUI vendored patch — a query error, never a panic
        // (panic=abort makes a decode panic a process crash). An Intn payload
        // length outside {0,1,2,4,8} is the server sending something off-spec;
        // surface it as a Protocol error the caller can report.
        (len, _) => {
            return Err(crate::Error::Protocol(
                format!("invalid Intn payload length: {len}").into(),
            ))
        }
    };

    Ok(res)
}

// TxUI vendored patch — coverage for the panic-to-error arm above.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_read_bytes::test_utils::IntoSqlReadBytes;
    use bytes::BytesMut;

    // The vendored crate's shipped feature set links no async runtime for
    // tests (tokio is an optional dependency, off in TxUI's build), and the
    // decode futures over an in-memory buffer are always immediately ready —
    // so drive them on the noop waker instead of adding a dev-dependency.
    fn block_on<F: std::future::Future>(fut: F) -> F::Output {
        let mut fut = std::pin::pin!(fut);
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        loop {
            match fut.as_mut().poll(&mut cx) {
                std::task::Poll::Ready(v) => return v,
                std::task::Poll::Pending => {
                    unreachable!("an in-memory decode future must never pend")
                }
            }
        }
    }

    #[test]
    fn an_intn_length_outside_the_spec_is_an_error_not_a_panic() {
        // recv_len 3 is not a valid Intn payload length ({0,1,2,4,8}).
        // Upstream hit `unimplemented!()` here, and TxUI's release profile is
        // panic=abort — one off-spec server response crashed the backend.
        let buf = BytesMut::from(&[3u8, 0, 0, 0][..]);
        let reader = &mut buf.into_sql_read_bytes();
        let err = block_on(decode(reader, 8)).expect_err("an off-spec length must error");
        assert!(
            matches!(err, crate::Error::Protocol(_)),
            "expected a Protocol error, got {err:?}");
    }
}
