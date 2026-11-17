//! `private-rewrite`: rewrite a sealed brief with Gemini, inside the enclave.
//!
//! The Gemini API key is read from the tenant-private `secrets` KV map
//! (key `gemini_api_key`) and used only as an HTTP header inside the enclave.
//! It is never returned, never logged, and never appears in an error string.
//! Only the rewritten text (plus token counts) crosses the boundary back.
//!
//! Outbound HTTP is authorized by the calling user (data owner), not the
//! contract: the user must grant this contract's `private-rewrite` function
//! egress to `generativelanguage.googleapis.com` first (see `t3/cli.mjs`
//! `grant`). Without the grant the host refuses with
//! `host/http.egress_denied`.

use serde::{Deserialize, Serialize};

/// Maximum Gemini response we will parse (128 KiB). A rewrite is a few
/// hundred words; anything bigger is a runaway response, not a rewrite.
pub const MAX_GEMINI_RESPONSE_BYTES: usize = 131_072;

pub const DEFAULT_MODEL: &str = "gemini-2.5-flash";

pub const DEFAULT_INSTRUCTION: &str = "Rewrite this research brief in clear natural language for a reader who is not a trader. Keep every number, price, date and verdict exactly as stated — do not invent, change or add any figure. Keep it under 250 words.";

pub const GEMINI_HOST: &str = "generativelanguage.googleapis.com";

#[derive(Deserialize)]
pub struct RewriteReq {
    pub key: alloc::string::String,
    #[serde(default)]
    pub instruction: Option<alloc::string::String>,
    #[serde(default)]
    pub model: Option<alloc::string::String>,
}

#[derive(Serialize)]
pub struct RewriteResp {
    pub key: alloc::string::String,
    pub model: alloc::string::String,
    pub text: alloc::string::String,
    pub prompt_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub total_tokens: Option<u32>,
}

fn valid_key(key: &str) -> bool {
    key.len() == 64 && key.chars().all(|c| c.is_ascii_hexdigit())
}

/// Parse + validate the rewrite request. Pure and natively testable.
pub fn parse_rewrite_input(input: &[u8]) -> Result<RewriteReq, alloc::string::String> {
    let req: RewriteReq = serde_json::from_slice(input)
        .map_err(|e| alloc::format!("private-rewrite: bad input: {e}"))?;
    if !valid_key(&req.key) {
        return Err(
            "private-rewrite: `key` must be the 64-hex SHA-256 from seal-brief".to_string(),
        );
    }
    if let Some(model) = &req.model {
        if model.is_empty() || model.len() > 64 || model.contains(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')) {
            return Err("private-rewrite: invalid `model`".to_string());
        }
    }
    if let Some(instruction) = &req.instruction {
        if instruction.len() > 4_096 {
            return Err("private-rewrite: `instruction` too long (max 4096 chars)".to_string());
        }
    }
    Ok(req)
}

/// Build the Gemini `generateContent` request. Pure and natively testable.
/// Returns `(url, headers, body_bytes)`. The API key travels only as the
/// `x-goog-api-key` header — never in the URL, never in the body.
pub fn build_gemini_request(
    model: &str,
    api_key: &str,
    instruction: &str,
    brief_json: &str,
) -> (alloc::string::String, Vec<(alloc::string::String, alloc::string::String)>, Vec<u8>) {
    let url = alloc::format!(
        "https://{GEMINI_HOST}/v1beta/models/{model}:generateContent"
    );
    let headers = alloc::vec![(
        "x-goog-api-key".to_string(),
        api_key.to_string(),
    )];
    let prompt = alloc::format!(
        "{instruction}\n\n--- SEALED BRIEF (JSON) ---\n{brief_json}"
    );
    let body = serde_json::json!({
        "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
        "generationConfig": { "temperature": 0.3, "maxOutputTokens": 1024 },
    });
    let body_bytes = serde_json::to_vec(&body).unwrap_or_default();
    (url, headers, body_bytes)
}

/// Parse a Gemini `generateContent` response into the rewrite result.
/// Pure and natively testable.
pub fn parse_gemini_response(
    key: &str,
    model: &str,
    bytes: &[u8],
) -> Result<RewriteResp, alloc::string::String> {
    let v: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|e| alloc::format!("private-rewrite: bad Gemini response JSON: {e}"))?;
    let text = v
        .get("candidates")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .filter(|t| !t.trim().is_empty())
        .ok_or("private-rewrite: Gemini response has no candidate text")?;
    let usage = v.get("usageMetadata");
    Ok(RewriteResp {
        key: key.to_string(),
        model: model.to_string(),
        text,
        prompt_tokens: usage
            .and_then(|u| u.get("promptTokenCount"))
            .and_then(|n| n.as_u64())
            .map(|n| n as u32),
        output_tokens: usage
            .and_then(|u| u.get("candidatesTokenCount"))
            .and_then(|n| n.as_u64())
            .map(|n| n as u32),
        total_tokens: usage
            .and_then(|u| u.get("totalTokenCount"))
            .and_then(|n| n.as_u64())
            .map(|n| n as u32),
    })
}

