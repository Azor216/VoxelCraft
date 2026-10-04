#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Pro LAN je potřeba Node.js 20 nebo novější: https://nodejs.org/"
  read -r _
  exit 1
fi
if [ ! -f node_modules/ws/package.json ]; then
  echo "Instaluji LAN komponenty..."
  npm install || exit 1
fi
OPEN_BROWSER=1 node server.js
