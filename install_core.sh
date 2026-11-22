#!/usr/bin/env bash
set -e

DEST_DIR="${1:-$HOME/.local/share/quick-vpn/bin}"
mkdir -p "$DEST_DIR"

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  MIHOMO_ARCH="linux-amd64-compatible" ;;
  aarch64) MIHOMO_ARCH="linux-arm64" ;;
  *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

echo "Checking latest Mihomo core release..."
LATEST_TAG=$(curl -sL https://api.github.com/repos/MetaCubeX/mihomo/releases/latest | grep '"tag_name":' | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/')
if [ -z "$LATEST_TAG" ]; then
  LATEST_TAG="v1.19.34"
fi

DOWNLOAD_URL="https://github.com/MetaCubeX/mihomo/releases/download/${LATEST_TAG}/mihomo-${MIHOMO_ARCH}-${LATEST_TAG}.gz"
echo "Downloading Mihomo ${LATEST_TAG} (${ARCH})..."
curl -sL "$DOWNLOAD_URL" | gzip -d > "${DEST_DIR}/mihomo"
chmod +x "${DEST_DIR}/mihomo"

echo "Downloading GeoIP and GeoSite databases..."
curl -sL "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.metadb" -o "${DEST_DIR}/geoip.metadb" || true
curl -sL "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat" -o "${DEST_DIR}/GeoSite.dat" || true
curl -sL "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat" -o "${DEST_DIR}/GeoIP.dat" || true

echo "Mihomo core installed successfully to: ${DEST_DIR}"
"${DEST_DIR}/mihomo" -v
