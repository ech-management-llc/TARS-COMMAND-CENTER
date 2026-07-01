#!/usr/bin/env python3
"""stamp_versions.py — the ONE cache-bust knob for the static TCC (TD-118 / TD-103).

WHY: shared scripts (shared/fl-*.js) + the shell scripts (app.js / agents.js) are included by the
shell (index.html) AND by every LIVE drill-in tile (layers/*/artifact/index.html), each with its
own `?v=` query. Those `?v=` values DRIFTED (e.g. tiles loaded fl-api.js?v=20260626e while the shell
loaded ?v=20260630a) — so a drill-in tile could run a STALE fl-api against a fresh shell, silently
corrupting behavior and, during a bug-bash, corrupting the signal.

sw.js does NOT precache the shared scripts and matches its cache by full URL *including* the query,
so the `?v=` is the real HTTP-cache buster for them; the SW CACHE_NAME busts the precached shell +
tile HTML. This script sets BOTH to a single VERSION so the whole app busts in lockstep.

USAGE
    python scripts/stamp_versions.py <VERSION>        # stamp everything to <VERSION>
    python scripts/stamp_versions.py --check <VERSION> # report drift; exit 1 if any include != VERSION
    python scripts/stamp_versions.py --check           # report the set of versions in use (no target)

Run it whenever ANY shared/shell script changes, then commit. Keeps every includer + sw.js aligned.
Exit: 0 ok · 1 drift found (--check) · 2 usage error.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Versioned includes we stamp: any shared/*.js plus the two shell scripts. (fl-tile-settings.js and
# fl-scope-select.js currently ship with NO ?v= — stamping brings them under the one knob too.)
_INCLUDE_RE = re.compile(
    r'(?P<pre>src=")(?P<path>[^"]*?)(?P<name>shared/[\w-]+\.js|app\.js|agents\.js)(?P<ver>\?v=[\w.\-]+)?(?P<post>")'
)
_CACHE_RE = re.compile(r"(const CACHE_NAME = ')[^']*(';)")
_VERSION_RE = re.compile(r"^[\w.\-]+$")


def _includers() -> list[Path]:
    files = [ROOT / "index.html"]
    files += sorted(ROOT.glob("layers/*/artifact/index.html"))
    return [f for f in files if f.exists()]


def _versions_in_use() -> dict[str, set[str]]:
    """Map each versioned include name -> the set of ?v= values seen across all includers."""
    seen: dict[str, set[str]] = {}
    for f in _includers():
        for m in _INCLUDE_RE.finditer(f.read_text(encoding="utf-8")):
            ver = (m.group("ver") or "").replace("?v=", "") or "(none)"
            seen.setdefault(m.group("name"), set()).add(ver)
    return seen


def stamp(version: str) -> int:
    changed = 0
    for f in _includers():
        txt = f.read_text(encoding="utf-8")
        new = _INCLUDE_RE.sub(
            lambda m: f'{m.group("pre")}{m.group("path")}{m.group("name")}?v={version}{m.group("post")}',
            txt,
        )
        if new != txt:
            f.write_text(new, encoding="utf-8", newline="")
            changed += 1
    sw = ROOT / "sw.js"
    swtxt = sw.read_text(encoding="utf-8")
    swnew = _CACHE_RE.sub(rf"\1tcc-tilehome-live-{version}\2", swtxt)
    if swnew != swtxt:
        sw.write_text(swnew, encoding="utf-8", newline="")
    print(f"stamped {changed} includer(s) + sw.js CACHE_NAME -> version {version}")
    return 0


def check(target: str | None) -> int:
    seen = _versions_in_use()
    drift = False
    for name in sorted(seen):
        vers = sorted(seen[name])
        flag = ""
        if len(vers) > 1:
            flag, drift = "  <-- DRIFT (multiple versions)", True
        elif target and vers != [target]:
            flag, drift = f"  <-- != target {target}", True
        print(f"  {name:32s} {', '.join(vers)}{flag}")
    if target and not drift:
        print(f"OK — every versioned include is at {target}")
    return 1 if (drift and target is not None) else 0


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] == "--check":
        return check(args[1] if len(args) > 1 else None)
    if len(args) != 1 or not _VERSION_RE.match(args[0]):
        print("usage: stamp_versions.py <VERSION>  |  --check [VERSION]", file=sys.stderr)
        return 2
    return stamp(args[0])


if __name__ == "__main__":
    sys.exit(main())
