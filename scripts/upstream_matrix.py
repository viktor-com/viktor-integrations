#!/usr/bin/env python3
"""Run one adapter's tests against a chosen upstream channel.

  python3 scripts/upstream_matrix.py --list
  python3 scripts/upstream_matrix.py --adapter ai-sdk --channel latest
  python3 scripts/upstream_matrix.py --adapter pydantic-ai --channel min

Channels: `min` pins the versions in ci/upstream-matrix.json, `latest` installs the newest release,
`next` installs a pre-release when one newer than `latest` exists and otherwise reports "no next" (exit 0).

Python adapters run in a throwaway virtualenv. TypeScript adapters install with `npm install --no-save`
into the workspace, so run this in CI or follow it with `npm ci` locally.
Exit code: 0 pass or nothing to test, 1 test failure, 2 install failure.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MATRIX = json.loads((ROOT / "ci" / "upstream-matrix.json").read_text())["adapters"]


def sh(cmd: list[str], cwd: Path, check: bool = False, env: dict[str, str] | None = None) -> int:
    print("$", " ".join(cmd), flush=True)
    code = subprocess.run(cmd, cwd=cwd, env={**os.environ, **(env or {})}).returncode
    if check and code != 0:
        sys.exit(2)
    return code


def semver_key(v: str) -> tuple:
    core, _, pre = v.partition("-")
    nums = tuple(int(x) for x in core.split(".")[:3] if x.isdigit())
    return (nums, 1 if not pre else 0, pre)


def npm_view(pkg: str, field: str) -> object:
    out = subprocess.run(["npm", "view", pkg, field, "--json"], capture_output=True, text=True, cwd=ROOT).stdout
    return json.loads(out) if out.strip() else None


def run_ts(adapter: dict, channel: str) -> int:
    specs: list[str] = []
    for pkg, minimum in adapter["upstream"].items():
        if channel == "min":
            specs.append(f"{pkg}@{minimum}")
        elif channel == "latest":
            specs.append(f"{pkg}@latest")
        else:
            tags = npm_view(pkg, "dist-tags") or {}
            latest = tags.get("latest", "0.0.0")
            newer = [tags[t] for t in adapter.get("next_tags", []) if t in tags and semver_key(tags[t]) > semver_key(latest)]
            if newer:
                specs.append(f"{pkg}@{max(newer, key=semver_key)}")
    if channel == "next" and not specs:
        print(f"[{adapter['id']}] no pre-release newer than latest: nothing to test")
        return 0
    sh(["npm", "install", "--no-save", "--no-audit", "--no-fund", *specs], ROOT, check=True)
    sh(["npm", "run", "sync-spec"], ROOT, check=True)
    for dep in ["packages/core", *adapter.get("needs_build", [])]:
        sh(["npm", "run", "build"], ROOT / dep, check=True)
    print(f"[{adapter['id']}] resolved:", flush=True)
    sh(["npm", "ls", *adapter["upstream"].keys(), "--depth=0"], ROOT / adapter["dir"])
    code = sh(["npx", "tsc", "-p", "tsconfig.json", "--noEmit"], ROOT / adapter["dir"])
    code |= sh(["npx", "vitest", "run"], ROOT / adapter["dir"])
    return 1 if code else 0


def run_py(adapter: dict, channel: str) -> int:
    uv = shutil.which("uv") or "uv"
    with tempfile.TemporaryDirectory(prefix=f"viktor-matrix-{adapter['id']}-") as tmp:
        venv = Path(tmp) / "venv"
        py = str(venv / "bin" / "python")
        sh([uv, "venv", "-q", str(venv)], ROOT, check=True)
        base = [uv, "pip", "install", "-q", "--python", py]
        editable = ["-e", str(ROOT / "python" / "core"), "-e", str(ROOT / adapter["dir"])]
        dev = ["pytest>=8", "pytest-asyncio>=0.24", *adapter.get("extras", [])]
        if channel == "min":
            pins = [f"{pkg}=={ver}" for pkg, ver in adapter["upstream"].items()]
            code = sh([*base, *editable, *dev, *pins], ROOT)
        elif channel == "latest":
            code = sh([*base, "-U", *editable, *dev, *adapter["upstream"].keys()], ROOT)
        else:
            code = sh([*base, "-U", "--prerelease=allow", *editable, *dev, *adapter["upstream"].keys()], ROOT)
        if code:
            return 2
        print(f"[{adapter['id']}] resolved:", flush=True)
        names = [p.split("[")[0] for p in adapter["upstream"]] + ["openai"]
        sh([uv, "pip", "show", "-q", "--python", py, *names], ROOT)
        sh([py, "-c", "import importlib.metadata as m, sys; [print(' ', n, m.version(n)) for n in sys.argv[1:]]", *names], ROOT)
        node = shutil.which("node")
        if node:
            sh([node, "scripts/sync_spec.mjs"], ROOT)
        return 1 if sh([py, "-m", "pytest", adapter["tests"], "-q", "-p", "no:cacheprovider"], ROOT / "python") else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter")
    ap.add_argument("--channel", choices=["min", "latest", "next"], default="latest")
    ap.add_argument("--list", action="store_true", help="print the GitHub Actions matrix as JSON")
    args = ap.parse_args()
    if args.list:
        print(json.dumps({"include": [{"adapter": a["id"], "lang": a["lang"]} for a in MATRIX]}))
        return 0
    adapter = next((a for a in MATRIX if a["id"] == args.adapter), None)
    if not adapter:
        print(f"unknown adapter {args.adapter}; known: {[a['id'] for a in MATRIX]}")
        return 2
    return run_ts(adapter, args.channel) if adapter["lang"] == "ts" else run_py(adapter, args.channel)


if __name__ == "__main__":
    sys.exit(main())
