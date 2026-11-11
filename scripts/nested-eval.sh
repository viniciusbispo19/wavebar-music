#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Vinicius Bispo
# Executa JavaScript DENTRO do Shell aninhado (precisa do dev-nested.sh rodando).
# Exemplo: ./scripts/nested-eval.sh 'Main.panel.statusArea["wavebar@vinicius"].visible'
# Resposta: (true, '<JSON>') ou (false, '<erro>').
# EVAL_TIMEOUT=segundos aumenta o limite do gdbus (padrão 25 s).
# Evite barras invertidas no código: o gdbus reinterpreta os escapes.

set -euo pipefail
BUS_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/wavebar/nested-bus"
[ -s "$BUS_FILE" ] || { echo "Sessão aninhada não está rodando (rode scripts/dev-nested.sh)." >&2; exit 1; }

DBUS_SESSION_BUS_ADDRESS="$(cut -d"#" -f1 "$BUS_FILE")" gdbus call --session \
    --timeout "${EVAL_TIMEOUT:-25}" \
    --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval "$1"
