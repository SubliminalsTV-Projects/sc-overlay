#!/usr/bin/env python3
"""Batch background removal for fabricator item crops.

Offline ops tool — NOT part of the desktop app (that stays zero-dep; electron-builder
only packs electron/**). Takes teal-background item crops captured from the SC
Fabrication Kiosk, strips the kiosk background with rembg (local u2net model + alpha
matting to kill the teal edge halo), and writes transparent WebP renders. Optionally
uploads them to subliminal.gg's fab-image ingest.

  Input:  <in-dir>/<uuid>.(jpg|png|webp)   teal-background crops
  Output: <out-dir>/<uuid>.webp            transparent (alpha) renders

Setup + run (see README.md):
  uv venv -p 3.10 .venv && uv pip install -r requirements.txt
  .venv/Scripts/python bgremove.py --in <crops> --out out
  # publish (replacing an existing image needs its row DELETEd first — see README):
  .venv/Scripts/python bgremove.py --in <crops> --out out --upload --token scbp_...
"""
import argparse
import io
import json
import os
import sys
import urllib.request

from PIL import Image, ImageFilter
from rembg import new_session, remove

MAX_BYTES = 600 * 1024  # site ingest cap


def strip(img, session, erode):
    """teal-bg RGB image -> transparent RGBA render."""
    cut = remove(
        img.convert("RGB"),
        session=session,
        alpha_matting=True,                       # estimate true foreground -> removes teal spill
        alpha_matting_foreground_threshold=240,
        alpha_matting_background_threshold=15,
        alpha_matting_erode_size=8,
        post_process_mask=True,
    )
    if erode > 0:  # optional extra fringe shave for stubborn halos
        a = cut.getchannel("A").filter(ImageFilter.MinFilter(erode * 2 + 1))
        a = a.filter(ImageFilter.GaussianBlur(0.6))
        cut.putalpha(a)
    return cut


def autocrop(cut, thresh=8, pad_px=0, pad_frac=0.0):
    """Trim transparent margin to the item, then add a transparent border. bbox is taken
    over alpha > thresh (ignores near-invisible matting noise). Padding = pad_px plus
    pad_frac of the item's larger side (proportional → even framing across item sizes)."""
    mask = cut.getchannel("A").point(lambda v: 255 if v > thresh else 0)
    bbox = mask.getbbox()
    if not bbox:
        return cut
    item = cut.crop(bbox)
    p = pad_px + round(max(item.size) * pad_frac)
    if p <= 0:
        return item
    canvas = Image.new("RGBA", (item.size[0] + 2 * p, item.size[1] + 2 * p), (0, 0, 0, 0))
    canvas.paste(item, (p, p))
    return canvas


def main():
    ap = argparse.ArgumentParser(description="Strip fabricator teal bg -> transparent WebP.")
    ap.add_argument("--in", dest="indir", required=True, help="dir of teal crops (<uuid>.jpg)")
    ap.add_argument("--out", dest="outdir", required=True, help="output dir for <uuid>.webp")
    ap.add_argument("--model", default="u2net", help="rembg model (default u2net)")
    ap.add_argument("--erode", type=int, default=0, help="extra alpha-erode radius px (default 0)")
    ap.add_argument("--pad", type=int, default=0, help="fixed transparent border px (default 0)")
    ap.add_argument("--pad-pct", type=float, default=0.0, dest="pad_pct",
                    help="transparent border as fraction of the item's larger side, e.g. 0.06")
    ap.add_argument("--no-autocrop", dest="autocrop", action="store_false",
                    help="keep the full frame size instead of trimming to the item")
    ap.add_argument("--quality", type=int, default=90, help="WebP quality (default 90)")
    ap.add_argument("--upload", action="store_true", help="POST each result to the site")
    ap.add_argument("--site", default="https://subliminal.gg")
    ap.add_argument("--token", default=os.environ.get("SCBP_TOKEN", ""), help="scbp_ device token")
    args = ap.parse_args()

    exts = (".jpg", ".jpeg", ".png", ".webp")
    files = [f for f in sorted(os.listdir(args.indir)) if f.lower().endswith(exts)]
    if not files:
        sys.exit(f"no images in {args.indir}")
    if args.upload and not args.token:
        sys.exit("--upload needs --token or SCBP_TOKEN")

    os.makedirs(args.outdir, exist_ok=True)
    session = new_session(args.model)

    for f in files:
        uuid = os.path.splitext(f)[0]
        cut = strip(Image.open(os.path.join(args.indir, f)), session, args.erode)
        if args.autocrop:
            cut = autocrop(cut, pad_px=args.pad, pad_frac=args.pad_pct)
        buf = io.BytesIO()
        cut.save(buf, format="WEBP", quality=args.quality, method=6)
        data = buf.getvalue()
        with open(os.path.join(args.outdir, uuid + ".webp"), "wb") as fh:
            fh.write(data)

        line = f"{uuid}  {cut.size[0]}x{cut.size[1]}  {len(data) // 1024}KB"
        if len(data) > MAX_BYTES:
            line += "  !! OVER 600KB cap — lower --quality"
        if args.upload and len(data) <= MAX_BYTES:
            req = urllib.request.Request(
                f"{args.site}/api/sc/fab-image?item={uuid}",
                data=data, method="POST",
                headers={"Content-Type": "image/webp", "Authorization": f"Bearer {args.token}"},
            )
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    line += f"  -> stored={json.loads(r.read()).get('stored')}"
            except Exception as e:  # noqa: BLE001 - report and continue the batch
                line += f"  -> upload ERR {e}"
        print(line)
    print("done")


if __name__ == "__main__":
    main()
