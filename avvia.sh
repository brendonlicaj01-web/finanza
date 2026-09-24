#!/usr/bin/env bash
# Avvia Finanza: installa le dipendenze se servono e apre l'app nel browser.
set -e
cd "$(dirname "$0")"

URL="http://localhost:3210"

open_browser() {
  if command -v open >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1
  else echo "Apri nel browser: $1"; fi
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js non è installato. Scaricalo da https://nodejs.org (versione LTS) e riprova."
  open_browser "https://nodejs.org"
  read -r -p "Premi Invio per chiudere..." _
  exit 1
fi

# Se l'app è già in esecuzione, basta aprire il browser.
if curl -s -o /dev/null "$URL" 2>/dev/null; then
  echo "Finanza è già avviata: apro $URL"
  open_browser "$URL"
  exit 0
fi

# Installa le dipendenze al primo avvio o quando sono cambiate.
if [ ! -d node_modules ] || ! cmp -s package-lock.json node_modules/.finanza-lock; then
  echo "Installo le dipendenze (solo la prima volta o dopo un aggiornamento)..."
  npm install --no-audit --no-fund
  cp package-lock.json node_modules/.finanza-lock
fi

echo ""
echo "Finanza si sta avviando su $URL"
echo "Lascia aperta questa finestra mentre usi l'app; chiudila (o premi Ctrl+C) per fermarla."
echo ""
npm run dev
