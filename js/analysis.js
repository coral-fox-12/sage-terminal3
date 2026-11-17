// Sage — deterministic analysis engine. Pure functions only: no DOM, no network.
// Every number in a research brief comes from these functions applied to real
// Chainlink feed data. Nothing here invents a price, a return, or a verdict.

/** Percent change from `oldPrice` to `newPrice`. Returns null on bad input. */
export function pctChange(newPrice, oldPrice) {
  if (!Number.isFinite(newPrice) || !Number.isFinite(oldPrice) || oldPrice === 0) return null;
  return ((newPrice - oldPrice) / oldPrice) * 100;
}

/** Population standard deviation of an array of numbers. Null on bad input. */
export function stdDev(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length < 2) return null;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

/** Daily returns (%) from a series of closing prices, oldest first. */
export function dailyReturns(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return [];
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const r = pctChange(closes[i], closes[i - 1]);
    if (r !== null) out.push(r);
  }
  return out;
}

/** Annualised volatility (%) from daily returns (252 trading days). */
export function annualisedVolatility(returns) {
  const sd = stdDev(returns);
  if (sd === null) return null;
  return sd * Math.sqrt(252);
}

/**
 * Momentum score 0–100, with explicit, auditable rules:
 *  +40 max from 7-day return (clamped to ±10% -> 0..40)
 *  +30 max from 24h return (clamped to ±5% -> 0..30)
 *  +30 max from low volatility (annualised vol 10% -> 30, 80%+ -> 0)
 * Score is withheld (null) when the feed is stale or inputs are missing.
 */
export function momentumScore({ change24h, change7d, volatility }) {
  if (change24h === null || change24h === undefined) return null;
  if (change7d === null || change7d === undefined) return null;
  if (volatility === null || volatility === undefined) return null;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const part7d = ((clamp(change7d, -10, 10) + 10) / 20) * 40;
  const part24h = ((clamp(change24h, -5, 5) + 5) / 10) * 30;
  const partVol = ((clamp(volatility, 10, 80) - 10) / 70) * 30; // high vol -> low score
  return Math.round(part7d + part24h + (30 - partVol));
}

export function scoreLabel(score) {
  if (score === null) return 'NO SCORE — data stale or incomplete';
  if (score >= 70) return 'Strong momentum';
  if (score >= 55) return 'Positive momentum';
  if (score >= 45) return 'Neutral';
  if (score >= 30) return 'Weak momentum';
  return 'Negative momentum';
}

/**
 * Build a research brief from live feed data.
 * @param {Object} input { symbol, name, price, updatedAt, updatedAtUnix, stale,
 *   change24h, change7d, closes (array of daily closes, oldest first), source }
 * @returns brief object with sections, score, warnings, and full sourcing.
 */
export function buildBrief(input) {
  const {
    symbol, name, price, updatedAt, updatedAtUnix, stale,
    change24h = null, change7d = null, closes = [], source = 'Chainlink feed on Base mainnet',
  } = input;
  const returns = dailyReturns(closes);
  const volatility = annualisedVolatility(returns);
  const score = stale ? null : momentumScore({ change24h, change7d, volatility });
  const warnings = [];
  if (stale) warnings.push('STALE FEED: price is older than 25h — score withheld, treat numbers as outdated.');
  if (!Number.isFinite(price)) warnings.push('NO LIVE PRICE: feed unreachable — no brief can be produced.');
  if (change24h === null) warnings.push('No 24h reference round available — 24h change not computed.');
  if (change7d === null) warnings.push('No 7d reference round available — 7d change not computed.');
  return {
    symbol,
    name,
    price: Number.isFinite(price) ? price : null,
    updatedAt,
    updatedAtUnix,
    stale: !!stale,
    change24h,
    change7d,
    volatility,
    score,
    label: scoreLabel(score),
    warnings,
    source,
    generatedAt: new Date().toISOString(),
    disclaimer:
      'Not financial advice. Research output of a deterministic agent reading public ' +
      'onchain price feeds. Tokenized stocks are not shares and carry no voting rights.',
    sections: {
      snapshot: Number.isFinite(price)
        ? `${name} (${symbol}) tokenized stock on Base: $${price.toFixed(2)} as of ${updatedAt}. Source: ${source}.`
        : `${name} (${symbol}): live price unavailable right now.`,
      trend:
        change7d === null
          ? 'Trend: not computable — 7d reference price missing.'
          : `Trend (7d): ${change7d >= 0 ? '+' : ''}${change7d.toFixed(2)}%. ` +
            (change24h === null ? '' : `Last 24h: ${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%. `) +
            (change7d > 3 ? 'Upward trend over the past week.'
              : change7d < -3 ? 'Downward trend over the past week.'
              : 'Sideways over the past week.'),
      volatility:
        volatility === null
          ? 'Volatility: not computable — need at least 2 daily closes.'
          : `Annualised volatility (from ${returns.length} daily returns): ${volatility.toFixed(1)}%. ` +
            (volatility > 60 ? 'High — expect large daily moves.'
              : volatility > 35 ? 'Moderate.'
              : 'Relatively calm for an equity.'),
      watchNext:
        'What the agent watches next: the next Chainlink feed update (0.5% deviation ' +
        'or 24h heartbeat), any multiplier change (corporate action) on the B20 token, ' +
        'and whether the 7d trend holds or reverses.',
    },
  };
}

