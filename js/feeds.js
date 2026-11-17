// Sage — live price data from Chainlink feeds on Base mainnet.
// No API key, no account: reads the public Base RPC (https://mainnet.base.org).
// Prices are Total Return Values (underlying price x multiplier), 8 decimals,
// 24/5 market hours, 0.5% deviation / 24h heartbeat (per Base docs).
// Source: https://docs.base.org/build-on-base/integrate-defi/list-tokenized-stocks

export const BASE_RPC = 'https://mainnet.base.org';
export const BASE_CHAIN_ID = 8453; // 0x2105

// Chainlink V3 aggregator proxy addresses on Base (verified from Base docs, 2026-11-17).
export const FEEDS = {
  AAPL:  { symbol: 'AAPL',  name: 'Apple',     feed: '0x787f13dEa48Db0897CbCDD985de77809D837F988', token: '0xb200000000000000000000C2e324d24d7eEcd1fb' },
  AMZN:  { symbol: 'AMZN',  name: 'Amazon',    feed: '0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295', token: null },
  GOOGL: { symbol: 'GOOGL', name: 'Alphabet',  feed: '0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2', token: null },
  META:  { symbol: 'META',  name: 'Meta',      feed: '0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D', token: null },
  MSFT:  { symbol: 'MSFT',  name: 'Microsoft', feed: '0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c', token: null },
  MSTR:  { symbol: 'MSTR',  name: 'Strategy',  feed: '0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a', token: null },
  NVDA:  { symbol: 'NVDA',  name: 'NVIDIA',    feed: '0x04689a41629776563E6822F76f2e57D148d28513', token: null },
  TSLA:  { symbol: 'TSLA',  name: 'Tesla',     feed: '0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4', token: null },
};

// latestRoundData() selector (Chainlink AggregatorV3Interface).
export const LATEST_ROUND_DATA = '0xfeaf968c';
// getRoundData(uint80) selector.
export const GET_ROUND_DATA = '0x9a6fc8f5';

/** Decode a latestRoundData() eth_call result into a plain object.
 *  Returns { roundId, price, startedAt, updatedAt, answeredInRound }.
 *  price is a Number in USD (feed has 8 decimals). Throws on malformed data. */
export function decodeLatestRoundData(hex) {
  if (typeof hex !== 'string' || !hex.startsWith('0x') || hex.length < 2 + 64 * 5) {
    throw new Error('malformed latestRoundData response');
  }
  const word = (i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
  const roundId = BigInt('0x' + word(0));
  const answer = BigInt('0x' + word(1));
  // answer is int256; handle negative (should not happen for equity prices)
  const signed = answer >= 2n ** 255n ? answer - 2n ** 256n : answer;
  const startedAt = Number(BigInt('0x' + word(2)));
  const updatedAt = Number(BigInt('0x' + word(3)));
  const answeredInRound = BigInt('0x' + word(4));
  return {
    roundId: roundId.toString(),
    price: Number(signed) / 1e8,
    startedAt: new Date(startedAt * 1000),
    updatedAt: new Date(updatedAt * 1000),
    updatedAtUnix: updatedAt,
    answeredInRound: answeredInRound.toString(),
  };
}

/** Minimal JSON-RPC helper. `fetchImpl` defaults to global fetch (browser or Node 18+). */
export async function rpcCall(method, params, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(BASE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Base RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`Base RPC error: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

/** Fetch the latest price for one symbol. Returns { symbol, name, ...decoded }.
 *  Throws on any failure — callers must show "data unavailable", never invent a price. */
export async function fetchPrice(symbol, fetchImpl = globalThis.fetch) {
  const meta = FEEDS[symbol];
  if (!meta) throw new Error(`unknown symbol ${symbol}`);
  const raw = await rpcCall('eth_call', [{ to: meta.feed, data: LATEST_ROUND_DATA }, 'latest'], fetchImpl);
  return { symbol, name: meta.name, feed: meta.feed, token: meta.token, ...decodeLatestRoundData(raw) };
}

/** Fetch latest prices for all tracked symbols (parallel, one RPC call each). */
export async function fetchAllPrices(fetchImpl = globalThis.fetch) {
  const results = await Promise.allSettled(
    Object.keys(FEEDS).map((s) => fetchPrice(s, fetchImpl)),
  );
  return results.map((r, i) => {
    const symbol = Object.keys(FEEDS)[i];
    if (r.status === 'fulfilled') return { ...r.value, ok: true };
    return { symbol, name: FEEDS[symbol].name, ok: false, error: String(r.reason?.message || r.reason) };
  });
}

/** Fetch a historical round (roundId) for one symbol — used for 24h/7d change.
 *  getRoundData(uint80) takes the roundId left-padded to 32 bytes. */
export async function fetchRound(symbol, roundId, fetchImpl = globalThis.fetch) {
  const meta = FEEDS[symbol];
  if (!meta) throw new Error(`unknown symbol ${symbol}`);
  const idHex = BigInt(roundId).toString(16).padStart(64, '0');
  const raw = await rpcCall('eth_call', [{ to: meta.feed, data: GET_ROUND_DATA + idHex }, 'latest'], fetchImpl);
  return { symbol, ...decodeLatestRoundData(raw) };
}

/** Staleness rule: Chainlink equity feeds heartbeat every 24h. Older than 25h = STALE. */
export const STALE_AFTER_MS = 25 * 60 * 60 * 1000;
export function isStale(updatedAtUnix, nowMs = Date.now()) {
  return nowMs - updatedAtUnix * 1000 > STALE_AFTER_MS;
}
