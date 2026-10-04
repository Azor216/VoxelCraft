#!/bin/sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR"
if [ ! -f "$APP_DIR/server.js" ]; then
  APP_DIR="$HOME/Library/Application Support/VoxelFrontierLAN"
  ARCHIVE="${TMPDIR:-/tmp}/voxel-frontier-$$.zip"
  UNPACK="${TMPDIR:-/tmp}/voxel-frontier-$$"
  echo "Připravuji Voxel Frontier LAN..."
  mkdir -p "$APP_DIR" "$UNPACK" || exit 1
  curl -fL "https://github.com/Azor216/VoxelCraft/archive/refs/heads/master.zip" -o "$ARCHIVE" || exit 1
  unzip -q "$ARCHIVE" -d "$UNPACK" || exit 1
  cp "$UNPACK/VoxelCraft-master/index.html" "$UNPACK/VoxelCraft-master/server.js" "$UNPACK/VoxelCraft-master/package.json" "$UNPACK/VoxelCraft-master/package-lock.json" "$APP_DIR/" || exit 1
  rm -f "$ARCHIVE"
  rm -rf "$UNPACK"
fi
cd "$APP_DIR" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Pro LAN je potřeba Node.js 20 nebo novější: https://nodejs.org/"
  open "https://nodejs.org/"
  read -r _
  exit 1
fi
if [ ! -f node_modules/ws/package.json ]; then
  echo "Instaluji LAN komponenty..."
  npm install || exit 1
fi
OPEN_BROWSER=1 node server.js
