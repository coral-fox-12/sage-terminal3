# Demo video script — Sage Private Briefs (Terminal 3) — 2–3 min

Target length: ~2:30. Record after `setup` + `seed-gemini` + `grant` have run
once (those need a T3N API key from the claim page). Narration is plain and
factual; every claim on screen is something the video actually shows.

## 0:00–0:20 — The problem (Sage live site)
- Show https://sage-terminal3.surge.sh. Generate a brief for NVDA.
- Say: "Sage writes a research brief from live Chainlink prices on Base, and
  anchors its hash onchain so anyone can verify it. The hash is public — but
  the full brief, with your positions and notes, shouldn't have to be."

## 0:20–0:50 — The private half (panel)
- Scroll to the Private Briefs panel. Show the trust-anchor proof line
  (verified live, node URL, SDK version).
- Click "Compute content address for current brief". Show the SHA-256.
- Say: "The brief is sealed into a private TEE map under this content
  address. Only the hash ever leaves the enclave."

## 0:50–1:30 — Seal it (terminal, real CLI)
- Terminal: `node t3/cli.mjs seal-brief --file sage-brief-NVDA.json --symbol NVDA`
- Show the receipt JSON: key, bytes, map `z:<tid>:briefs`, sealed_at_secs.
- Say: "Same brief, same address — the contract canonicalizes and hashes it
  inside the enclave, and publishes the digest to the Merkle leaf."

## 1:30–2:10 — Rewrite it without exposing the key (terminal)
- Terminal: `node t3/cli.mjs private-rewrite --key <the 64-hex key>`
- Show the rewritten text + token counts coming back.
- Say: "The Gemini key lives in the enclave's secrets map. It never touches
  this terminal, the browser, or the repo — only the rewritten text comes back.
  The browser's own rewrite box, by contrast, sends your key to Google
  directly. That's the difference this layer makes."

## 2:10–2:30 — Close (repo + what's next)
- Show the repo (contract source, tests, README verification table).
- Say: "Sage Private Briefs — public hash on Base, private text on Terminal 3.
  Repo and demo linked below. Try it: claim a testnet key, run setup, seal a
  brief — that's the traction this grant measures, and it's the part I need
  your help with."

## Shot checklist
- [ ] Sage site loads, brief generates (live prices or labelled DEMO mode)
- [ ] Panel proof line visible; content address computed on screen
- [ ] `verify` output (trust anchor, 205 ms) — or the proof JSON
- [ ] `seal-brief` receipt JSON on screen, key visible
- [ ] `private-rewrite` text + token counts on screen
- [ ] Repo page + contract source visible at the close
- [ ] Total ≤ 3:00, captions on, links in the description (demo, repo, DoraHacks)
