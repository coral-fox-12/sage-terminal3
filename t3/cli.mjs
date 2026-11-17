// Sage Private Briefs — Terminal 3 CLI.
//
//   node t3/cli.mjs verify            # no key needed: verify the testnet trust anchor (live)
//   node t3/cli.mjs connect           # authenticate + show the tenant DID (needs T3N_API_KEY)
//   node t3/cli.mjs setup             # register contract + create private maps + descriptor
//   node t3/cli.mjs seed-gemini       # store the Gemini key in z:<tid>:secrets (needs T3_GEMINI_KEY)
//   node t3/cli.mjs seal-brief --file brief.json --symbol NVDA
//   node t3/cli.mjs private-rewrite --key <64-hex> [--instruction "..."] [--model gemini-2.5-flash]
//   node t3/cli.mjs grant             # self-grant: private-rewrite may reach generativelanguage.googleapis.com
//   node t3/cli.mjs status            # contract, maps, secrets presence
//   node t3/cli.mjs logs [--limit 20]
//
// Keys come from the environment only (T3N_API_KEY, T3_GEMINI_KEY) and are
// never written to a file or printed. `verify` is the only command that runs
// without a key.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  BRIEFS_MAP_TAIL,
  CONTRACT_TAIL,
  CONTRACT_VERSION,
  GEMINI_HOST,
  PROOF_PATH,
  SECRETS_MAP_TAIL,
  T3_ENV,
  WASM_PATH,
  buildDescriptor,
  connect,
  contractName,
  decodeExecuteResult,
  describeSecret,
  loadState,
  requireEnv,
  resolveVersion,
  saveState,
  sha256File,
  sourceHash,
  tenantIdFromDid,
} from "./lib.mjs";

const USAGE = `sage-terminal3 CLI — Terminal 3 integration for Sage Private Briefs

  node t3/cli.mjs verify            verify the testnet trust anchor (no key needed)
  node t3/cli.mjs connect           authenticate, print the tenant DID
  node t3/cli.mjs setup             register contract + create private maps + descriptor
  node t3/cli.mjs seed-gemini       store T3_GEMINI_KEY in z:<tid>:secrets
  node t3/cli.mjs seal-brief --file brief.json --symbol NVDA
  node t3/cli.mjs private-rewrite --key <64-hex> [--instruction "..."] [--model ...]
  node t3/cli.mjs grant             self-grant private-rewrite egress to ${GEMINI_HOST}
  node t3/cli.mjs status            contract, maps, secrets presence
  node t3/cli.mjs logs [--limit 20] contract debug logs (empty when log quota is off)
`;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- verify ---
// No API key needed. Proves the SDK talks to a genuine T3N enclave and
// writes the machine-readable proof artifact the demo page displays.
async function cmdVerify() {
  const { setEnvironment, loadWasmComponent, resolveTrustAnchor, getNodeUrl } =
    await import("@terminal3/t3n-sdk");
  const sdkPkg = JSON.parse(
    await readFile(new URL("../node_modules/@terminal3/t3n-sdk/package.json", import.meta.url), "utf8")
  );
  setEnvironment(T3_ENV);
  const t0 = Date.now();
  await loadWasmComponent();
  const wasmMs = Date.now() - t0;
  const anchor = await resolveTrustAnchor(T3_ENV);
  const proof = {
    verified_at: new Date().toISOString(),
    environment: T3_ENV,
    node_url: getNodeUrl(),
    sdk: `@terminal3/t3n-sdk ${sdkPkg.version}`,
    wasm_load_ms: wasmMs,
    trust_anchor: anchor,
  };
  await mkdir(dirname(PROOF_PATH), { recursive: true });
  await writeFile(PROOF_PATH, JSON.stringify(proof, null, 2) + "\n", "utf8");
  console.log(`trust anchor verified live in ${wasmMs} ms (WASM load)`);
  console.log(`node: ${proof.node_url}`);
  console.log(`proof written: t3/proof/trust-anchor.json`);
  console.log(JSON.stringify(anchor, null, 2).slice(0, 1200));
}

// --------------------------------------------------------------- connect ---
async function cmdConnect() {
  const { tenant, tenantDid, address } = await connect();
  console.log(`connected as: ${tenantDid}`);
  console.log(`eth address:  ${address}`);
  const me = await tenant.tenant.me();
  console.log("tenant.me():", JSON.stringify(me).slice(0, 500));
}

