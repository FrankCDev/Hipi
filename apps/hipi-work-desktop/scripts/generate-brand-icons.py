#!/usr/bin/env python3
"""Offline product assets. Requires installed Inkscape 1.4 and Pillow 12.3.0.

No downloads, shell expansion, platform packaging, or application execution.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile

from PIL import Image

BRANDING = Path(__file__).resolve().parents[1] / "branding"
SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
ICNS_TYPES = {16: b"icp4", 32: b"icp5", 64: b"icp6", 128: b"ic07", 256: b"ic08", 512: b"ic09", 1024: b"ic10"}


def generate():
    pngs = {}
    with tempfile.TemporaryDirectory(prefix="hipi-brand-") as temporary:
        environment = {**os.environ, "INKSCAPE_PROFILE_DIR": temporary}
        for size in SIZES:
            target = Path(temporary) / f"{size}.png"
            subprocess.run([
                "inkscape", str(BRANDING / "icon.svg"), "--export-type=png",
                f"--export-filename={target}", f"--export-width={size}",
                f"--export-height={size}", "--export-background-opacity=0",
            ], check=True, env=environment, capture_output=True)
            with Image.open(target) as image:
                output = io.BytesIO()
                image.convert("RGBA").save(output, format="PNG", compress_level=9)
                pngs[size] = output.getvalue()
    for size, data in pngs.items():
        (BRANDING / "png" / f"{size}x{size}.png").write_bytes(data)
    # ICO directory entries embed the exact rendered PNG for each resolution.
    offset = 6 + 16 * len(ICO_SIZES)
    entries = []
    for size in ICO_SIZES:
        data = pngs[size]
        entries.append(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    (BRANDING / "icon.ico").write_bytes(
        struct.pack("<HHH", 0, 1, len(entries)) + b"".join(entries) + b"".join(pngs[size] for size in ICO_SIZES)
    )
    # PNG-backed ICNS representations; no macOS iconutil or external codec needed.
    chunks = b"".join(kind + struct.pack(">I", len(pngs[size]) + 8) + pngs[size] for size, kind in ICNS_TYPES.items())
    (BRANDING / "icon.icns").write_bytes(b"icns" + struct.pack(">I", len(chunks) + 8) + chunks)
    files = [BRANDING / "icon.svg", BRANDING / "icon.ico", BRANDING / "icon.icns"]
    files.extend(BRANDING / "png" / f"{size}x{size}.png" for size in SIZES)
    manifest = {
        "schemaVersion": 1,
        "source": "icon.svg",
        "pngSizes": list(SIZES),
        "icoSizes": list(ICO_SIZES),
        "icnsSizes": list(ICNS_TYPES),
        "files": [{"file": file.relative_to(BRANDING).as_posix(), "bytes": file.stat().st_size,
                   "sha256": hashlib.sha256(file.read_bytes()).hexdigest()} for file in files],
    }
    (BRANDING / "asset-inventory.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {len(files)} product assets from icon.svg")


if __name__ == "__main__":
    generate()
