"""Shared fabricator-render processing — one source of truth for the CLI (bgremove.py)
and the VPS sweep daemon (sweep.py). Strips the teal Fabrication-Kiosk background with
rembg, trims to the item, and adds a proportional transparent pad."""
import io

from PIL import Image, ImageFilter

MAX_BYTES = 600 * 1024  # site ingest cap
PAD_PCT = 0.06          # production padding (Sub-approved 2026-07-06)
QUALITY = 95            # production WebP quality


def strip(img, session, erode=0):
    """teal-bg image -> transparent RGBA render (alpha matting kills the teal edge halo)."""
    cut = remove_bg(img, session)
    if erode > 0:  # optional extra fringe shave for stubborn halos
        a = cut.getchannel("A").filter(ImageFilter.MinFilter(erode * 2 + 1))
        a = a.filter(ImageFilter.GaussianBlur(0.6))
        cut.putalpha(a)
    return cut


def remove_bg(img, session):
    from rembg import remove
    return remove(
        img.convert("RGB"),
        session=session,
        alpha_matting=True,                       # estimate true foreground -> removes teal spill
        alpha_matting_foreground_threshold=240,
        alpha_matting_background_threshold=15,
        alpha_matting_erode_size=8,
        post_process_mask=True,
    )


def autocrop(cut, thresh=8, pad_px=0, pad_frac=0.0):
    """Trim transparent margin to the item, then add a transparent border. bbox is taken
    over alpha > thresh (ignores near-invisible matting noise). Padding = pad_px plus
    pad_frac of the item's larger side (proportional -> even framing across item sizes)."""
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


def to_webp(cut, quality=QUALITY):
    buf = io.BytesIO()
    cut.save(buf, format="WEBP", quality=quality, method=6)
    return buf.getvalue()


def process(img, session, pad_frac=PAD_PCT, quality=QUALITY):
    """Full production pass: teal image bytes/PIL -> transparent, tight, padded WebP bytes."""
    cut = autocrop(strip(img, session), pad_frac=pad_frac)
    return to_webp(cut, quality), cut.size
