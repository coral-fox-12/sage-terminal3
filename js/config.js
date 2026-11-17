// Sage onchain config. The anchor contract address is null until
// ResearchAnchor is deployed to Base Sepolia — the UI keeps the anchor
// button disabled while it is null (we never fake a transaction).
// Deploy: node deploy-tools/deploy.mjs, then set ANCHOR_CONTRACT below
// to the printed address and re-deploy the site.
export const ANCHOR_CONTRACT = '0x15a12E0c3102a0E05e64D9cc60786db808b37F68'; // deployed 2026-11-17, briefCount 0→1 verified (NVDA brief #0 anchored)
export const ANCHOR_CHAIN_ID = 84532; // Base Sepolia
export const ANCHOR_EXPLORER = 'https://sepolia.basescan.org';
export const ANCHOR_RPC = 'https://sepolia.base.org';
