#!/usr/bin/env bash
# Reinicia o Shell aninhado em segundo plano (reinstalando a extensão) e só
# termina quando o Shell NOVO responder pelo D-Bus.
# Ciclo típico: ./scripts/nested-restart.sh && ./scripts/nested-test.sh
# Saída do dev-nested.sh: ~/.local/state/wavebar/nested-run.out

set -euo pipefail
cd "$(dirname "$0")/.."

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wavebar"
mkdir -p "$STATE_DIR"

./scripts/nested-stop.sh
nohup ./scripts/dev-nested.sh "$@" > "$STATE_DIR/nested-run.out" 2>&1 &

for _ in $(seq 90); do
    if ./scripts/nested-eval.sh '1' 2>/dev/null | grep -q '^(true'; then
        echo "Shell aninhado pronto."
        exit 0
    fi
    sleep 1
done
echo "O Shell aninhado não respondeu em 90 s. Veja $STATE_DIR/nested-run.out" >&2
exit 1