// ----------------------------------------------------------------- setup ---
// Register the contract (once — re-registering allocates a NEW contract id,
// so the id is persisted in t3/state.json), then create the two private maps
// scoped to that id. Idempotent: safe to re-run.
async function cmdSetup() {
  const wasm = await readFile(WASM_PATH).catch(() =>
    fail(`built contract not found at ${WASM_PATH} — run: cargo build --target wasm32-wasip2 --release (in contract/)`)
  );
  const wasmSha = await sha256File(WASM_PATH);
  const { tenant, tenantDid } = await connect();
  const name = contractName(tenantDid);
  console.log(`tenant: ${tenantDid}`);
  console.log(`contract: ${name} v${CONTRACT_VERSION} (wasm sha256 ${wasmSha.slice(0, 16)}…)`);

  let state = await loadState();
  let contractId = state?.contract_id ?? null;

  if (state && state.wasm_sha256 === wasmSha && state.version === CONTRACT_VERSION) {
    console.log(`already registered as contract id ${contractId} (same wasm) — skipping register`);
  } else {
    const hash = await sourceHash();
    let result;
    try {
      result = await tenant.contracts.register({
        tail: CONTRACT_TAIL,
        version: CONTRACT_VERSION,
        wasm,
        source_hash: hash,
      });
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (msg.includes("not higher than current version")) {
        fail(
          `version ${CONTRACT_VERSION} is not higher than the registered version. ` +
            `Bump CONTRACT_VERSION in t3/lib.mjs and contract/Cargo.toml, rebuild, and re-run setup.`
        );
      }
      throw e;
    }
    contractId = result.contract_id;
    state = { name, contract_id: contractId, version: CONTRACT_VERSION, wasm_sha256: wasmSha, source_hash: hash };
    await saveState(state);
    console.log(`registered ${result.name} as contract id ${contractId}`);
  }

  for (const tail of [SECRETS_MAP_TAIL, BRIEFS_MAP_TAIL]) {
    const status = await tenant.maps.getStatus(tail);
    if (status === "active") {
      console.log(`map ${tail}: already active`);
      continue;
    }
    if (status === "deleting") {
      fail(`map ${tail} is still deleting — wait for the host sweeper, then re-run setup`);
    }
    await tenant.maps.create({
      tail,
      visibility: "private",
      writers: { only: [contractId] },
      readers: { only: [contractId] },
    });
    console.log(`map ${tail}: created (private, readers/writers = contract ${contractId} only)`);
  }

  try {
    await tenant.contracts.setDescriptor({
      tail: CONTRACT_TAIL,
      version: CONTRACT_VERSION,
      descriptor: buildDescriptor(),
    });
    console.log("descriptor: published (contract is MCP-dispatchable)");
  } catch (e) {
    console.log(`descriptor: WARNING — not published (${e?.message ?? e}). The contract still works; this only affects MCP dispatch.`);
  }
  console.log("setup done. Next: seed-gemini, then grant, then seal-brief.");
}

// ------------------------------------------------------------ seed-gemini ---
async function cmdSeedGemini() {
  const key = requireEnv("T3_GEMINI_KEY");
  const { tenant, tenantDid } = await connect();
  await tenant.maps.entrySet(SECRETS_MAP_TAIL, "gemini_api_key", key);
  const back = await tenant.maps.entryGet(SECRETS_MAP_TAIL, "gemini_api_key");
  if (back !== key) fail("seed-gemini: read-back mismatch — the key was not stored correctly");
  console.log(`gemini_api_key stored in z:${tenantIdFromDid(tenantDid)}:${SECRETS_MAP_TAIL} (${describeSecret(key)}, verified by read-back)`);
  console.log("The key value is never printed. Only this contract can read it back at runtime.");
}

// ------------------------------------------------------------- seal-brief ---
async function cmdSealBrief() {
  const file = arg("--file");
  const symbol = arg("--symbol");
  if (!file) fail("seal-brief needs --file brief.json (a Sage brief, or {\"symbol\",\"brief\"})");
  if (!symbol) fail("seal-brief needs --symbol NVDA");
  const raw = JSON.parse(await readFile(file, "utf8"));
  const brief = raw.brief ?? raw;
  const { tenant, tenantDid } = await connect();
  const version = await resolveVersion(tenant, tenantDid);
  const result = decodeExecuteResult(
    await tenant.contracts.execute(CONTRACT_TAIL, {
      version,
      functionName: "seal-brief",
      input: { symbol, brief },
    })
  );
  console.log(JSON.stringify(result, null, 2));
}

