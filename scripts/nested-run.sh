#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Vinicius Bispo
# Roda um comando DENTRO do D-Bus da sessão aninhada.
# Exemplo: ./scripts/nested-run.sh gjs -m scripts/fake-player.js
#          ./scripts/nested-run.sh mpv --no-video musica.mp3

set -euo pipefail
BUS_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/wavebar-music/nested-bus"
[ -s "$BUS_FILE" ] || { echo "Sessão aninhada não está rodando (rode scripts/dev-nested.sh)." >&2; exit 1; }

DBUS_SESSION_BUS_ADDRESS="$(cut -d"#" -f1 "$BUS_FILE")" exec "$@"
