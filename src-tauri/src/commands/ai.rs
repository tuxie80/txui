//! AI assistant — bounded, provider-agnostic completion calls.
//!
//! Anthropic Messages and OpenAI-compatible chat completions share one path.
//! Non-secret configuration comes from preferences; the optional key stays in
//! the active secret store. Every request has an id so the UI can cancel it.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::State;
use tokio::sync::{oneshot, Mutex};

use crate::apperror::AppError;
use crate::state::AppState;

const AI_KEY: &str = "ai.apiKey";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
type AiCancelMap = Mutex<HashMap<String, oneshot::Sender<()>>>;
static AI_CANCELS: OnceLock<AiCancelMap> = OnceLock::new();

fn cancels() -> &'static AiCancelMap {
    AI_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn ai_set_key(key: String, state: State<'_, AppState>) -> Result<(), AppError> {
    if key.is_empty() {
        crate::secretstore::delete(&state.data_dir, AI_KEY);
        Ok(())
    } else {
        crate::secretstore::set(&state.data_dir, AI_KEY, &key)
            .map_err(|e| AppError::from(format!("could not store the AI key: {e}")))
    }
}

#[tauri::command]
pub async fn ai_has_key(state: State<'_, AppState>) -> Result<bool, AppError> {
    Ok(crate::secretstore::get(&state.data_dir, AI_KEY).is_some_and(|s| !s.is_empty()))
}

fn request_parts(
    provider: &str,
    base_url: &str,
    model: &str,
    system: Option<&str>,
    prompt: &str,
) -> Result<(bool, String, Value), AppError> {
    let base = base_url.trim().trim_end_matches('/');
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err(AppError::from("AI endpoint must be an http:// or https:// URL."));
    }
    if model.trim().is_empty() {
        return Err(AppError::from("No AI model is set — add one in Settings → AI."));
    }
    let anthropic = match provider {
        "anthropic" => true,
        "openai" => false,
        other => return Err(AppError::from(format!("Unsupported AI provider: {other}"))),
    };
    if anthropic {
        let mut body = json!({
            "model": model.trim(),
            "max_tokens": 2048,
            "messages": [{ "role": "user", "content": prompt }],
        });
        if let Some(s) = system.filter(|s| !s.is_empty()) {
            body["system"] = json!(s);
        }
        Ok((true, format!("{base}/v1/messages"), body))
    } else {
        let mut messages = Vec::new();
        if let Some(s) = system.filter(|s| !s.is_empty()) {
            messages.push(json!({ "role": "system", "content": s }));
        }
        messages.push(json!({ "role": "user", "content": prompt }));
        Ok((false, format!("{base}/chat/completions"), json!({
            "model": model.trim(), "messages": messages,
        })))
    }
}

fn completion_text(anthropic: bool, value: &Value) -> Result<String, AppError> {
    let truncated = if anthropic {
        value["stop_reason"].as_str() == Some("max_tokens")
    } else {
        value["choices"][0]["finish_reason"].as_str() == Some("length")
    };
    if truncated {
        return Err(AppError::from(
            "AI response was truncated by the provider's output limit. Try a shorter request; nothing was inserted.",
        ));
    }
    let text = if anthropic {
        value["content"].as_array().and_then(|parts| {
            let text = parts.iter()
                .filter(|part| part["type"].as_str().is_none_or(|kind| kind == "text"))
                .filter_map(|part| part["text"].as_str())
                .collect::<String>();
            (!text.is_empty()).then_some(text)
        })
    } else {
        let content = &value["choices"][0]["message"]["content"];
        content.as_str().map(str::to_owned).or_else(|| {
            content.as_array().and_then(|parts| {
                let text = parts.iter()
                    .filter(|part| part["type"].as_str().is_none_or(|kind| kind == "text"))
                    .filter_map(|part| part["text"].as_str())
                    .collect::<String>();
                (!text.is_empty()).then_some(text)
            })
        })
    };
    text.filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::from("AI endpoint returned an empty completion."))
}

async fn complete_with_key(
    provider: &str,
    base_url: &str,
    model: &str,
    system: Option<&str>,
    prompt: &str,
    key: Option<&str>,
    timeout: Duration,
    mut cancelled: oneshot::Receiver<()>,
) -> Result<String, AppError> {
    let (anthropic, url, body) = request_parts(provider, base_url, model, system, prompt)?;
    let client = reqwest::Client::builder().timeout(timeout).build()
        .map_err(|e| AppError::from(format!("could not build HTTP client: {e}")))?;
    let mut request = client.post(&url).json(&body);
    if anthropic {
        let key = key.filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::from("No AI API key is set — add one in Settings → AI."))?;
        request = request.header("x-api-key", key).header("anthropic-version", "2023-06-01");
    } else if let Some(key) = key.filter(|s| !s.is_empty()) {
        request = request.header("authorization", format!("Bearer {key}"));
    }

    let work = async {
        let response = request.send().await.map_err(|e| {
            if e.is_timeout() {
                AppError::from(format!("AI request timed out after {} seconds.", timeout.as_secs()))
            } else {
                AppError::from(format!("AI request failed: {e}"))
            }
        })?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            let snippet: String = text.chars().take(400).collect();
            return Err(AppError::from(format!("AI endpoint returned {status}: {snippet}")));
        }
        let value: Value = response.json().await
            .map_err(|e| AppError::from(format!("AI response was not JSON: {e}")))?;
        let text = completion_text(anthropic, &value)?;
        Ok(text)
    };
    tokio::select! {
        _ = &mut cancelled => Err(AppError::cancelled()),
        result = work => result,
    }
}

