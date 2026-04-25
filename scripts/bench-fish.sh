#!/usr/bin/env bash
# Apples-to-apples Fish Audio TTS latency probe. Bypasses our Hono proxy
# and the browser, so what's left is pure: TLS handshake + Fish server
# processing + chunked body delivery.
#
# Usage:
#   FISH_AUDIO_API_KEY=... ./scripts/bench-fish.sh
#   FISH_AUDIO_API_KEY=... ./scripts/bench-fish.sh "你好，今天怎么样？" 5471293d1e3e448bb53c2c0a6f514af5
#
# Reads three timing numbers per call:
#   - time_appconnect = TLS handshake done
#   - time_starttransfer = first byte from Fish (THIS is the TTFB number
#     we care about — should be ~100-300ms per Fish's claims)
#   - time_total = full response received
#
# We run the call 3 times so you can see whether the first one's slow
# from cold-connect TLS while subsequent ones are warm. If even the
# warm calls are 4s, the issue is Fish's processing or transcontinental
# round-trip, not our app.

set -euo pipefail

if [ -z "${FISH_AUDIO_API_KEY:-}" ]; then
  if [ -f .env ]; then
    # Pull the key out of .env without sourcing the whole file (safer).
    FISH_AUDIO_API_KEY=$(grep -E '^FISH_AUDIO_API_KEY=' .env | cut -d= -f2- | tr -d '"' || true)
  fi
fi

if [ -z "${FISH_AUDIO_API_KEY:-}" ]; then
  echo "FISH_AUDIO_API_KEY not set (and not in .env). Aborting." >&2
  exit 1
fi

TEXT="${1:-Hello, this is a quick latency probe.}"
# Default to Caleb's reference id from src/vrm/presets/mika.ts. Override
# with arg 2 if you want to test Ani / Shiro.
REFERENCE_ID="${2:-5471293d1e3e448bb53c2c0a6f514af5}"

PAYLOAD=$(cat <<EOF
{
  "text": $(printf '%s' "$TEXT" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),
  "reference_id": "$REFERENCE_ID",
  "format": "mp3",
  "sample_rate": 44100,
  "mp3_bitrate": 128,
  "latency": "low",
  "chunk_length": 100,
  "min_chunk_length": 0
}
EOF
)

echo "== Fish Audio S2 TTS latency probe =="
echo "  endpoint: https://api.fish.audio/v1/tts"
echo "  text:     $TEXT"
echo "  voice:    $REFERENCE_ID"
echo

for i in 1 2 3; do
  echo "-- run $i --"
  curl -sS -X POST https://api.fish.audio/v1/tts \
    -H "Authorization: Bearer $FISH_AUDIO_API_KEY" \
    -H "Content-Type: application/json" \
    -H "model: s2-pro" \
    -d "$PAYLOAD" \
    --output "/tmp/fish-bench-$i.mp3" \
    -w "  dns:           %{time_namelookup}s\n  tcp_connect:   %{time_connect}s\n  tls_handshake: %{time_appconnect}s\n  ttfb:          %{time_starttransfer}s\n  total:         %{time_total}s\n  bytes:         %{size_download}\n  http_status:   %{http_code}\n"
  echo
done

echo "Saved audio to /tmp/fish-bench-{1,2,3}.mp3 — play one to sanity-check the voice."
