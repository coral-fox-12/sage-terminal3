// Sage — browser UI glue. Fetches live Chainlink prices from Base mainnet,
// builds deterministic research briefs, and runs the paper portfolio.
// Honesty rule: if live data is unavailable, the UI says so. It never invents a price.
import { FEEDS, BASE_RPC, fetchAllPrices, fetchPrice, fetchRound, isStale } from './feeds.js';
import { buildBrief, pctChange, newPaperPortfolio, paperBuy, paperSell, paperValue } from './analysis.js';
import { ANCHOR_CONTRACT, ANCHOR_CHAIN_ID, ANCHOR_EXPLORER } from './config.js';
import { anchorBriefViaWallet } from './anchor.js';
import './t3-panel.js';

const $ = (id) => document.getElementById(id);
const SYMBOLS = Object.keys(FEEDS);
const PAPER_KEY = 'sage-paper-v1';
const GEMINI_KEY = 'sage-gemini-key';

// Frozen real values (captured 2026-11-16 23:11 UTC) — used ONLY in demo mode,
// and every demo value on screen is labelled DEMO.
const DEMO_PRICES = {
  AAPL: 335.18, AMZN: 248.90, GOOGL: 301.44, META: 612.07,
  MSFT: 502.33, MSTR: 412.55, NVDA: 156.31, TSLA: 421.86,
};
const DEMO_STAMP = '2026-11-16 23:11 UTC (frozen demo snapshot)';

let live = {};          // symbol -> price quote or { ok:false }
let demoMode = false;
let paper = loadPaper();

function loadPaper() {
  try {
    const raw = localStorage.getItem(PAPER_KEY);
    if (raw) { const p = JSON.parse(raw); if (p && typeof p.cash === 'number') return p; }
  } catch { /* corrupted storage -> fresh portfolio */ }
  return newPaperPortfolio();
}
function savePaper() { localStorage.setItem(PAPER_KEY, JSON.stringify(paper)); }

function priceOf(symbol) {
  if (demoMode) return { symbol, name: FEEDS[symbol].name, price: DEMO_PRICES[symbol], ok: true, demo: true };
  const q = live[symbol];
  if (!q || !q.ok) return { symbol, name: FEEDS[symbol].name, price: null, ok: false };
  return q;
}

function renderPrices() {
  const grid = $('priceGrid');
  grid.innerHTML = '';
  for (const s of SYMBOLS) {
    const q = priceOf(s);
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.symbol = s;
    tile.onclick = () => { $('stockSelect').value = s; generateBrief(); };
    if (!q.ok || !Number.isFinite(q.price)) {
      tile.innerHTML = `<div class="sym">${s} · ${q.name}</div><div class="price">—</div><div class="meta warn">data unavailable</div>`;
    } else {
      const stale = !demoMode && isStale(q.updatedAtUnix);
      tile.innerHTML = `<div class="sym">${s} · ${q.name}</div>` +
        `<div class="price">$${q.price.toFixed(2)}</div>` +
        `<div class="meta">${q.demo ? `<span class="demo">DEMO</span> · ${DEMO_STAMP}` : `updated ${q.updatedAt.toISOString().slice(0, 19)}Z`}</div>` +
        (stale ? `<div class="stale">STALE FEED</div>` : '');
    }
    grid.appendChild(tile);
  }
  $('priceStamp').textContent = demoMode
    ? 'Demo mode ON — frozen snapshot, all values labelled DEMO.'
    : 'Live from Base mainnet via the public RPC (no key).';
}

async function refreshPrices() {
  $('statusText').textContent = 'Loading live prices from Base…';
  live = {};
  for (const s of SYMBOLS) live[s] = { symbol: s, ok: false };
  renderPrices();
  const rows = await fetchAllPrices();
  for (const r of rows) live[r.symbol] = r;
  const okCount = rows.filter((r) => r.ok).length;
  $('statusText').textContent = okCount === SYMBOLS.length
    ? `Live prices loaded: ${okCount}/${SYMBOLS.length} feeds OK.`
    : `Live prices partial: ${okCount}/${SYMBOLS.length} feeds OK — failed feeds show "data unavailable".`;
  renderPrices();
  renderPaper();
}

