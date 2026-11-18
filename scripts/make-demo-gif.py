"""Compose the README demo GIF from real captured panel frames.

Sources (in priority order):
  1. .tmp/gui/d1-overview.png, d2-jobs.png, d4-knowledge.png  ← real GUI window captures
  2. .tmp/demo/overview-full.png                              ← offline component render fallback
"""
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "assets" / "demo-panel.gif"
WIDTH = 1200
# Crop box in the 3862x2146 window capture: drop the DSH sidebar and title bar.
GUI_CROP = (152, 86, 3796, 2100)
GUI_FRAMES = [
    (ROOT / ".tmp" / "gui" / "d1-overview.png", 2200),
    (ROOT / ".tmp" / "gui" / "d2-jobs.png", 2200),
    (ROOT / ".tmp" / "gui" / "d4-knowledge.png", 2600),
]
OFFLINE = ROOT / ".tmp" / "demo" / "overview-full.png"


def frame_from_gui(path: Path) -> Image.Image:
    img = Image.open(path).convert("RGB").crop(GUI_CROP)
    height = round(img.height * WIDTH / img.width)
    return img.resize((WIDTH, height), Image.LANCZOS)


def main() -> int:
    frames, durations = [], []
    if all(p.exists() for p, _ in GUI_FRAMES):
        for path, ms in GUI_FRAMES:
            frames.append(frame_from_gui(path))
            durations.append(ms)
        label = "gui"
    elif OFFLINE.exists():
        img = Image.open(OFFLINE).convert("RGB")
        height = round(img.height * WIDTH / img.width)
        resized = img.resize((WIDTH, height), Image.LANCZOS)
        for top in (0, 330, 660):
            top = min(top, max(0, resized.height - 760))
            canvas = Image.new("RGB", (WIDTH, 760), "#f6f7f9")
            canvas.paste(resized.crop((0, top, WIDTH, min(resized.height, top + 760))), (0, 0))
            frames.append(canvas)
            durations.append(1800)
        label = "offline"
    else:
        print("no frames found; run scripts/make-demo-gif.mjs or capture the window first", file=sys.stderr)
        return 1

    quantized = [f.quantize(colors=160, method=Image.MEDIANCUT) for f in frames]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    quantized[0].save(OUT, save_all=True, append_images=quantized[1:], duration=durations,
                      loop=0, optimize=True, disposal=2)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(frames)} frames, source={label})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
