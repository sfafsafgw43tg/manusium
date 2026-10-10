#!/usr/bin/env python3
"""Create installable source archives for Chromium and Firefox without third-party tooling."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dist"
IGNORED_PARTS = {".git", "dist", "tools", "__pycache__"}


def files():
    for path in ROOT.rglob("*"):
        relative = path.relative_to(ROOT)
        if (not path.is_file() or relative.name in {".gitignore", "README.md"}
                or any(part in IGNORED_PARTS for part in relative.parts)):
            continue
        yield path


def build(name: str, firefox: bool = False) -> Path:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    if firefox:
        manifest["browser_specific_settings"] = {"gecko": {"id": "proximal-editor@example.invalid", "strict_min_version": "121.0"}}
    OUT.mkdir(exist_ok=True)
    target = OUT / name
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files():
            relative = path.relative_to(ROOT).as_posix()
            if path.name == "manifest.json":
                archive.writestr(relative, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
            else:
                archive.write(path, relative)
    return target


def main() -> None:
    shutil.rmtree(OUT, ignore_errors=True)
    print(build("proximal-editor-chromium.zip"))
    print(build("proximal-editor-firefox.xpi", firefox=True))


if __name__ == "__main__":
    main()
