#!/usr/bin/env python3
"""Package the complete TeachWrite source without local dependencies or data."""
from pathlib import Path
import os
import zipfile

root = Path(__file__).resolve().parents[1]
release = root / "release"
release.mkdir(exist_ok=True)
target = release / "TeachWrite-0.1.0-source.zip"
excluded = {".git", "node_modules", "target", "dist", "release", ".evidence", ".venv", "__pycache__"}
count = 0
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for directory, dirs, files in os.walk(root):
        dirs[:] = sorted(name for name in dirs if name not in excluded and not (Path(directory) / name).is_symlink())
        for name in sorted(files):
            file = Path(directory) / name
            if file.is_symlink() or name == ".DS_Store" or name.startswith(".env") or file.suffix in {".pyc", ".log"}:
                continue
            archive.write(file, "TeachWrite/" + file.relative_to(root).as_posix())
            count += 1
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None, "Source archive CRC check failed"
    required = ["package-lock.json", "src-tauri/Cargo.lock", "src/core/teaching/guide.ts", "src/core/store/authorWrite.ts", ".github/workflows/desktop.yml", "docs/HANDOFF.md"]
    for name in required:
        assert "TeachWrite/" + name in archive.namelist(), "Missing " + name
print("Source archive:", target, "files:", count, "bytes:", target.stat().st_size)
