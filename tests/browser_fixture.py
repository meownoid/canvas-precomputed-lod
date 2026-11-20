"""Create synthetic fixtures only; never accepts an existing populated vault."""

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

vault = Path(sys.argv[1])
vault.mkdir(parents=True, exist_ok=True)
if any(vault.iterdir()):
    raise SystemExit("browser fixture target must be empty")
image = Image.new("RGB", (2400, 1200), (18, 35, 55))
draw = ImageDraw.Draw(image)
for x in range(0, 2400, 40):
    draw.rectangle((x, 0, x + 39, 1199), fill=(20 + x // 16, 80 + x // 32, 130))
for step in range(20, 580, 30):
    draw.ellipse((1200 - step, 600 - step, 1200 + step, 600 + step), outline=(255, 235, 185), width=5)
draw.text((80, 80), "PRECOMPUTED CANVAS LOD", fill="white", font_size=60)
image.save(vault / "photo.png", compress_level=0)
image.close()
with (vault / "attachment.pdf").open("wb") as attachment:
    attachment.truncate(32 * 1024 * 1024)
(vault / "Board.canvas").write_text(
    json.dumps(
        {
            "nodes": [
                {"id": "image", "type": "file", "file": "photo.png", "x": 0, "y": 0, "width": 600, "height": 300},
                {"id": "attachment", "type": "file", "file": "attachment.pdf"},
            ]
        }
    )
)
