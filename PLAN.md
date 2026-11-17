# Base Stocks Maxxing — Build Plan

**Quest:** Base Builder Quest — Stocks Maxxing Season (sponsor: Coinbase Technologies, Inc.)
**Official page:** https://base.org/stocksmaxxing
**Official rules:** https://www.base.org/stocksmaxxing/rules
**Submission form:** https://docs.google.com/forms/d/1zotYvkeAtDjR2MKk3qNxyNIAfJ_IPQtzTtjNhOAF8js/viewform
**Verified:** 2026-11-17 (official rules page + quest page HTML + submission form, all read live)

## Verified facts

- **Prize pool: $100,000+ total** = $50,000 Base-track prizes + $48,000 partner prizes
  + $6,000 community-voted build-in-public award. Prizes paid in **USDC on Base**
  (rules §10). Per-track prize split is NOT published on the quest page.
- **Deadline: Dec 5, 2026, 11:59pm EST** (stated on the submission form itself)
  = Dec 6, 2026 04:59 UTC = **Dec 6, 2026 11:59 VN**. Rules say Quest Period ends
  Dec 5, 2026 and times are UTC by default — the form's EST time is the operative
  submission cutoff. **Internal deadline: finish by Dec 4 VN.**
- **Tracks (each judged separately):**
  1. Meme and Community Economies — "Build new ways to organize memes and communities
     around tokenized equities." (7 partners)
  2. **Agentic Stock Finance — "Build agents that research, earn or trade around
     tokenized stocks in novel ways." (3 partners) ← OUR TRACK**
  3. Programmable Stock Markets — "Create net-new stock market primitives, e.g. custom
     portfolios, indexes, structured products, financing tools, prediction markets,
     and market infrastructure." (3 partners)
- **Eligibility — Vietnam is ELIGIBLE.** Rules §4, exact text: *"The Quest is open to
  individuals who are 18 years of age or older at the time of entry and are not
  residents of any countries or regions sanctioned by the U.S. Office of Foreign
  Assets Control (OFAC)."* Vietnam is not OFAC-sanctioned. No Vietnam exclusion
  anywhere in the rules, quest page, or form.
- **Hard restriction — do NOT enable trading for US users.** Form + FAQ, exact text:
  *"Any projects that enable trading for U.S. users are not in scope."* Our entry
  therefore does **no real trading at all**: research + paper (simulated) portfolio
  only, with an explicit "not available to US users / no real trading" notice.
- **How to enter (rules §5):** (1) public X post with a video demo tagging
  @buildonbase; (2) submit the official form with the X-post link + track(s);
  (3) meet track requirements. No purchase, transaction, wallet funding, token
  holding, or payment required to enter. **Testnet builds are NOT judged less
  favorably.** One submission per track; a project may win in only one track.
- **Judging (rules §7 + press):** panel scores eligible submissions. Crypto Briefing
  reports the weights as **50% traction (real onchain usage) / 25% product quality /
  25% build in public** — the quest page text does not list weights, so treat the
  50/25/25 as reported, not confirmed. $6,000 build-in-public award is community-voted.
- **Winner verification:** ID/age/residence, sanctions screening, IRS W-9 or **W-8**
  (foreign persons — i.e. non-US winners are expected), wallet address, declaration.
  Respond within 7 days of notification.
- **Partners:** o1 Exchange, Bankr, Stonks Exchange, BaseStonk, Feel.cash, Hydropump
  by Hydrex.

## Concept — "Sage": the research agent for tokenized stocks on Base

**One-liner:** An AI-style research agent that reads *live* tokenized-stock prices
straight off Base (Chainlink feeds, no API key) and writes a sourced, checkable
research brief for each stock — plus a paper portfolio so anyone can test the
agent's ideas with zero real money.

**Why this wins in this track:**
- It is an *agent that researches* tokenized stocks — the track description's first
  verb — with no real trading, so it stays inside the "no US-user trading" rule.
- Every number is real and verifiable: price, feed update time, round history all
  come from Base mainnet. Nothing is invented.
- Traction hook (50% of score): the agent anchors each brief's hash onchain
  (Base Sepolia testnet first; mainnet if funded) via a tiny `ResearchAnchor`
  contract, and uses Builder Codes so onchain activity attributes to the app.
  Testnet submissions are explicitly not penalised.

**What the agent does (v1 scaffold, built):**
1. Fetches live prices for 8 Coinbase tokenized stocks (AAPL, AMZN, GOOGL, META,
   MSFT, MSTR, NVDA, TSLA) from Chainlink feeds on Base mainnet via the public RPC
   (`https://mainnet.base.org`, no key). Verified live 2026-11-17: NVDA feed
   returned $156.31, updated 2026-11-16 21:53 UTC.
2. Computes a deterministic research brief per stock: price, 24h/7d change from
   Chainlink round history, volatility (std-dev of daily closes), momentum score
   0–100 with explicit rules, staleness flag if the feed is >25h old. All rules are
   in `js/analysis.js` and unit-tested — no black box, no invented numbers.
