# fab-bgremove

Offline batch tool that strips the teal Fabrication-Kiosk background from captured item
crops and produces **transparent WebP** renders for the `/blueprints` catalog.

Not part of the desktop app — the tracker stays zero-dep and uploads teal JPEGs; this is a
separate ops step (Python + a local `rembg` u2net model, no API keys). The teal originals in
`%APPDATA%/sc-blueprint-tracker/fab-shots` remain the source of truth.

## Setup (Python 3.10)

```
uv venv -p 3.10 .venv
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
```

First run downloads the u2net weights (~170 MB) to `~/.u2net`.

## Use

```
# process only (inspect before publishing)
.venv/Scripts/python.exe bgremove.py --in <teal-crops-dir> --out out

# process + publish to the site
.venv/Scripts/python.exe bgremove.py --in <teal-crops-dir> --out out --upload --token scbp_...
```

Input: `<uuid>.jpg|png|webp` teal crops. Output: `<uuid>.webp` with alpha.

- `--erode N` — extra alpha shave (px) if a teal halo survives (default 0; alpha matting
  usually handles it). Keep small — large values eat thin geometry (weapon barrels).
- `--quality` — WebP quality (default 90). Output must stay under the 600 KB ingest cap.

## Replacing images already on the site

The ingest is **first-wins** (`ON CONFLICT DO NOTHING`), so an upload for an item that
already has an image is silently ignored (`stored=false`). To replace, delete the row first,
then upload:

```
ssh vps "docker exec -i te7082rmeabjlnwzimhtdg9h psql -U tsadmin -d subliminal \
  -c \"DELETE FROM site.bp_fab_images WHERE item IN ('<uuid>', ...);\""
```

(Timescale container / creds per the dev-subliminal-gg skill.)