/// Entry point called from `lib.rs`. `input` is the raw JSON bytes from the
/// node's `generic-input.input` field:
/// `{ "key": "<64-hex>", "instruction": "...", "model": "gemini-2.5-flash" }`.
pub fn private_rewrite(input: &[u8]) -> Result<Vec<u8>, alloc::string::String> {
    let req = parse_rewrite_input(input)?;
    let model = req.model.clone().unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let instruction = req
        .instruction
        .clone()
        .unwrap_or_else(|| DEFAULT_INSTRUCTION.to_string());

    #[cfg(target_arch = "wasm32")]
    {
        use crate::host::{
            interfaces::{http as http_iface, kv_store, logging},
            tenant::tenant_context,
        };

        let tid_hex = hex::encode(tenant_context::tenant_did());
        let briefs_map = alloc::format!("z:{tid_hex}:briefs");
        let secrets_map = alloc::format!("z:{tid_hex}:secrets");

        // 1. Read the sealed brief (inside the enclave only).
        let brief_bytes = kv_store::get(&briefs_map, req.key.as_bytes())
            .map_err(|e| alloc::format!("private-rewrite: kv read failed: {e}"))?
            .ok_or_else(|| {
                alloc::format!("private-rewrite: no sealed brief for key {}", req.key)
            })?;
        let brief_json = alloc::string::String::from_utf8(brief_bytes)
            .map_err(|_| "private-rewrite: sealed brief is not valid UTF-8".to_string())?;

        // 2. Read the Gemini key from the secrets map (inside the enclave only).
        //    The key value is never logged, never returned, never in errors.
        let api_key_bytes = kv_store::get(&secrets_map, b"gemini_api_key")
            .map_err(|e| alloc::format!("private-rewrite: kv read failed: {e}"))?
            .ok_or(
                "private-rewrite: gemini_api_key not found in z:<tid>:secrets — run `t3/cli.mjs seed-gemini` first"
                    .to_string(),
            )?;
        let api_key = alloc::string::String::from_utf8(api_key_bytes)
            .map_err(|_| "private-rewrite: gemini_api_key is not valid UTF-8".to_string())?;
        if api_key.trim().is_empty() {
            return Err("private-rewrite: gemini_api_key is empty".to_string());
        }

        // 3. Call Gemini from inside the enclave.
        let (url, headers, body) =
            build_gemini_request(&model, api_key.trim(), &instruction, &brief_json);
        let resp = http_iface::call(&http_iface::Request {
            method: http_iface::Verb::Post,
            url,
            headers: Some(headers),
            payload: Some(body),
        })
        .map_err(|e| alloc::format!("private-rewrite: Gemini call failed: {e}"))?;

        if resp.code != 200 {
            let body = alloc::string::String::from_utf8_lossy(&resp.payload);
            let snippet: alloc::string::String = body.chars().take(200).collect();
            return Err(alloc::format!(
                "private-rewrite: Gemini HTTP {} — {snippet}",
                resp.code
            ));
        }
        if resp.payload.len() > MAX_GEMINI_RESPONSE_BYTES {
            return Err(alloc::format!(
                "private-rewrite: Gemini response too large ({} bytes)",
                resp.payload.len()
            ));
        }

        let result = parse_gemini_response(&req.key, &model, &resp.payload)?;
        let _ = logging::info(&alloc::format!(
            "rewrote sealed brief key={} model={} prompt_tokens={:?} output_tokens={:?}",
            result.key, result.model, result.prompt_tokens, result.output_tokens
        ));

        serde_json::to_vec(&result).map_err(|e| e.to_string())
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (&model, &instruction);
        Err("private_rewrite is only implemented on the wasm32 target".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_rewrite_input_defaults() {
        let key = "a".repeat(64);
        let input = serde_json::to_vec(&json!({ "key": key })).unwrap();
        let req = parse_rewrite_input(&input).unwrap();
        assert_eq!(req.key, key);
        assert!(req.instruction.is_none());
        assert!(req.model.is_none());
    }

    #[test]
    fn parse_rewrite_input_rejects_bad_key() {
        let input = serde_json::to_vec(&json!({ "key": "not-a-hash" })).unwrap();
        assert!(parse_rewrite_input(&input).is_err());
    }

    #[test]
    fn build_gemini_request_keeps_key_out_of_url_and_body() {
        let (url, headers, body) =
            build_gemini_request("gemini-2.5-flash", "SECRET-KEY-123", "Do it.", "{\"a\":1}");
        assert!(url.contains("generativelanguage.googleapis.com"));
        assert!(url.contains("gemini-2.5-flash"));
        assert!(!url.contains("SECRET-KEY-123"));
        assert!(!alloc::string::String::from_utf8_lossy(&body).contains("SECRET-KEY-123"));
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].0, "x-goog-api-key");
        assert_eq!(headers[0].1, "SECRET-KEY-123");
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(v["contents"][0]["parts"][0]["text"]
            .as_str()
            .unwrap()
            .contains("{\"a\":1}"));
    }

    #[test]
    fn parse_gemini_response_extracts_text_and_usage() {
        let key = "b".repeat(64);
        let body = serde_json::to_vec(&json!({
            "candidates": [{ "content": { "parts": [{ "text": "Hello " }, { "text": "world" }] } }],
            "usageMetadata": { "promptTokenCount": 120, "candidatesTokenCount": 15, "totalTokenCount": 135 },
        }))
        .unwrap();
        let r = parse_gemini_response(&key, "gemini-2.5-flash", &body).unwrap();
        assert_eq!(r.text, "Hello world");
        assert_eq!(r.prompt_tokens, Some(120));
        assert_eq!(r.output_tokens, Some(15));
        assert_eq!(r.total_tokens, Some(135));
    }

    #[test]
    fn parse_gemini_response_rejects_empty_candidates() {
        let key = "b".repeat(64);
        let body = serde_json::to_vec(&json!({ "candidates": [] })).unwrap();
        assert!(parse_gemini_response(&key, "gemini-2.5-flash", &body).is_err());
    }

    #[test]
    fn private_rewrite_non_wasm_returns_err() {
        let key = "c".repeat(64);
        let input = serde_json::to_vec(&json!({ "key": key })).unwrap();
        let result = private_rewrite(&input);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("only implemented on the wasm32 target"));
    }
}
