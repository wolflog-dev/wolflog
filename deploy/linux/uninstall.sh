#!/usr/bin/env bash
# Supprime le service. Les données (/var/lib/vigil) et la configuration (/etc/vigil) sont conservées.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Lancez avec sudo." >&2; exit 1; }
/opt/vigil/vigil uninstall
rm -rf /opt/vigil
echo "Pour tout effacer : sudo rm -rf /var/lib/vigil /etc/vigil && sudo userdel vigil"
