#!/usr/bin/env bash
# Installe ou met à jour Vigil comme service systemd.
#   sudo bash install.sh                  # port 5080, données dans /var/lib/vigil
#   sudo bash install.sh --port 8080 --data /srv/vigil
# La configuration (/etc/vigil/vigil.json) et les données existantes sont conservées.
set -euo pipefail

PORT=5080
DATA=/var/lib/vigil
PREFIX=/opt/vigil
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --data) DATA="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    *) echo "Option inconnue : $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Lancez le script avec sudo : sudo bash install.sh" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null; then
  echo "systemd est requis. Sans systemd, utilisez l'image Docker (voir README)." >&2
  exit 1
fi

SRC="$(cd "$(dirname "$0")" && pwd)"
if systemctl is-active --quiet vigil 2>/dev/null; then
  echo "-> Arrêt de la version en cours"
  systemctl stop vigil
fi

echo "-> Copie dans $PREFIX"
mkdir -p "$PREFIX"
install -m 755 "$SRC/vigil" "$PREFIX/vigil"
install -m 644 "$SRC/appsettings.json" "$PREFIX/appsettings.json"

exec "$PREFIX/vigil" install --port "$PORT" --data "$DATA"
