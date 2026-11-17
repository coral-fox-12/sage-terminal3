//! sage-private-brief v0.1.0 — Sage Private Briefs on Terminal 3.
//!
//! Two functions, one privacy story:
//!   - `seal-brief`: a Sage research brief is stored ONLY in the tenant's
//!     private `z:<tid>:briefs` KV map under its SHA-256 content address.
//!     The digest is also published as the transaction's claims digest, so
//!     the seal lands in the Merkle leaf and is verifiable offline. Only the
//!     hash, symbol, byte length and cluster timestamp come back.
//!   - `private-rewrite`: the sealed brief is read back inside the enclave,
//!     rewritten by Gemini with an enclave-held API key (read from the
//!     `z:<tid>:secrets` map), and only the rewritten text returns. The key
//!     and the full brief never touch the browser or the CLI.
//!
//! The Gemini key is seeded by the tenant SDK before first use:
//! ```text
//! node t3/cli.mjs seed-gemini   # reads T3_GEMINI_KEY from the environment
//! ```
//!
//! # Host-capability requirements
//!
//! The tenant must be admitted with the `Http` host capability for
//! `private-rewrite` to reach Gemini, and the calling user must grant the
//! contract's `private-rewrite` function egress to
//! `generativelanguage.googleapis.com` (`node t3/cli.mjs grant`).
#![warn(clippy::style, missing_debug_implementations)]
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

extern crate alloc;

pub const CONTRACT_VERSION: &str = "0.1.0";

wit_bindgen::generate!({
    world: "sage-private-brief",
    path: "wit",
    additional_derives: [
        serde::Deserialize,
        serde::Serialize,
    ],
    generate_all,
});

mod rewrite;
mod seal;
mod sha256;

struct Component;

#[cfg(target_arch = "wasm32")]
impl exports::z::sage_private_brief::contracts::Guest for Component {
    fn seal_brief(
        req: exports::z::sage_private_brief::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("seal-brief: missing input")?;
        seal::seal_brief(&input)
    }

    fn private_rewrite(
        req: exports::z::sage_private_brief::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("private-rewrite: missing input")?;
        rewrite::private_rewrite(&input)
    }
}

#[cfg(target_arch = "wasm32")]
export!(Component);

#[cfg(test)]
mod tests {
    use super::CONTRACT_VERSION;

    #[test]
    fn contract_version_is_semver() {
        let parts: Vec<&str> = CONTRACT_VERSION.split('.').collect();
        assert_eq!(parts.len(), 3, "CONTRACT_VERSION must be MAJOR.MINOR.PATCH");
        for part in parts {
            assert!(part.parse::<u32>().is_ok(), "each part must be a number");
        }
    }

    #[test]
    fn contract_version_is_v0_1_0() {
        assert_eq!(CONTRACT_VERSION, "0.1.0");
    }
}
