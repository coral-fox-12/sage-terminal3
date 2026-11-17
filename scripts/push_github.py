#!/usr/bin/env python3
"""Push sage-terminal3 to GitHub (coral-fox-12) via the Contents API.

Sandbox git push fails, so files go up through the REST API: create the
repo if needed, then PUT each file (base64) with its current sha when it
already exists.

Excluded on purpose:
- node_modules, contract/target (build artifacts; rebuild with npm/cargo)
- t3/state.json (local deploy state: contract id, version, hashes)
- package-lock.json is INCLUDED (pins the SDK version).

Usage:
    python3 scripts/push_github.py [--repo sage-terminal3] [--dry-run]

The PAT is read at runtime from ~/workspace/makefun/github-pat.txt
and never printed or committed.
"""
import argparse
import base64
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
OWNER = "coral-fox-12"
PAT_PATH = Path.home() / "workspace/makefun/github-pat.txt"
API = "https://api.github.com"

INCLUDE = [
    "README.md",
    "DEMO_SCRIPT.md",
    "PLAN.md",
    "index.html",
    "style.css",
    "CNAME",
    ".surgeignore",
    ".gitignore",
    "package.json",
    "package-lock.json",
    "js/analysis.js",
    "js/anchor.js",
    "js/app.js",
    "js/config.js",
    "js/feeds.js",
    "js/t3-panel.js",
    "contracts/ResearchAnchor.sol",
    "t3/cli.mjs",
    "t3/lib.mjs",
    "t3/proof/trust-anchor.json",
    "contract/Cargo.toml",
    "contract/src/lib.rs",
    "contract/src/rewrite.rs",
    "contract/src/seal.rs",
    "contract/src/sha256.rs",
    "contract/wit/world.wit",
    "contract/wit/deps/host-interfaces-2.1.0/package.wit",
    "contract/wit/deps/host-outbox-1.0.0/package.wit",
    "contract/wit/deps/host-tenant-2.0.0/package.wit",
    "tests/lib.test.mjs",
    "scripts/push_github.py",
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo", default="sage-terminal3")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    pat = PAT_PATH.read_text(encoding="utf-8").strip()
    session = requests.Session()
    session.headers.update({
        "Authorization": f"token {pat}",
        "Accept": "application/vnd.github+json",
    })

    missing = [f for f in INCLUDE if not (ROOT / f).exists()]
    if missing:
        print(f"MISSING files, aborting: {missing}", file=sys.stderr)
        return 1
    print(f"{len(INCLUDE)} files to push to {OWNER}/{args.repo}")
    if args.dry_run:
        for f in INCLUDE:
            print(f"  would push {f} ({(ROOT / f).stat().st_size} B)")
        return 0

    r = session.get(f"{API}/repos/{OWNER}/{args.repo}")
    if r.status_code == 404:
        r = session.post(
            f"{API}/user/repos",
            json={
                "name": args.repo,
                "description": "Sage Private Briefs — Terminal 3 privacy layer for Sage (Base Stocks research agent): seal briefs into a private TEE KV map, rewrite them with Gemini inside the enclave. DoraHacks T3 Build+Scale entry.",
                "private": False,
                "has_issues": True,
                "has_projects": False,
                "has_wiki": False,
            },
        )
        r.raise_for_status()
        print(f"created repo {OWNER}/{args.repo}")
    elif r.status_code != 200:
        print(f"repo check failed: {r.status_code} {r.text[:300]}", file=sys.stderr)
        return 1
    else:
        print(f"repo {OWNER}/{args.repo} exists, updating files")

    pushed, updated = 0, 0
    for rel in INCLUDE:
        path = ROOT / rel
        content = base64.b64encode(path.read_bytes()).decode()
        url = f"{API}/repos/{OWNER}/{args.repo}/contents/{rel}"
        existing = session.get(url)
        payload: dict = {
            "message": f"Sage Private Briefs: T3 privacy layer (seal-brief + private-rewrite) ({rel})",
            "content": content,
        }
        if existing.status_code == 200:
            payload["sha"] = existing.json()["sha"]
            updated += 1
        elif existing.status_code != 404:
            print(f"  !! GET {rel} -> {existing.status_code}", file=sys.stderr)
            return 1
        resp = session.put(url, json=payload)
        if resp.status_code not in (200, 201):
            print(f"  !! PUT {rel} -> {resp.status_code}: {resp.text[:300]}", file=sys.stderr)
            return 1
        pushed += 1
        print(f"  pushed {rel} ({path.stat().st_size} B)")
    print(f"done: {pushed} files pushed ({updated} updated), 0 failed")
    print(f"https://github.com/{OWNER}/{args.repo}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