3. Paper portfolio: virtual $10,000, buy/sell at the live feed price, positions +
   P&L in localStorage. No real money, no custody, no execution.
4. Optional BYO-key AI rewrite: paste your own Gemini key (stored only in the
   browser's localStorage) and the agent rewrites the brief in natural language.
   With no key, the deterministic brief is the full product.
5. Onchain anchor (code ready, NOT yet deployed): `contracts/ResearchAnchor.sol`
   stores `keccak256(brief)` + symbol + timestamp. Needs Base Sepolia test ETH
   from a faucet — follow-up, not a blocker for the demo.

**What it is NOT:** not financial advice (labelled on every brief), not a trading
bot, not a token launch, not affiliated with Coinbase/Base or any listed company.

## Architecture

```
index.html  — static single page, no build step, no dependencies
style.css   — plain CSS
js/feeds.js — Chainlink feed addresses, RPC calls (latestRoundData, getRoundData),
              decoding, staleness rules
js/analysis.js — pure functions: returns, volatility, momentum score, brief builder,
              paper-portfolio math (unit-tested, no DOM, no network)
js/app.js   — browser glue: fetch prices, render, paper portfolio UI, optional
              Gemini rewrite (BYO key, localStorage only)
tests/test.mjs — node:test, no deps; includes one live-RPC test (skips on no net)
contracts/ResearchAnchor.sol — anchor contract (deploy pending testnet ETH)
```

**Data honesty rules (enforced in code + tests):**
- Prices come ONLY from Chainlink feeds on Base mainnet. If the RPC call fails,
  the UI shows "data unavailable" — it never invents a price.
- A "Demo data" toggle exists for offline screenshots; it is OFF by default and
  every demo-data value is labelled DEMO.
- Feed staleness: if `updatedAt` is >25h old, the brief is flagged STALE and the
  score is withheld.

## Files to build (status)

- [x] `PLAN.md` (this file)
- [x] `index.html`, `style.css`, `js/feeds.js`, `js/analysis.js`, `js/app.js`
- [x] `tests/test.mjs` (node --test, all passing)
- [x] `contracts/ResearchAnchor.sol` (source only — not deployed)
- [x] `README.md`, `package.json`
- [x] Compile ResearchAnchor (solc 0.8.24, artifact verified by sha256)
- [x] Deploy script `deploy-tools/deploy.mjs` (dry-run OK; needs faucet ETH)
- [x] Anchor button wired (`js/config.js` + `js/anchor.js` + app.js; 15/15 tests)
- [x] Deploy to Surge (parent: surge.sh, e.g. `sage-stocks-base.surge.sh`)
- [ ] Public GitHub repo under coral-fox-12 (parent: create + push)
- [ ] Base Sepolia test ETH + deploy ResearchAnchor + wire the anchor button
      (contract COMPILED 2026-11-17, deploy script dry-run OK, button wired +
      site re-deployed — blocked only on faucet ETH; see DEPLOY_STATUS.md for
      the faucet-by-faucet verdicts and the exact browser step: Alchemy faucet
      first, else Chainlink; then `node deploy.mjs`, set ANCHOR_CONTRACT,
      re-deploy)
- [ ] Demo video (1–2 min, screen recording) + X post tagging @buildonbase
      (parent owns X posting — no X account exists yet)
- [ ] Submit the Google Form (parent owns submission)

## Submission checklist (parent-owned steps)

- [ ] Live deployed app URL (Surge)
- [ ] Public GitHub repo URL
- [ ] Demo video (record the app: pick a stock → brief → paper trade)
- [ ] X post (public) with the video, tagging @buildonbase — needs an X account
- [ ] Google Form submitted with: X-post link, track = Agentic Stock Finance,
      project description, wallet address for USDC prize (Base)
- [ ] Build-in-public posts on X during the season (for the 25% + $6,000 award)
- [ ] Submit BEFORE Dec 5, 2026 11:59pm EST (Dec 6, 11:59 VN); target Dec 4 VN

## Risks / open items

- **Traction is ~50% of the score.** A static demo with no onchain activity will
  score low there. Mitigation: deploy the anchor contract on Base Sepolia and have
  the agent anchor every brief; document testnet usage (explicitly allowed).
  Even so, real user traction in ~2 weeks is the hardest part — build-in-public
  on X is the main lever.
- **Per-track prize amounts unpublished** — the $50,000 Base-track total is split
  across 3 tracks somehow; exact Agentic Stock Finance prizes unknown.
- **No X account yet** — the entry REQUIRES a public X post. This is a parent
  decision (create/use an X account).
- **No LLM key in hand** (Groq/Gemini blocked) — the product is designed to work
  fully without one; the AI rewrite is an optional upgrade.
- **US-user rule:** never add real trade execution or a US-facing trading flow;
  keep the "research + paper only" positioning in every public description.