// --------------------------------------------------------- private-rewrite ---
async function cmdPrivateRewrite() {
  const key = arg("--key");
  if (!key) fail("private-rewrite needs --key <64-hex SHA-256 from seal-brief>");
  const instruction = arg("--instruction");
  const model = arg("--model");
  const { tenant, tenantDid } = await connect();
  const version = await resolveVersion(tenant, tenantDid);
  const input = { key };
  if (instruction) input.instruction = instruction;
  if (model) input.model = model;
  const result = decodeExecuteResult(
    await tenant.contracts.execute(CONTRACT_TAIL, {
      version,
      functionName: "private-rewrite",
      input,
    })
  );
  if (result && typeof result === "object" && "text" in result) {
    console.log(`--- rewritten brief (${result.model ?? "gemini"}) ---`);
    console.log(result.text);
    console.log("---");
    console.log(`tokens: prompt=${result.prompt_tokens ?? "?"} output=${result.output_tokens ?? "?"} total=${result.total_tokens ?? "?"}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

// ------------------------------------------------------------------- grant ---
// Self-grant: the calling user authorizes this contract's `private-rewrite`
// to reach Gemini. Without it the host refuses the egress with
// `host/http.egress_denied`. Read-merge-write preserves all other grants.
async function cmdGrant() {
  const { t3n, tenantDid } = await connect();
  const name = contractName(tenantDid);
  const before = await t3n.getMemberDelegation();
  console.log(`existing grants: ${before.grants.length}`);
  const { preservedRows } = await t3n.updateMemberDelegation(
    {
      grantee: tenantDid,
      contract_id: name,
      function: "private-rewrite",
      scopes: [],
      allowed_hosts: [GEMINI_HOST],
    },
    { discoverDids: [tenantDid] }
  );
  console.log(`granted: ${tenantDid} -> ${name} (private-rewrite) -> ${GEMINI_HOST}`);
  console.log(`preserved existing grant rows: ${preservedRows.length}`);
}

// ------------------------------------------------------------------ status ---
async function cmdStatus() {
  const { tenant, tenantDid } = await connect();
  console.log(`tenant: ${tenantDid}`);
  console.log(`contract: ${contractName(tenantDid)}`);
  const state = await loadState();
  console.log(`local state: ${state ? `id ${state.contract_id}, v${state.version}, wasm ${String(state.wasm_sha256).slice(0, 16)}…` : "none — run setup"}`);
  try {
    const page = await tenant.contracts.listDetailed();
    const row = page.contracts.find((c) => c.short_name === CONTRACT_TAIL);
    console.log(`registered: ${row ? `${row.name}@${row.version} (${row.status})` : "NOT FOUND"}`);
  } catch (e) {
    console.log(`registered: unknown (${e?.message ?? e})`);
  }
  for (const tail of [SECRETS_MAP_TAIL, BRIEFS_MAP_TAIL]) {
    console.log(`map ${tail}: ${await tenant.maps.getStatus(tail)}`);
  }
  const key = await tenant.maps.entryGet(SECRETS_MAP_TAIL, "gemini_api_key");
  console.log(`gemini_api_key in secrets: ${key === null ? "ABSENT — run seed-gemini" : `present (${describeSecret(key)})`}`);
}

// -------------------------------------------------------------------- logs ---
async function cmdLogs() {
  const limit = Number(arg("--limit") ?? 20);
  const { tenant, tenantDid } = await connect();
  const out = await tenant.contracts.logs(CONTRACT_TAIL, { limit });
  if (!out.entries.length) {
    console.log("no log entries (contract logs are off unless the tenant log_max_entries quota is non-zero, or nothing has run yet).");
    return;
  }
  for (const e of out.entries) {
    console.log(`[${new Date(e.ts_ms).toISOString()}] ${e.level}: ${e.message}`);
  }
  if (out.truncated) console.log(`(truncated; next_seq=${out.next_seq})`);
}

const [cmd] = process.argv.slice(2);
try {
  switch (cmd) {
    case "verify": await cmdVerify(); break;
    case "connect": await cmdConnect(); break;
    case "setup": await cmdSetup(); break;
    case "seed-gemini": await cmdSeedGemini(); break;
    case "seal-brief": await cmdSealBrief(); break;
    case "private-rewrite": await cmdPrivateRewrite(); break;
    case "grant": await cmdGrant(); break;
    case "status": await cmdStatus(); break;
    case "logs": await cmdLogs(); break;
    default:
      console.log(USAGE);
      if (cmd) process.exit(1);
  }
} catch (e) {
  fail(e?.message ?? String(e));
}
