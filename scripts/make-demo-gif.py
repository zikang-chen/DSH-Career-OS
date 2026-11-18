"""Compose the demo GIF from real rendered panel frames (Pillow, local only)."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / ".tmp" / "demo" / "overview-full.png"
OUT = ROOT / "docs" / "assets" / "demo-overview.gif"
WIDTH = 1000
FRAME_H = 760
# (top offset, caption) — crops of the single real page render
FRAMES = [
    (0, None),
    (330, None),
    (660, None),
]


def main() -> int:
    if not SRC.exists():
        print(f"missing source render: {SRC}", file=sys.stderr)
        return 1
    full = Image.open(SRC).convert("RGB")
    scale = WIDTH / full.width
    full = full.resize((WIDTH, int(full.height * scale)), Image.LANCZOS)

    frames = []
    for top, _ in FRAMES:
        top = min(top, max(0, full.height - FRAME_H))
        box = (0, top, WIDTH, min(full.height, top + FRAME_H))
        frame = Image.new("RGB", (WIDTH, FRAME_H), "#f6f7f9")
        frame.paste(full.crop(box), (0, 0))
        frames.append(frame.quantize(colors=128, method=Image.MEDIANCUT))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        OUT,
        save_all=True,
        append_images=frames[1:],
        duration=[1600, 1600, 2200],
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(frames)} frames)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