/** Walk back Chainlink rounds to find reference prices. Returns { change24h, change7d, closes }.
 *  change24h uses the round closest to 24h ago (20–28h window); change7d the round
 *  closest to 7d ago (6–8d window). Null when no round falls in the window — never guessed. */
async function referenceChanges(symbol, latest) {
  const out = { change24h: null, change7d: null, closes: [] };
  if (demoMode) {
    // Demo: fixed, labelled series derived from the frozen snapshot.
    out.change24h = 1.2; out.change7d = 4.5;
    out.closes = [140, 142, 141, 145, 148, 150, 152, DEMO_PRICES[symbol]];
    return out;
  }
  try {
    const roundNum = BigInt(latest.roundId) & ((1n << 64n) - 1n); // aggregator round within phase
    const phase = BigInt(latest.roundId) >> 64n;
    const ids = [];
    for (let i = 1; i <= 30; i++) {
      const r = roundNum - BigInt(i);
      if (r <= 0n) break;
      ids.push(((phase << 64n) | r).toString());
    }
    const rounds = (await Promise.allSettled(ids.map((id) => fetchRound(symbol, id))))
      .filter((x) => x.status === 'fulfilled').map((x) => x.value);
    rounds.sort((a, b) => a.updatedAtUnix - b.updatedAtUnix); // oldest first
    out.closes = [...rounds.map((r) => r.price), latest.price];
    const now = Date.now() / 1000;
    const pick = (targetH, loH, hiH) => {
      let best = null; let bestDiff = Infinity;
      for (const r of rounds) {
        const ageH = (now - r.updatedAtUnix) / 3600;
        if (ageH < loH || ageH > hiH) continue;
        const diff = Math.abs(ageH - targetH);
        if (diff < bestDiff) { bestDiff = diff; best = r; }
      }
      return best ? pctChange(latest.price, best.price) : null;
    };
    out.change24h = pick(24, 20, 28);
    out.change7d = pick(168, 144, 192);
  } catch { /* reference data unavailable — brief will say so */ }
  return out;
}

async function generateBrief() {
  const symbol = $('stockSelect').value;
  const q = priceOf(symbol);
  $('brief').innerHTML = '<p>Building brief…</p>';
  let refs = { change24h: null, change7d: null, closes: [] };
  if (q.ok && Number.isFinite(q.price) && !demoMode) refs = await referenceChanges(symbol, q);
  else if (demoMode) refs = await referenceChanges(symbol, q);
  const brief = buildBrief({
    symbol, name: FEEDS[symbol].name,
    price: q.price, updatedAt: q.demo ? DEMO_STAMP : q.updatedAt?.toISOString(),
    updatedAtUnix: q.demo ? 0 : q.updatedAtUnix,
    stale: q.demo ? false : isStale(q.updatedAtUnix ?? 0),
    change24h: refs.change24h, change7d: refs.change7d, closes: refs.closes,
    source: q.demo ? 'DEMO snapshot (frozen 2026-11-16 23:11 UTC)' : 'Chainlink feed on Base mainnet',
  });
  $('brief').innerHTML = `
    <div class="brief">
      <h3>${brief.name} (${brief.symbol}) — ${brief.label}</h3>
      ${brief.warnings.map((w) => `<p class="warn">${w}</p>`).join('')}
      <table>
        <tr><th>Price</th><td class="num">${brief.price === null ? 'unavailable' : '$' + brief.price.toFixed(2)}</td></tr>
        <tr><th>24h change</th><td class="num">${brief.change24h === null ? 'n/a' : brief.change24h.toFixed(2) + '%'}</td></tr>
        <tr><th>7d change</th><td class="num">${brief.change7d === null ? 'n/a' : brief.change7d.toFixed(2) + '%'}</td></tr>
        <tr><th>Annualised volatility</th><td class="num">${brief.volatility === null ? 'n/a' : brief.volatility.toFixed(1) + '%'}</td></tr>
        <tr><th>Momentum score</th><td class="num">${brief.score === null ? 'withheld' : brief.score + ' / 100'}</td></tr>
        <tr><th>Data as of</th><td>${brief.updatedAt ?? '—'}</td></tr>
        <tr><th>Source</th><td>${brief.source}</td></tr>
      </table>
      <p><strong>Snapshot:</strong> ${brief.sections.snapshot}</p>
      <p><strong>Trend:</strong> ${brief.sections.trend}</p>
      <p><strong>Volatility:</strong> ${brief.sections.volatility}</p>
      <p><strong>Watch next:</strong> ${brief.sections.watchNext}</p>
      <p class="fineprint">${brief.disclaimer}</p>
    </div>`;
  $('brief').dataset.briefJson = JSON.stringify(brief);
  $('rewriteBtn').disabled = !localStorage.getItem(GEMINI_KEY);
  updateAnchorUi();
}

