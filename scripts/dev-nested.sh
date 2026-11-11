#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Vinicius Bispo
# Abre um GNOME Shell 51 "aninhado" (numa janela do mutter-devkit), já com a
# Wavebar Music instalada e ativada.
#
# Uso:
#   ./scripts/dev-nested.sh              # janela 1600x1000
#   ./scripts/dev-nested.sh 1920x1200    # outro tamanho
#   HEADLESS=1 ./scripts/dev-nested.sh   # sem janela (monitor virtual), p/ testes automáticos
#
# Isolamento:
#   - dbus-run-session cria um D-Bus só desse Shell. Players da sua sessão real
#     NÃO aparecem lá dentro: use scripts/fake-player.js (ou nested-run.sh).
#   - O dconf é uma CÓPIA (~/.config/dconf/wavebar_music_dev, via DCONF_PROFILE):
#     mesmo tema e extensões, mas nada que mude lá dentro vaza para cá.
#     A cópia e as escritas acontecem DENTRO do barramento aninhado, porque cada
#     barramento tem seu próprio dconf-service e eles se sobrescreveriam.

set -euo pipefail
cd "$(dirname "$0")/.."

SIZE="${1:-1600x1000}"
UUID=wavebar-music@vinicius
DEVTOOLS_UUID=wavebar-music-devtools@vinicius
DEV_DB=wavebar_music_dev  # sem hífen: vira parte de um caminho D-Bus

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wavebar-music"
mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/nested-$(date +%Y%m%d-%H%M%S).log"
BUS_FILE="$STATE_DIR/nested-bus"
DCONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dconf"

# 1. Instala a versão atual do código e a extensão auxiliar.
./scripts/install.sh
gnome-extensions pack --force --out-dir=build "dev/$DEVTOOLS_UUID" >/dev/null
gnome-extensions install --force "build/$DEVTOOLS_UUID.shell-extension.zip"

# 2. dconf isolado + Shell aninhado.
printf 'user-db:%s\n' "$DEV_DB" > "$STATE_DIR/dconf-profile"
export DCONF_PROFILE="$STATE_DIR/dconf-profile"
export DCONF_DIR DEV_DB UUID DEVTOOLS_UUID
export WAVEBAR_MUSIC_DEV=1                       # libera o modo inseguro (devtools)
export SHELL_DEBUG=backtrace-warnings      # avisos vêm com a pilha JS

if [ "${HEADLESS:-0}" = 1 ]; then
    SHELL_ARGS="--headless --wayland --virtual-monitor $SIZE"
else
    SHELL_ARGS="--devkit --wayland --devkit-args=--monitor-size=$SIZE"
fi

echo "Log desta sessão: $LOG"
echo "Feche a janela do devkit (ou Ctrl+C aqui) para encerrar."

RUN_ID="$$-$RANDOM"
trap 'grep -q -- "#$RUN_ID\$" "$BUS_FILE" 2>/dev/null && rm -f "$BUS_FILE"' EXIT
dbus-run-session -- bash -c '
    set -e
    cp "$DCONF_DIR/user" "$DCONF_DIR/$DEV_DB"
    python3 -I scripts/dconf-enable-extensions.py "$UUID" "$DEVTOOLS_UUID"
    echo "$DBUS_SESSION_BUS_ADDRESS#$2" > "$1"
    exec gnome-shell $3
' _ "$BUS_FILE" "$RUN_ID" "$SHELL_ARGS" 2>&1 | tee "$LOG"