// ---------------------------------------------------------------------------
// Paper portfolio — virtual $10,000, simulated trades at the live feed price.
// No real money, no custody, no execution. Pure functions over a state object.
// State: { cash, positions: { SYMBOL: { shares, avgCost } }, trades: [...] }
// ---------------------------------------------------------------------------

export const PAPER_STARTING_CASH = 10000;

export function newPaperPortfolio() {
  return { cash: PAPER_STARTING_CASH, positions: {}, trades: [] };
}

/** Simulate a BUY of `shares` at `price`. Returns new state or { error }. */
export function paperBuy(state, symbol, shares, price, at = new Date().toISOString()) {
  if (!Number.isFinite(shares) || shares <= 0) return { ...state, error: 'shares must be > 0' };
  if (!Number.isFinite(price) || price <= 0) return { ...state, error: 'no live price — cannot trade' };
  const cost = shares * price;
  if (cost > state.cash + 1e-9) return { ...state, error: `insufficient paper cash (need $${cost.toFixed(2)}, have $${state.cash.toFixed(2)})` };
  const pos = state.positions[symbol] || { shares: 0, avgCost: 0 };
  const newShares = pos.shares + shares;
  const newAvg = (pos.shares * pos.avgCost + cost) / newShares;
  return {
    cash: state.cash - cost,
    positions: { ...state.positions, [symbol]: { shares: newShares, avgCost: newAvg } },
    trades: [...state.trades, { side: 'BUY', symbol, shares, price, at }],
  };
}

/** Simulate a SELL of `shares` at `price`. Returns new state or { error }. */
export function paperSell(state, symbol, shares, price, at = new Date().toISOString()) {
  if (!Number.isFinite(shares) || shares <= 0) return { ...state, error: 'shares must be > 0' };
  if (!Number.isFinite(price) || price <= 0) return { ...state, error: 'no live price — cannot trade' };
  const pos = state.positions[symbol];
  if (!pos || pos.shares < shares) return { ...state, error: `insufficient paper position in ${symbol}` };
  const proceeds = shares * price;
  const remaining = pos.shares - shares;
  const positions = { ...state.positions };
  if (remaining === 0) delete positions[symbol];
  else positions[symbol] = { ...pos, shares: remaining };
  return {
    cash: state.cash + proceeds,
    positions,
    trades: [...state.trades, { side: 'SELL', symbol, shares, price, at }],
  };
}

/** Total portfolio value (cash + positions at live prices). `prices` = { SYMBOL: price }. */
export function paperValue(state, prices) {
  let positionsValue = 0;
  for (const [symbol, pos] of Object.entries(state.positions)) {
    const p = prices[symbol];
    if (!Number.isFinite(p)) return { value: null, error: `no live price for ${symbol}` };
    positionsValue += pos.shares * p;
  }
  const value = state.cash + positionsValue;
  return { value, pnl: value - PAPER_STARTING_CASH, pnlPct: ((value - PAPER_STARTING_CASH) / PAPER_STARTING_CASH) * 100 };
}
