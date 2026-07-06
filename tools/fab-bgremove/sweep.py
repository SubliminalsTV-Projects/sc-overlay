#!/usr/bin/env python3
"""VPS sweep daemon — auto-strips the teal background from newly-captured fabricator images.

The desktop tracker uploads crops as teal `image/jpeg`; this loop finds those rows, runs the
same rembg pass as the CLI (core.process), and UPDATEs the row to a transparent `image/webp`.
The content_type IS the processed-flag (jpeg = todo, webp = done) → idempotent, no schema change.

Env: DATABASE_URL (required), SWEEP_INTERVAL seconds (default 120)."""
import io
import os
import time

import psycopg
from PIL import Image
from rembg import new_session

from core import MAX_BYTES, process

DB = os.environ["DATABASE_URL"]
INTERVAL = int(os.environ.get("SWEEP_INTERVAL", "120"))
SESSION = new_session("u2net")


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def sweep():
    with psycopg.connect(DB) as conn:
        rows = conn.execute(
            "SELECT item, bytes FROM site.bp_fab_images WHERE content_type = 'image/jpeg'"
        ).fetchall()
        done = 0
        for item, data in rows:
            try:
                webp, size = process(Image.open(io.BytesIO(bytes(data))), SESSION)
                if len(webp) > MAX_BYTES:
                    log(item, "SKIP oversize", len(webp))
                    continue
                conn.execute(
                    "UPDATE site.bp_fab_images SET bytes = %s, content_type = 'image/webp' WHERE item = %s",
                    (webp, item),
                )
                conn.commit()
                done += 1
                log(item, "->", f"{size[0]}x{size[1]}", f"{len(webp) // 1024}KB")
            except Exception as e:  # noqa: BLE001 - log and keep going
                conn.rollback()
                log(item, "ERROR", repr(e))
        return done


def main():
    log(f"fab-bgremove sweep started (interval {INTERVAL}s)")
    while True:
        try:
            n = sweep()
            if n:
                log(f"cycle processed {n}")
        except Exception as e:  # noqa: BLE001 - survive DB blips
            log("sweep cycle error", repr(e))
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
