#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 4:
    raise SystemExit("usage: alpha18-lexical-fixes.py WORK_DIR UPSTREAM_DIR ALPHA17_APP_DIR")
work = Path(sys.argv[1])
cap = work / "electron/capture.cjs"
s = cap.read_text()

# The released Alpha17 capture segment can contain this generated wrapper form even though the
# source implementation simply forwards `options`. Its OCR_NATIVE_ENV declaration lives outside
# the segment we semantically import, so carrying only the call creates an undefined identifier.
# Spectacle passes its own sanitized env through options, and RapidOCR is now a separate worker,
# therefore forwarding options is both sufficient and the coherent contract here.
s = s.replace('execFile(command, args, { env: OCR_NATIVE_ENV, ...options }, (err, stdout, stderr) => {',
              'execFile(command, args, options, (err, stdout, stderr) => {', 1)
if 'OCR_NATIVE_ENV' in s:
    raise SystemExit("lexical repair: orphaned OCR_NATIVE_ENV survived")
cap.write_text(s)
print("[alpha18-lexical] orphaned binding repair PASS")
