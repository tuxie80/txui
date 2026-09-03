//! Google Sheets export (service-account flow, no user OAuth).
//!
//! The same service-account JSON key the GCP features use is minted into an
//! access token with the Sheets scope, the target spreadsheet is created when
//! the caller has no id, and the grid (header + rows) is written with one
//! `values.update`. The key never leaves the backend.
//!
//! The failure everyone hits is a 403/404 because the spreadsheet is not
//! shared with the service-account's `client_email` (or the Sheets API is not
//! enabled on its project) — so every non-success response carries Google's
//! error body back to the UI verbatim, where the modal can say exactly that.

use crate::apperror::AppError;
use crate::db::gcp_iam::{mint_token, SHEETS_SCOPE};

#[derive(serde::Deserialize)]
struct CreateResponse {
    #[serde(rename = "spreadsheetId")]
    spreadsheet_id: String,
}

/// Percent-encode a path segment (RFC 3986 unreserved kept, everything else
/// escaped). The A1 range (`'My Sheet'!A1`) travels in the request path, so
/// spaces and `!` have to go through this — there is no urlencoding crate in
/// the tree and one is not worth adding for a dozen characters.
fn url_path_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A1 range for a tab name: quoted (spaces are legal in tab names), inner
/// quotes doubled — the same escaping Sheets itself uses.
fn a1_range(sheet: &str) -> String {
    format!("'{}'!A1", sheet.replace('\'', "''"))
}

/// One cell for the Sheets API: strings/numbers/bools pass through so Sheets
/// types them; null becomes empty, anything else (arrays/objects from JSON
/// columns) its JSON text.
fn cell(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::String(_) | serde_json::Value::Number(_) | serde_json::Value::Bool(_) => v,
        serde_json::Value::Null => serde_json::Value::String(String::new()),
        other => serde_json::Value::String(other.to_string()),
    }
}

/// Read a non-success response into an error that names the status AND shows
/// Google's body — that body is the difference between "share the sheet with
/// the SA email" and a mystery failure.
async fn api_error(context: &str, resp: reqwest::Response) -> AppError {
    let code = resp.status();
    let body: String = resp.text().await.unwrap_or_default().chars().take(600).collect();
    AppError::from(format!("{context} returned {code}: {body}"))
}

/// Create a spreadsheet with one tab named `sheet`; returns its id.
async fn create_spreadsheet(
    client: &reqwest::Client, token: &str, title: &str, sheet: &str,
) -> Result<String, AppError> {
    let body = serde_json::json!({
        "properties": { "title": title },
        "sheets": [{ "properties": { "title": sheet } }],
    });
    let resp = client
        .post("https://sheets.googleapis.com/v4/spreadsheets")
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::from(format!("Sheets create request failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(api_error("Sheets create", resp).await);
    }
    let created: CreateResponse = resp.json().await
        .map_err(|e| AppError::from(format!("Sheets create response was not JSON: {e}")))?;
    Ok(created.spreadsheet_id)
}

/// Export a grid to Google Sheets. With no `spreadsheet_id` a new spreadsheet
/// titled `title` is created (the service account owns it — nothing to share);
/// with one, `sheet` must already be shared with the SA's client_email.
/// Returns the spreadsheet's URL.
#[tauri::command]
pub async fn gsheets_export(
    key_path: String,
    spreadsheet_id: Option<String>,
    title: String,
    sheet: String,
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
) -> Result<String, AppError> {
    let (token, _project) = mint_token(&key_path, SHEETS_SCOPE).await?;
    let client = reqwest::Client::builder().build()
        .map_err(|e| AppError::from(format!("HTTP client: {e}")))?;

    let id = match spreadsheet_id.filter(|s| !s.trim().is_empty()) {
        Some(id) => id.trim().to_string(),
        None => create_spreadsheet(&client, &token, &title, &sheet).await?,
    };

    let range = a1_range(&sheet);
    let mut values: Vec<serde_json::Value> = Vec::with_capacity(rows.len() + 1);
    values.push(serde_json::Value::Array(
        columns.into_iter().map(serde_json::Value::String).collect(),
    ));
    for row in rows {
        values.push(serde_json::Value::Array(row.into_iter().map(cell).collect()));
    }
    let body = serde_json::json!({
        "range": range,
        "majorDimension": "ROWS",
        "values": values,
    });
    let url = format!(
        "https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{}?valueInputOption=RAW",
        url_path_encode(&range),
    );
    let resp = client.put(&url).bearer_auth(&token).json(&body).send().await
        .map_err(|e| AppError::from(format!("Sheets values update failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(api_error("Sheets values update", resp).await);
    }
    Ok(format!("https://docs.google.com/spreadsheets/d/{id}/edit"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_encode_keeps_unreserved_and_escapes_the_rest() {
        assert_eq!(url_path_encode("abc-DEF_019.~"), "abc-DEF_019.~");
        assert_eq!(
            url_path_encode("'My Sheet'!A1"),
            "%27My%20Sheet%27%21A1",
        );
        // Non-ASCII bytes are escaped per byte.
        assert_eq!(url_path_encode("é"), "%C3%A9");
    }

    #[test]
    fn a1_range_quotes_and_doubles_quotes() {
        assert_eq!(a1_range("Sheet1"), "'Sheet1'!A1");
        assert_eq!(a1_range("Bob's data"), "'Bob''s data'!A1");
    }

    #[test]
    fn cells_keep_scalars_and_stringify_the_rest() {
        use serde_json::json;
        assert_eq!(cell(json!("abc")), json!("abc"));
        assert_eq!(cell(json!(42)), json!(42));
        assert_eq!(cell(json!(1.5)), json!(1.5));
        assert_eq!(cell(json!(true)), json!(true));
        assert_eq!(cell(json!(null)), json!(""));
        assert_eq!(cell(json!({"a": 1})), json!("{\"a\":1}"));
        assert_eq!(cell(json!([1, 2])), json!("[1,2]"));
    }
}