#[tauri::command]
pub async fn ai_complete(
    request_id: String,
    provider: String,
    base_url: String,
    model: String,
    system: Option<String>,
    prompt: String,
    state: State<'_, AppState>,
) -> Result<String, AppError> {
    if request_id.trim().is_empty() {
        return Err(AppError::from("AI request id is missing."));
    }
    let key = crate::secretstore::get(&state.data_dir, AI_KEY);
    let (tx, rx) = oneshot::channel();
    {
        let mut active = cancels().lock().await;
        if active.contains_key(&request_id) {
            return Err(AppError::from("That AI request is already running."));
        }
        active.insert(request_id.clone(), tx);
    }
    let result = complete_with_key(
        &provider, &base_url, &model, system.as_deref(), &prompt,
        key.as_deref(), REQUEST_TIMEOUT, rx,
    ).await;
    cancels().lock().await.remove(&request_id);
    result
}

#[tauri::command]
pub async fn ai_cancel(request_id: String) -> Result<bool, AppError> {
    let sender = cancels().lock().await.remove(&request_id);
    Ok(sender.is_some_and(|tx| tx.send(()).is_ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_request_has_the_messages_shape() {
        let (anthropic, url, body) = request_parts(
            "anthropic", "https://api.anthropic.com/", "model", Some("rules"), "request",
        ).unwrap();
        assert!(anthropic);
        assert_eq!(url, "https://api.anthropic.com/v1/messages");
        assert_eq!(body["system"], "rules");
        assert_eq!(body["messages"][0]["content"], "request");
        assert_eq!(body["max_tokens"], 2048);
    }

    #[test]
    fn openai_request_has_system_and_user_messages() {
        let (anthropic, url, body) = request_parts(
            "openai", "http://localhost:1234/v1", "kimi", Some("rules"), "request",
        ).unwrap();
        assert!(!anthropic);
        assert_eq!(url, "http://localhost:1234/v1/chat/completions");
        assert_eq!(body["model"], "kimi");
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["content"], "request");
    }

    #[test]
    fn response_parsers_accept_text_and_join_every_content_part() {
        let anthropic = json!({"content": [{"type": "thinking", "text": "ignore"},
            {"type": "text", "text": "SELECT "}, {"type": "text", "text": "1"}]});
        assert_eq!(completion_text(true, &anthropic).unwrap(), "SELECT 1");
        let openai = json!({"choices": [{"message": {"content": [
            {"type": "text", "text": "SELECT "}, {"type": "text", "text": "2"},
        ]}}]});
        assert_eq!(completion_text(false, &openai).unwrap(), "SELECT 2");
    }

    #[test]
    fn output_limit_truncation_is_an_error_not_a_completion() {
        let anthropic = json!({"stop_reason": "max_tokens", "content": [
            {"type": "text", "text": "SELECT * FROM"}]});
        assert!(completion_text(true, &anthropic).unwrap_err().to_string().contains("truncated"));
        let openai = json!({"choices": [{"finish_reason": "length",
            "message": {"content": "SELECT * FROM"}}]});
        assert!(completion_text(false, &openai).unwrap_err().to_string().contains("truncated"));
    }

    #[test]
    fn invalid_configuration_is_rejected_before_network_io() {
        assert!(request_parts("openai", "file:///tmp/x", "m", None, "p").is_err());
        assert!(request_parts("openai", "http://localhost", "", None, "p").is_err());
        assert!(request_parts("other", "http://localhost", "m", None, "p").is_err());
    }

    async fn stalled_server() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        format!("http://{address}/v1")
    }

    #[tokio::test]
    async fn cancellation_stops_the_http_request() {
        let base = stalled_server().await;
        let (tx, rx) = oneshot::channel();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let _ = tx.send(());
        });
        let error = complete_with_key(
            "openai", &base, "m", None, "p", None, Duration::from_secs(5), rx,
        ).await.unwrap_err();
        assert!(error.to_string().contains("cancelled"), "{error}");
    }

    #[tokio::test]
    async fn timeout_is_a_clear_error() {
        let base = stalled_server().await;
        let (_tx, rx) = oneshot::channel();
        let error = complete_with_key(
            "openai", &base, "m", None, "p", None, Duration::from_millis(20), rx,
        ).await.unwrap_err();
        assert!(error.to_string().contains("timed out"), "{error}");
    }
}