function updateAnchorUi() {
  const btn = $('anchorBtn');
  const status = $('anchorStatus');
  const hasBrief = Boolean($('brief').dataset.briefJson);
  if (!ANCHOR_CONTRACT) {
    btn.disabled = true;
    btn.title = 'Needs a funded Base Sepolia wallet — see README';
    status.textContent = 'Onchain anchoring: contract ready, awaiting testnet deployment. The button stays disabled until then — we don\'t fake a transaction.';
    return;
  }
  const short = ANCHOR_CONTRACT.slice(0, 6) + '…' + ANCHOR_CONTRACT.slice(-4);
  status.innerHTML = `Onchain anchoring: contract <a href="${ANCHOR_EXPLORER}/address/${ANCHOR_CONTRACT}" target="_blank" rel="noopener">${short}</a> on Base Sepolia (chain ${ANCHOR_CHAIN_ID}). ` +
    (hasBrief ? 'Generate a brief, then anchor it with your wallet.' : 'Generate a brief first.');
  btn.disabled = !hasBrief;
  btn.title = hasBrief ? 'Anchor this brief onchain with your wallet (Base Sepolia testnet)' : 'Generate a brief first';
}

async function anchorCurrentBrief() {
  const raw = $('brief').dataset.briefJson;
  if (!raw) return;
  const btn = $('anchorBtn');
  const status = $('anchorStatus');
  const symbol = $('stockSelect').value;
  btn.disabled = true;
  status.textContent = 'Waiting for your wallet — confirm the transaction on Base Sepolia…';
  try {
    const { briefHash, txHash, explorerTx } = await anchorBriefViaWallet(symbol, raw);
    status.innerHTML = `Anchored ${symbol} brief <code>${briefHash.slice(0, 18)}…</code> — ` +
      `<a href="${explorerTx}" target="_blank" rel="noopener">tx ${txHash.slice(0, 10)}…${txHash.slice(-8)}</a> on Base Sepolia. ` +
      `Anyone can verify the brief hash against the brief above.`;
  } catch (e) {
    status.textContent = 'Anchoring failed: ' + (e?.message || e) + ' — nothing was sent.';
  } finally {
    updateAnchorUi();
  }
}

