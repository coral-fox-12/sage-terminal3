//! `seal-brief`: store a Sage research brief in the tenant-private `briefs`
//! KV map under its SHA-256 content address.
//!
//! The pure part (`build_seal`) is testable on native targets. The wasm glue
//! (`seal_brief`) does the KV write + claims-digest publication.

use serde::Serialize;

/// Maximum canonical brief size we will seal (64 KiB). Keeps one KV value
/// well inside host limits and keeps the Gemini rewrite prompt bounded.
pub const MAX_BRIEF_BYTES: usize = 65_536;

/// What the caller gets back from `seal-brief`. The brief itself never
/// crosses the boundary — only its content address and metadata.
#[derive(Serialize)]
pub struct SealReceipt {
    /// SHA-256 hex of the canonical brief JSON (the KV key + claims digest).
    pub key: alloc::string::String,
    pub symbol: alloc::string::String,
    /// Canonical brief size in bytes.
    pub bytes: usize,
    /// Canonical map name, e.g. `z:<40-hex-tid>:briefs`.
    pub map: alloc::string::String,
    /// Cluster timestamp (seconds) at seal time.
    pub sealed_at_secs: u64,
}

/// Canonical JSON for a brief: parsed into `serde_json::Value` and
/// re-serialized. `serde_json::Map` is a `BTreeMap` by default, so object
/// keys come out sorted — the same brief always canonicalizes to the same
/// bytes, and therefore to the same content address.
pub fn canonical_brief_json(brief: &serde_json::Value) -> Result<Vec<u8>, alloc::string::String> {
    if !brief.is_object() {
        return Err("seal-brief: `brief` must be a JSON object".to_string());
    }
    let bytes = serde_json::to_vec(brief).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BRIEF_BYTES {
        return Err(alloc::format!(
            "seal-brief: brief too large ({} bytes > {} max)",
            bytes.len(),
            MAX_BRIEF_BYTES
        ));
    }
    Ok(bytes)
}

fn valid_symbol(symbol: &str) -> bool {
    !symbol.is_empty()
        && symbol.len() <= 12
        && symbol
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

/// Pure seal: canonicalize + hash + build the receipt. Returns
/// `(receipt, canonical_brief_bytes, digest_bytes)`.
pub fn build_seal(
    symbol: &str,
    brief: &serde_json::Value,
    sealed_at_secs: u64,
    map: &str,
) -> Result<(SealReceipt, Vec<u8>, [u8; 32]), alloc::string::String> {
    if !valid_symbol(symbol) {
        return Err(
            "seal-brief: `symbol` must be 1-12 chars of A-Z, 0-9, '.' or '-'".to_string(),
        );
    }
    let canonical = canonical_brief_json(brief)?;
    let digest = crate::sha256::sha256(&canonical);
    let receipt = SealReceipt {
        key: hex::encode(digest),
        symbol: symbol.to_string(),
        bytes: canonical.len(),
        map: map.to_string(),
        sealed_at_secs,
    };
    Ok((receipt, canonical, digest))
}

/// Entry point called from `lib.rs`. `input` is the raw JSON bytes from the
/// node's `generic-input.input` field: `{ "symbol": "NVDA", "brief": {...} }`.
pub fn seal_brief(input: &[u8]) -> Result<Vec<u8>, alloc::string::String> {
    let req: serde_json::Value = serde_json::from_slice(input)
        .map_err(|e| alloc::format!("seal-brief: bad input: {e}"))?;
    let symbol = req
        .get("symbol")
        .and_then(|v| v.as_str())
        .ok_or("seal-brief: missing string `symbol`")?;
    let brief = req
        .get("brief")
        .ok_or("seal-brief: missing `brief` object")?;

    #[cfg(target_arch = "wasm32")]
    {
        use crate::host::{interfaces::{kv_store, logging}, tenant::tenant_context};

        let tid_hex = hex::encode(tenant_context::tenant_did());
        let map_name = alloc::format!("z:{tid_hex}:briefs");
        let sealed_at_secs = tenant_context::cluster_timestamp_secs();

        let (receipt, canonical, digest) = build_seal(symbol, brief, sealed_at_secs, &map_name)?;

        kv_store::put(&map_name, receipt.key.as_bytes(), &canonical)
            .map_err(|e| alloc::format!("seal-brief: kv put failed: {e}"))?;
        // Publish the seal hash as the transaction's claims digest so it lands
        // in the Merkle leaf and the seal is verifiable offline.
        kv_store::set_claims_digest(&digest)
            .map_err(|e| alloc::format!("seal-brief: set-claims-digest failed: {e}"))?;

        let _ = logging::info(&alloc::format!(
            "sealed brief {} ({} bytes) key={} map={}",
            receipt.symbol, receipt.bytes, receipt.key, receipt.map
        ));

        serde_json::to_vec(&receipt).map_err(|e| e.to_string())
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (symbol, brief);
        Err("seal_brief is only implemented on the wasm32 target".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_json_sorts_keys() {
        let a = json!({"b": 2, "a": 1});
        let b = json!({"a": 1, "b": 2});
        assert_eq!(canonical_brief_json(&a).unwrap(), canonical_brief_json(&b).unwrap());
        assert_eq!(canonical_brief_json(&a).unwrap(), b"{\"a\":1,\"b\":2}");
    }

    #[test]
    fn canonical_json_rejects_non_object() {
        assert!(canonical_brief_json(&json!([1, 2])).is_err());
        assert!(canonical_brief_json(&json!("x")).is_err());
    }

    #[test]
    fn build_seal_receipt_matches_sha256() {
        let brief = json!({"symbol": "NVDA", "score": 72});
        let (receipt, canonical, digest) =
            build_seal("NVDA", &brief, 1_800_000_000, "z:abc:briefs").unwrap();
        assert_eq!(receipt.key, hex::encode(digest));
        assert_eq!(receipt.key, hex::encode(crate::sha256::sha256(&canonical)));
        assert_eq!(receipt.bytes, canonical.len());
        assert_eq!(receipt.symbol, "NVDA");
        assert_eq!(receipt.map, "z:abc:briefs");
        assert_eq!(receipt.sealed_at_secs, 1_800_000_000);
    }

    #[test]
    fn build_seal_rejects_bad_symbol() {
        let brief = json!({"symbol": "NVDA"});
        assert!(build_seal("", &brief, 0, "z:abc:briefs").is_err());
        assert!(build_seal("nvda", &brief, 0, "z:abc:briefs").is_err());
        assert!(build_seal("TOOLONGSYMBOL1", &brief, 0, "z:abc:briefs").is_err());
    }

    #[test]
    fn seal_brief_non_wasm_returns_err() {
        let input = serde_json::to_vec(&json!({"symbol": "NVDA", "brief": {"a": 1}})).unwrap();
        let result = seal_brief(&input);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("only implemented on the wasm32 target"));
    }

    #[test]
    fn seal_brief_bad_input_returns_err() {
        assert!(seal_brief(b"not json").is_err());
        let missing = serde_json::to_vec(&json!({"symbol": "NVDA"})).unwrap();
        assert!(seal_brief(&missing).is_err());
    }
}
