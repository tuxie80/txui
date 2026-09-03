//! AI assistant — a small, provider-agnostic completion call.
//!
//! Configurable endpoint: either the Anthropic Messages API or any
//! OpenAI-compatible `/chat/completions` server. The non-secret config
//! (provider, base URL, model) travels from the frontend prefs on each call;
//! the API key lives only in the encrypted secret vault and is never exposed to
//! the frontend or logged. One-shot (non-streaming) — enough for NL→SQL,
//! explain and fix, and trivially verifiable.

use serde_json::{json, Value};
use tauri::State;

use crate::apperror::AppError;
use crate::state::AppState;

/// Vault key under which the AI API key is stored.
const AI_KEY: &str = "ai.apiKey";

/// Store (or clear, when empty) the AI API key in the encrypted vault.
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

/// Whether an AI key is set — so the UI can prompt for one without reading it.
#[tauri::command]
pub async fn ai_has_key(state: State<'_, AppState>) -> Result<bool, AppError> {
    Ok(crate::secretstore::get(&state.data_dir, AI_KEY).is_some_and(|s| !s.is_empty()))
}

/// Run one completion against the configured endpoint and return the text.
#[tauri::command]
pub async fn ai_complete(
    provider: String,
    base_url: String,
    model: String,
    system: Option<String>,
    prompt: String,
    state: State<'_, AppState>,
) -> Result<String, AppError> {
    let key = crate::secretstore::get(&state.data_dir, AI_KEY)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::from("No AI API key is set — add one in Settings → AI."))?;

    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(AppError::from("No AI endpoint URL is set — add one in Settings → AI."));
    }
    let anthropic = provider == "anthropic";

    let (url, body) = if anthropic {
        let mut b = json!({
            "model": model,
            "max_tokens": 2048,
            "messages": [{ "role": "user", "content": prompt }],
        });
        if let Some(s) = system.as_deref().filter(|s| !s.is_empty()) {
            b["system"] = json!(s);
        }
        (format!("{base}/v1/messages"), b)
    } else {
        let mut messages: Vec<Value> = Vec::new();
        if let Some(s) = system.as_deref().filter(|s| !s.is_empty()) {
            messages.push(json!({ "role": "system", "content": s }));
        }
        messages.push(json!({ "role": "user", "content": prompt }));
        (format!("{base}/chat/completions"), json!({ "model": model, "messages": messages }))
    };

    let client = reqwest::Client::builder().build()
        .map_err(|e| AppError::from(format!("could not build HTTP client: {e}")))?;
    let mut req = client.post(&url).json(&body);
    req = if anthropic {
        req.header("x-api-key", key).header("anthropic-version", "2023-06-01")
    } else {
        req.header("authorization", format!("Bearer {key}"))
    };

    let resp = req.send().await
        .map_err(|e| AppError::from(format!("AI request failed: {e}")))?;
    if !resp.status().is_success() {
        let code = resp.status();
        let text = resp.text().await.unwrap_or_default();
        // Trim provider error bodies so a giant HTML page doesn't fill the toast.
        let snippet: String = text.chars().take(400).collect();
        return Err(AppError::from(format!("AI endpoint returned {code}: {snippet}")));
    }
    let v: Value = resp.json().await
        .map_err(|e| AppError::from(format!("AI response was not JSON: {e}")))?;

    let text = if anthropic {
        v["content"].get(0).and_then(|c| c["text"].as_str()).unwrap_or("").to_string()
    } else {
        v["choices"].get(0).and_then(|c| c["message"]["content"].as_str()).unwrap_or("").to_string()
    };
    if text.is_empty() {
        return Err(AppError::from("AI endpoint returned an empty completion."));
    }
    Ok(text)
}