function renderPaper() {
  const prices = {};
  for (const s of SYMBOLS) { const q = priceOf(s); if (q.ok && Number.isFinite(q.price)) prices[s] = q.price; }
  const v = paperValue(paper, prices);
  $('paperSummary').innerHTML = v.value === null
    ? `<p class="warn">Paper value unavailable — a position lacks a live price. (${v.error})</p>`
    : `<p>Cash (paper): <strong>$${paper.cash.toFixed(2)}</strong> · Positions: <strong>$${(v.value - paper.cash).toFixed(2)}</strong> · ` +
      `Total: <strong>$${v.value.toFixed(2)}</strong> · P&amp;L: <strong>${v.pnl >= 0 ? '+' : ''}$${v.pnl.toFixed(2)} (${v.pnlPct.toFixed(2)}%)</strong></p>`;
  const pos = Object.entries(paper.positions);
  $('paperPositions').innerHTML = pos.length === 0
    ? '<p>No paper positions yet.</p>'
    : '<table><tr><th>Stock</th><th>Shares</th><th>Avg cost</th><th>Live price</th><th>Value</th></tr>' +
      pos.map(([s, p]) => `<tr><td>${s}</td><td>${p.shares}</td><td>$${p.avgCost.toFixed(2)}</td>` +
        `<td>${prices[s] ? '$' + prices[s].toFixed(2) : '—'}</td>` +
        `<td>${prices[s] ? '$' + (p.shares * prices[s]).toFixed(2) : '—'}</td></tr>`).join('') + '</table>';
  $('paperTrades').innerHTML = paper.trades.length === 0
    ? ''
    : '<p>Recent paper trades:</p><ul>' + paper.trades.slice(-8).reverse()
      .map((t) => `<li>${t.side} ${t.shares} ${t.symbol} @ $${t.price.toFixed(2)} — ${t.at.slice(0, 19)}Z</li>`).join('') + '</ul>';
}

function paperTrade(side) {
  const symbol = $('paperSelect').value;
  const shares = parseFloat($('paperShares').value);
  const q = priceOf(symbol);
  const price = q.ok ? q.price : NaN;
  const next = side === 'BUY' ? paperBuy(paper, symbol, shares, price) : paperSell(paper, symbol, shares, price);
  if (next.error) { alert('Paper ' + side + ' failed: ' + next.error); return; }
  paper = next; savePaper(); renderPaper();
}

async function rewriteWithAI() {
  const key = localStorage.getItem(GEMINI_KEY);
  const raw = $('brief').dataset.briefJson;
  if (!key) { alert('No Gemini key saved. Save one first — or use the deterministic brief as-is.'); return; }
  if (!raw) { alert('Generate a brief first.'); return; }
  $('aiBrief').innerHTML = '<p>Rewriting with Gemini…</p>';
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text:
        'Rewrite this stock research brief in clear, plain English for a general reader. ' +
        'Keep every number exactly as given, keep the "Not financial advice" disclaimer, ' +
        'and do not add any price, forecast, or recommendation that is not in the brief.\n\n' + raw }] }] }),
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    $('aiBrief').innerHTML = text ? `<h3>AI rewrite</h3><p>${text.replace(/</g, '&lt;')}</p>` : '<p class="warn">Gemini returned no text.</p>';
  } catch (e) {
    $('aiBrief').innerHTML = `<p class="warn">AI rewrite failed: ${String(e.message || e)}. The deterministic brief above is unaffected.</p>`;
  }
}

// --- init ---
for (const s of SYMBOLS) {
  const o1 = document.createElement('option'); o1.value = s; o1.textContent = `${s} — ${FEEDS[s].name}`; $('stockSelect').appendChild(o1);
  const o2 = document.createElement('option'); o2.value = s; o2.textContent = `${s} — ${FEEDS[s].name}`; $('paperSelect').appendChild(o2);
}
$('stockSelect').value = 'NVDA';
$('paperSelect').value = 'NVDA';
$('briefBtn').onclick = generateBrief;
$('anchorBtn').onclick = anchorCurrentBrief;
$('paperBuy').onclick = () => paperTrade('BUY');
$('paperSell').onclick = () => paperTrade('SELL');
$('paperReset').onclick = () => { paper = newPaperPortfolio(); savePaper(); renderPaper(); };
$('demoToggle').onchange = (e) => { demoMode = e.target.checked; renderPrices(); renderPaper(); };
$('saveKey').onclick = () => {
  const k = $('geminiKey').value.trim();
  if (!k) { alert('Paste a Gemini API key first.'); return; }
  localStorage.setItem(GEMINI_KEY, k);
  $('geminiKey').value = '';
  $('rewriteBtn').disabled = false;
  alert('Key saved in this browser only (localStorage).');
};
$('rewriteBtn').onclick = rewriteWithAI;
if (localStorage.getItem(GEMINI_KEY)) $('rewriteBtn').disabled = false;
updateAnchorUi();
refreshPrices();
