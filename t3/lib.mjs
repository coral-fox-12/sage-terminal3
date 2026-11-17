// Shared helpers for the Sage Private Briefs T3 CLI.
//
// Everything here follows the Terminal 3 docs exactly:
//   - Auth: Quickstart — setEnvironment("testnet") -> loadWasmComponent ->
//     eth_get_address(T3N_API_KEY) -> T3nClient({ trustAnchor, wasmComponent,
//     handlers: { EthSign: metamask_sign(address, undefined, T3N_API_KEY) } })
//     -> handshake() -> authenticate(createEthAuthInput(address)).
//     The tenant DID is ALWAYS read back from the session — never hardcoded
//     or derived.
//   - Maps: Create Tenant KV Maps — visibility "private", readers/writers
//     scoped to the contract id ({ only: [contractId] }). The tenant can
//     still seed entries via the control plane (maps.entrySet).
//   - Register: tenant.contracts.register({ tail, version, wasm }).
//   - Invoke: tenant.contracts.execute(tail, { version, functionName, input }).
//   - Grant: T3nClient.updateMemberDelegation (self-grant for egress).
//
// Secrets policy: API keys are read from the environment only, never written
// to any file, never printed. CLI output shows at most a key's length.

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT_TAIL = "sage-private-brief";
export const CONTRACT_VERSION = "0.1.0";
export const SECRETS_MAP_TAIL = "secrets";
export const BRIEFS_MAP_TAIL = "briefs";
export const GEMINI_HOST = "generativelanguage.googleapis.com";
export const T3_ENV = "testnet";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WASM_PATH = join(REPO_ROOT, "contract", "target", "wasm32-wasip2", "release", "sage_private_brief.wasm");
export const STATE_PATH = join(REPO_ROOT, "t3", "state.json");
export const PROOF_PATH = join(REPO_ROOT, "t3", "proof", "trust-anchor.json");

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(path) {
  return sha256Hex(await readFile(path));
}

/** Hex SHA-256 of the contract source bundle (src/*.rs + wit/world.wit,
 *  concatenated in sorted path order with file names). Stored as the
 *  registration `source_hash` for source-to-bytecode attestation; it never
 *  gates execution. */
export async function sourceHash() {
  const files = ["src/lib.rs", "src/rewrite.rs", "src/seal.rs", "src/sha256.rs", "wit/world.wit"];
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(f).update("\0");
    hash.update(await readFile(join(REPO_ROOT, "contract", f)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Describe a secret without revealing any of it. */
export function describeSecret(value) {
  if (typeof value !== "string") return "<not a string>";
  return `<${value.length} chars>`;
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in the environment (never in a file): export ${name}=<value>`
    );
  }
  return value;
}

/** Tenant id (40 hex) from a `did:t3n:<40-hex>` DID. */
export function tenantIdFromDid(tenantDid) {
  if (!tenantDid.startsWith("did:t3n:")) {
    throw new Error(`Unexpected tenant DID shape: ${tenantDid.slice(0, 12)}…`);
  }
  return tenantDid.slice("did:t3n:".length);
}

export function contractName(tenantDid) {
  return `z:${tenantIdFromDid(tenantDid)}:${CONTRACT_TAIL}`;
}

/** Load the local deploy state (contract id, version, wasm hash). Returns
 *  null when setup has never run. The contract id is tenant metadata, not a
 *  secret — but it lives in state.json, not in the repo's tracked files. */
export async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

export async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/**
 * Full authenticated connection (Quickstart flow). Returns
 * `{ t3n, tenant, tenantDid, address }`.
 */
export async function connect() {
  const {
    T3nClient,
    TenantClient,
    setEnvironment,
    loadWasmComponent,
    resolveTrustAnchor,
    eth_get_address,
    metamask_sign,
    createEthAuthInput,
    getNodeUrl,
  } = await import("@terminal3/t3n-sdk");

  const apiKey = requireEnv("T3N_API_KEY");
  setEnvironment(T3_ENV);
  const wasmComponent = await loadWasmComponent();
  const address = eth_get_address(apiKey);
  const t3n = new T3nClient({
    trustAnchor: await resolveTrustAnchor(T3_ENV),
    wasmComponent,
    handlers: { EthSign: metamask_sign(address, undefined, apiKey) },
  });
  await t3n.handshake();
  const did = await t3n.authenticate(createEthAuthInput(address));
  const tenantDid = did.value;
  const tenant = new TenantClient({ t3n, baseUrl: getNodeUrl(), tenantDid });
  return { t3n, tenant, tenantDid, address };
}

/**
 * Decode a `tenant.contracts.execute` result. The node returns the
 * contract's JSON bytes; depending on transport this arrives as a string or
 * an already-parsed object. Never throws on an unknown shape — returns the
 * raw value so the caller can see what came back.
 */
export function decodeExecuteResult(result) {
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }
  return result;
}

/** Resolve the contract version to pass to `execute`: saved state first,
 *  then the node's registered current version. */
export async function resolveVersion(tenant, tenantDid) {
  const state = await loadState();
  if (state && state.version) return state.version;
  const { getContractVersion, getNodeUrl } = await import("@terminal3/t3n-sdk");
  const version = await getContractVersion(getNodeUrl(), contractName(tenantDid));
  if (typeof version === "string") return version;
  if (version && typeof version.version === "string") return version.version;
  throw new Error(
    "Could not resolve the registered contract version. Run `node t3/cli.mjs setup` first."
  );
}

/** The agent-facing descriptor published with setDescriptor (makes the
 *  contract dispatchable through the MCP funnel). Stored verbatim by the
 *  node; setup treats a rejection as a non-fatal warning. */
export function buildDescriptor() {
  return {
    summary:
      "Seal Sage research briefs into a tenant-private TEE KV map and rewrite them with Gemini inside the enclave — the API key and the full brief never touch the browser or CLI.",
    tags: ["sage", "privacy", "research", "terminal3"],
    functions: [
      {
        name: "seal-brief",
        summary: "Seal a Sage research brief into the private briefs KV map under its SHA-256 content address.",
        input: { symbol: "string", brief: "object" },
        output: { key: "string", symbol: "string", bytes: "number", map: "string", sealed_at_secs: "number" },
      },
      {
        name: "private-rewrite",
        summary: "Rewrite a sealed brief with Gemini inside the enclave; only the rewritten text returns.",
        input: { key: "string", instruction: "string (optional)", model: "string (optional)" },
        output: { key: "string", model: "string", text: "string", prompt_tokens: "number?", output_tokens: "number?", total_tokens: "number?" },
      },
    ],
  };
}
