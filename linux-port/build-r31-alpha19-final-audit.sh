#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$ROOT/linux-port/build-r31-alpha18.sh"
CONFIG_REPAIR="$ROOT/linux-port/alpha18-config-contract-fixes.py"
CHAT_POLICY="$ROOT/linux-port/alpha19-chat-location-policy.py"
BACKUP="${RUNNER_TEMP:-/tmp}/alpha19-base-backup.sh"
cp "$BASE" "$BACKUP"
trap 'cp "$BACKUP" "$BASE" 2>/dev/null || true' EXIT

# Reuse the audited semantic-reconstruction machinery, but point the authoritative upstream side
# at 0.1.42 and label/package the result as Alpha 19. Keeping the same temporary work-root lets
# the mature Alpha 18 runtime audits inspect the reconstructed files while we add Alpha 19-specific
# security gates on top.
python3 - "$BASE" "$CONFIG_REPAIR" "$CHAT_POLICY" <<'PY'
from pathlib import Path
import shlex, sys
p=Path(sys.argv[1]); config=Path(sys.argv[2]).resolve(); chat=Path(sys.argv[3]).resolve(); s=p.read_text()

repls = [
    ('VERSION="0.1.41-r31-alpha.18"', 'VERSION="0.1.42-r31-alpha.19"'),
    ('UP_DIR="$TMP_ROOT/upstream-0.1.41"', 'UP_DIR="$TMP_ROOT/upstream-0.1.42"'),
    ('--branch v0.1.41 ', '--branch v0.1.42 '),
    ('upstream 0.1.41', 'upstream 0.1.42'),
    ('0.1.41-r31-alpha.18', '0.1.42-r31-alpha.19'),
    ('0.1.41-r31 Alpha 18', '0.1.42-r31 Alpha 19'),
    ('0.1.41-r31 alpha 18', '0.1.42-r31 alpha 19'),
    ('0.1.41-r31-alpha18', '0.1.42-r31-alpha19'),
    ('r31 alpha 18', 'r31 alpha 19'),
    ('r31-alpha18', 'r31-alpha19'),
    ('SC Overlay 0.1.41', 'SC Overlay 0.1.42'),
    ('through SC Overlay 0.1.41', 'through SC Overlay 0.1.42'),
    ('onto upstream 0.1.41', 'onto upstream 0.1.42'),
    ('All upstream changes through 0.1.41', 'All upstream changes through 0.1.42'),
]
for old,new in repls:
    s=s.replace(old,new)

# Replace the custom changelog card with an Alpha 19 security-focused card. Upstream's own 0.1.42
# changelog remains in the file as well.
s=s.replace('"0.1.41-r31-alpha.18": entry', '"0.1.42-r31-alpha.19": entry')
s=s.replace('"label":"Upstream 0.1.41 integrated"', '"label":"Upstream 0.1.42 security release integrated"')
s=s.replace('Includes every upstream change through SC Overlay 0.1.42: the 0.1.40 mining pipeline rebuild, mission fixes, current settings/setup work, social Chat, and the 0.1.41 sidecar/package optimizations.',
'''Includes every upstream change through SC Overlay 0.1.42, including the critical port-8778 path-traversal/config-write/origin protections, Chat privacy hardening, private rooms/DMs, mission fixes, and mining false-signature refusal.''')

# The Alpha 18 final wrapper used a temporary pre-0.1.42 chat hardening patch. Do NOT apply it here:
# 0.1.42 is authoritative for those fixes. We only keep ArchVerse's stricter location-room trust
# boundary while CIG has no sanctioned location-attestation API.
anchor='python3 - "$WORK_DIR/overlay/changelog.json" "$A17/app/server/overlay/changelog.json" <<\'PY\''
insert=(
    f'python3 {shlex.quote(str(config))} "$WORK_DIR"\n'
    f'python3 {shlex.quote(str(chat))} "$WORK_DIR"\n\n'
    + anchor
)
if anchor not in s:
    raise SystemExit('alpha19 wrapper: changelog insertion anchor missing')
s=s.replace(anchor, insert, 1)

# Upgrade the README wording that survived the generic replacements.
s=s.replace('including the 0.1.40 mining scanner overhaul.',
'''including 0.1.42's critical local-sidecar security fixes, Chat hardening/features, mission fixes, and mining signature validation.''')
s=s.replace('Social Chat with Global / Server / Shard channels and verified RSI identity gate.',
'''Social Chat with Global, verified organisation/custom/private/DM features; ArchVerse keeps automatic location rooms quarantined pending trustworthy server-side attestation.''')
s=s.replace('Keep Alpha 17 available as the immediate rollback point while testing.',
'''Keep the last known-good ArchVerse build available as the immediate rollback point while testing.''')

p.write_text(s)
PY

# The audited build chain performs semantic reconstruction of main/capture/preload, TypeScript,
# upstream tests, packaging, and native-dependency retry. Publication is handled by a separate,
# disabled-by-default Alpha 19 workflow.
exec bash "$ROOT/linux-port/build-r31-alpha18-ci.sh" "$@"
