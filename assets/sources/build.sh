#!/usr/bin/env bash
# Regenerate the promo PNGs from the HTML sources next to this script.
# Requires Google Chrome on macOS.
set -euo pipefail

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSETS="$(dirname "$HERE")"

render() {
  local size="$1" w="$2" h="$3"
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --default-background-color=00000000 \
    --window-size="$w","$h" \
    --screenshot="$ASSETS/promo-${size}.png" \
    "file://$HERE/promo-${size}.html"
}

render 1400x560 1400 560
render 440x280 440 280

echo "Regenerated promo-1400x560.png and promo-440x280.png in $ASSETS"
