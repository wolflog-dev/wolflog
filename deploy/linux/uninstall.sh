#!/usr/bin/env bash
# Supprime le service. Les données (/var/lib/wolflog) et la configuration (/etc/wolflog) sont conservées.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Lancez avec sudo." >&2; exit 1; }
/opt/wolflog/wolflog uninstall
rm -rf /opt/wolflog
echo "Pour tout effacer : sudo rm -rf /var/lib/wolflog /etc/wolflog && sudo userdel wolflog"
