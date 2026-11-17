// Sage — onchain anchoring of research briefs (Base Sepolia testnet).
// Pure, testable parts live here with no DOM dependency; the wallet flow
// lazily loads ethers from the CDN only when the user clicks Anchor.
import { ANCHOR_CONTRACT, ANCHOR_CHAIN_ID, ANCHOR_EXPLORER } from './config.js';

// Minimal ABI — only what the UI needs.
export const ANCHOR_ABI_MIN = [
  'function anchorBrief(string symbol, bytes32 briefHash) returns (uint256)',
  'function briefCount() view returns (uint256)',
  'function briefs(uint256) view returns (address author, string symbol, bytes32 briefHash, uint256 timestamp)',
];

// 4-byte selector of anchorBrief(string,bytes32) = keccak256("anchorBrief(string,bytes32)")[0:4].
export const ANCHOR_BRIEF_SELECTOR = 'b7c7967c';

/** ABI-encode anchorBrief(symbol, briefHash) by hand (no library needed).
 *  Layout: selector | offset=0x40 | bytes32 hash | string length | string bytes (padded).
 *  Throws on a malformed hash. Pure function — unit-tested in tests/test.mjs. */
export function encodeAnchorBriefCalldata(symbol, briefHash) {
  const hash = String(briefHash).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('briefHash must be a 32-byte hex string');
  const data = new TextEncoder().encode(String(symbol));
  const lenWord = data.length.toString(16).padStart(64, '0');
  let dataHex = '';
  for (const b of data) dataHex += b.toString(16).padStart(2, '0');
  dataHex = dataHex.padEnd(Math.ceil(dataHex.length / 64) * 64, '0');
  return '0x' + ANCHOR_BRIEF_SELECTOR
    + '40'.padStart(64, '0')
    + hash
    + lenWord
    + dataHex;
}

let ethersPromise = null;
/** Load ethers UMD from the CDN on first use (not at page load). */
export function loadEthersUmd() {
  if (typeof window === 'undefined' || !window.document) {
    return Promise.reject(new Error('ethers UMD loads only in a browser'));
  }
  if (window.ethers) return Promise.resolve(window.ethers);
  if (ethersPromise) return ethersPromise;
  ethersPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.umd.min.js';
    s.onload = () => (window.ethers ? resolve(window.ethers) : reject(new Error('ethers failed to load')));
    s.onerror = () => reject(new Error('could not load ethers from CDN'));
    document.head.appendChild(s);
  });
  return ethersPromise;
}

/** Anchor the current brief via the user's own wallet (MetaMask etc.).
 *  Returns { briefHash, txHash, explorerTx }. Throws with a plain message on
 *  any failure — the caller shows it, never a fake success. */
export async function anchorBriefViaWallet(symbol, briefJson) {
  if (!ANCHOR_CONTRACT) throw new Error('Anchor contract is not deployed yet.');
  if (typeof window === 'undefined' || !window.ethereum) {
    throw new Error('No wallet detected. Install MetaMask (or another EVM wallet), switch it to Base Sepolia, then try again.');
  }
  const ethers = await loadEthersUmd();
  const provider = new ethers.BrowserProvider(window.ethereum);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== ANCHOR_CHAIN_ID) {
    throw new Error(`Your wallet is on chain ${network.chainId}. Switch it to Base Sepolia (chain ${ANCHOR_CHAIN_ID}) and try again.`);
  }
  const signer = await provider.getSigner();
  const contract = new ethers.Contract(ANCHOR_CONTRACT, ANCHOR_ABI_MIN, signer);
  const briefHash = ethers.keccak256(ethers.toUtf8Bytes(briefJson));
  const tx = await contract.anchorBrief(symbol, briefHash);
  return { briefHash, txHash: tx.hash, explorerTx: `${ANCHOR_EXPLORER}/tx/${tx.hash}` };
}
