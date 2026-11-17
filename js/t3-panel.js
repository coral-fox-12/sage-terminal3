// Sage Private Briefs — Terminal 3 panel.
//
// What this panel does (and does NOT do):
//   - DOES: fetch the trust-anchor proof artifact (t3/proof/trust-anchor.json,
//     written by `node t3/cli.mjs verify`), show the live-verified status,
//     compute the current brief's canonical SHA-256 content address LOCALLY
//     (SubtleCrypto, no network), and generate the exact CLI commands +
//     brief file for sealing / rewriting through the TEE.
//   - does NOT: send the brief or any key anywhere. There is no network call
//     here except the proof fetch. No key is ever pasted into this page.
//
// Why no in-browser seal? The T3 SDK's WASM session needs a worker thread +
// SharedArrayBuffer, which requires COOP/COEP headers a static host cannot
// send. The CLI (`t3/cli.mjs`) is the verified path — this panel is the
// honest bridge to it, not a fake live demo.

const $ = (id) => document.getElementById(id);

// Canonical JSON: recursively sort object keys, like serde_json::Value
// re-serialization in the contract. The contract computes the authoritative
// key at seal time; this local hash is the expected content address.
function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(value[k])).join(",") + "}";
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function setStatus(msg, isError = false) {
  const el = $("t3Status");
  el.textContent = msg;
  el.className = isError ? "warn" : "";
}

async function loadProof() {
  const el = $("t3Proof");
  try {
    const res = await fetch("t3/proof/trust-anchor.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const proof = await res.json();
    el.innerHTML =
      `Trust anchor <strong>verified live</strong> ${proof.verified_at} · ` +
      `node <code>${proof.node_url}</code> · SDK <code>${proof.sdk}</code> · ` +
      `WASM loaded in ${proof.wasm_load_ms} ms. ` +
      `This is a real check of the T3 testnet enclave, run from the repo's CLI — not a badge.`;
  } catch (e) {
    el.innerHTML =
      `Trust-anchor proof not deployed yet (fetch failed: ${String(e.message || e)}). ` +
      `Run <code>node t3/cli.mjs verify</code> and re-deploy.`;
  }
}

function currentBrief() {
  const raw = $("brief")?.dataset?.briefJson;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function refreshBrief() {
  const brief = currentBrief();
  const info = $("t3BriefInfo");
  const keyEl = $("t3Key");
  if (!brief) {
    info.textContent = "No brief yet — generate a research brief above first.";
    keyEl.textContent = "—";
    $("t3DownloadBrief").disabled = true;
    $("t3CopySeal").disabled = true;
    return;
  }
  const canonical = canonicalStringify(brief);
  const key = await sha256Hex(canonical);
  const symbol = brief.symbol ?? "?";
  info.innerHTML =
    `Brief ready: <strong>${symbol}</strong> · ${canonical.length} bytes canonical JSON · ` +
    `content address (expected — the enclave computes the authoritative key at seal time):`;
  keyEl.textContent = key;
  $("t3DownloadBrief").disabled = false;
  $("t3CopySeal").disabled = false;
  $("t3DownloadBrief").onclick = () => {
    const file = { symbol, brief };
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sage-brief-${symbol}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus(`Downloaded sage-brief-${symbol}.json — seal it with the command below.`);
  };
  $("t3CopySeal").onclick = async () => {
    const cmd = `node t3/cli.mjs seal-brief --file sage-brief-${symbol}.json --symbol ${symbol}`;
    await copyText(cmd);
    setStatus("Seal command copied — run it in the repo (needs T3N_API_KEY).");
  };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

function initPanel() {
  if (!$("t3Panel")) return; // panel not on this page
  loadProof();
  refreshBrief();
  $("t3RefreshBrief").onclick = refreshBrief;
  $("t3CopyRewrite").onclick = async () => {
    const key = $("t3SealKey").value.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(key)) {
      setStatus("Paste the 64-hex seal key from `seal-brief` first.", true);
      return;
    }
    await copyText(`node t3/cli.mjs private-rewrite --key ${key.toLowerCase()}`);
    setStatus("Rewrite command copied — the rewritten text comes back from the CLI (the brief never leaves the enclave except to Gemini).");
  };
}

initPanel();
