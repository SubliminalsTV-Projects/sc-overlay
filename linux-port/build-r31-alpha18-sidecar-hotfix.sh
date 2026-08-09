#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESOLVER="$ROOT/linux-port/alpha18-resolve-conflicts.py"
BACKUP="${RUNNER_TEMP:-/tmp}/alpha18-resolver-before-sidecar-hotfix.py"
cp "$RESOLVER" "$BACKUP"
trap 'cp "$BACKUP" "$RESOLVER" 2>/dev/null || true' EXIT

# Patch the merge resolver before the normal Alpha 18 build consumes it. Upstream 0.1.41 changed
# startServer() from a locally-opened `fd` to sidecarLogStream(). The three-way merge retained the
# call but lost the helper definition, and also retained Alpha17's now-invalid fs.closeSync(fd).
python3 - "$RESOLVER" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
anchor = 'main.write_text(s)'
if anchor not in s:
    raise SystemExit('sidecar hotfix: resolver main-write anchor missing')
patch = r'''# Restore upstream 0.1.41's sidecar log stream helper. The Alpha17/0.1.41 merge retained
# startServer()'s `const out = sidecarLogStream()` but dropped this definition.
_sidecar_decl = 'let sidecarLogOpened = false;\n'
_sidecar_helper = ''' + repr('''function sidecarLogStream() {
  try {
    fs.mkdirSync(path.dirname(SIDECAR_LOG), { recursive: true });
    // Truncate once per app launch, then append across sidecar respawns so the crash that caused a
    // restart is not erased by the restart itself.
    const fd = fs.openSync(SIDECAR_LOG, sidecarLogOpened ? "a" : "w");
    sidecarLogOpened = true;
    return fd;
  } catch (e) {
    console.error("[electron] could not open the sidecar log:", String(e));
    return "ignore";
  }
}

''') + r'''
if 'function sidecarLogStream()' not in s:
    if _sidecar_decl not in s:
        raise SystemExit('main: sidecarLogOpened insertion anchor missing')
    s = s.replace(_sidecar_decl, _sidecar_decl + _sidecar_helper, 1)

# Alpha17 opened `fd` inline and closed it after spawn. 0.1.41 replaced that local with `out`, so
# carrying this old close forward creates a second ReferenceError immediately after the helper fix.
_bad_close = ''' + repr('''      windowsHide: true,
    });
    fs.closeSync(fd);
  } else {
''') + r'''
_good_close = ''' + repr('''      windowsHide: true,
    });
  } else {
''') + r'''
if _bad_close in s:
    s = s.replace(_bad_close, _good_close, 1)
if 'fs.closeSync(fd);' in s:
    raise SystemExit('main: stale fs.closeSync(fd) survived sidecar repair')
if 'function sidecarLogStream()' not in s or 'const out = sidecarLogStream();' not in s:
    raise SystemExit('main: sidecar log helper/call contract incomplete after repair')
main.write_text(s)'''
s = s.replace(anchor, patch, 1)
p.write_text(s)
PY

bash "$ROOT/linux-port/build-r31-alpha18-resolved.sh" "$@"

WORK="${RUNNER_TEMP:-/tmp}/r31-alpha18-build/work"
MAIN="$WORK/electron/main.cjs"
[[ -f "$MAIN" ]] || { echo '[alpha18-sidecar] generated main.cjs not found' >&2; exit 31; }
node --check "$MAIN"
grep -q '^function sidecarLogStream()' "$MAIN"
grep -q 'const out = sidecarLogStream();' "$MAIN"
if grep -q 'fs.closeSync(fd);' "$MAIN"; then
  echo '[alpha18-sidecar] stale undefined fd close found in generated main.cjs' >&2
  exit 32
fi

# Verify the archive itself, not only the staging tree, so a packaging path mistake cannot reintroduce
# the exact runtime failure the user saw.
TAR="${RUNNER_TEMP:-/tmp}/dist/ArchVerse-Overlay-0.1.41-r31-alpha.18-arch.tar.gz"
PKG_MAIN="${RUNNER_TEMP:-/tmp}/alpha18-packaged-main.cjs"
[[ -f "$TAR" ]] || { echo '[alpha18-sidecar] packaged tarball missing' >&2; exit 33; }
tar -xOf "$TAR" 'ArchVerse-Overlay-0.1.41-r31-alpha.18/app/electron/main.cjs' > "$PKG_MAIN"
node --check "$PKG_MAIN"
grep -q '^function sidecarLogStream()' "$PKG_MAIN"
grep -q 'const out = sidecarLogStream();' "$PKG_MAIN"
if grep -q 'fs.closeSync(fd);' "$PKG_MAIN"; then
  echo '[alpha18-sidecar] stale undefined fd close found in packaged main.cjs' >&2
  exit 34
fi
echo '[alpha18-sidecar] production sidecar startup contract verified in staged tree and package.'
