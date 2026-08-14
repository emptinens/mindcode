#!/bin/sh
# §13.4: generate and (optionally) sign SHA256SUMS for the dist/ artifacts,
# and verify them with `--verify`. Signing happens only when MINDCODE_GPG_KEY
# is set, so unsigned local builds still produce a checksum manifest.
set -eu

cd "$(dirname "$0")/.."

DIST="dist"
if [ "${1:-}" = "--verify" ]; then
    if [ ! -f "$DIST/SHA256SUMS" ]; then
        echo "missing $DIST/SHA256SUMS (run scripts/checksum-release.sh first)" >&2
        exit 1
    fi
    ( cd "$DIST" && sha256sum -c SHA256SUMS )
    exit $?
fi

if [ ! -d "$DIST" ]; then
    echo "missing $DIST (run scripts/build-native-release.sh first)" >&2
    exit 1
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
( cd "$DIST" && find . -maxdepth 1 -type f ! -name 'SHA256SUMS*' -print0 \
    | sort -z | xargs -0 sha256sum ) > "$tmp"

mv "$tmp" "$DIST/SHA256SUMS"

if [ -n "${MINDCODE_GPG_KEY:-}" ]; then
    gpg --yes --armor --local-user "$MINDCODE_GPG_KEY" \
        --detach-sign "$DIST/SHA256SUMS"
    echo "wrote $DIST/SHA256SUMS and $DIST/SHA256SUMS.asc (key $MINDCODE_GPG_KEY)"
else
    echo "wrote $DIST/SHA256SUMS (unsigned; set MINDCODE_GPG_KEY to sign)"
fi
