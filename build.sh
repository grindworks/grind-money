#!/bin/bash
# Build styles.css from input.css with the pinned Tailwind CSS standalone binary.
# The binary for this OS/CPU is downloaded on first run and verified against the pinned SHA-256.
set -euo pipefail
cd "$(dirname "$0")"

TAILWIND_VERSION="4.3.1"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)          ASSET="tailwindcss-macos-arm64";     SHA256="a27c43626185953ee19bdace1939c7601e55da654e0b2fc4461e3e29957aa739" ;;
  Darwin-x86_64)         ASSET="tailwindcss-macos-x64";       SHA256="e9e830ceb3e70b7e0775a3dd79eee8ec82c6b31270f08f2fa2857d0077045ac3" ;;
  Linux-x86_64)          ASSET="tailwindcss-linux-x64";       SHA256="2526d063ba03b71f9a3ea7d5cee14f0aec147f117f222d5adc97b1d736d45999" ;;
  Linux-aarch64|Linux-arm64) ASSET="tailwindcss-linux-arm64"; SHA256="3d662377a86d71c43b549dc06b90db4586b4acd412bf827a3268e951661e5adf" ;;
  MINGW*-x86_64|MSYS*-x86_64|CYGWIN*-x86_64) ASSET="tailwindcss-windows-x64.exe"; SHA256="dc4fd46acd354d976df2a31b6425fbe865a38229a06bc005a4c59f2b3d24ab4a" ;;
  *) echo "Unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

BINARY="./${ASSET}"
if [ ! -f "$BINARY" ] || [ "$(sha256_of "$BINARY")" != "$SHA256" ]; then
  echo "Downloading Tailwind CSS v${TAILWIND_VERSION} (${ASSET})..."
  curl -fsSL -o "${BINARY}.download" "https://github.com/tailwindlabs/tailwindcss/releases/download/v${TAILWIND_VERSION}/${ASSET}"
  if [ "$(sha256_of "${BINARY}.download")" != "$SHA256" ]; then
    rm -f "${BINARY}.download"
    echo "Checksum mismatch for ${ASSET}; aborting." >&2
    exit 1
  fi
  mv "${BINARY}.download" "$BINARY"
  chmod +x "$BINARY"
fi

"$BINARY" -i ./input.css -o ./styles.css --minify
