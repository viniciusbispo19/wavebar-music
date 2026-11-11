#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Vinicius Bispo
# Encerra o Shell aninhado aberto pelo dev-nested.sh.
# Procura só processos chamados exatamente "gnome-shell" com --devkit ou
# --headless nos argumentos — nunca o Shell da sua sessão real.

BUS_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/wavebar-music/nested-bus"

for pid in $(pgrep -x gnome-shell); do
    if tr '\0' ' ' < "/proc/$pid/cmdline" | grep -qE -- '--devkit|--headless'; then
        kill "$pid"
        for _ in $(seq 50); do
            [ -d "/proc/$pid" ] || break
            sleep 0.2
        done
        echo "Shell aninhado encerrado (PID $pid)."
    fi
done
rm -f "$BUS_FILE"

# A ponte MPRIS (scripts/mpris-bridge.js) fica presa ao barramento antigo:
# encerramos também. ("[m]pris" evita o pkill casar com o próprio comando.)
pkill -f "[m]pris-bridge.js" && echo "Ponte MPRIS encerrada." || true
