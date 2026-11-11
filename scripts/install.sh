#!/usr/bin/env bash
# Empacota e instala a extensão em ~/.local/share/gnome-shell/extensions/.
#
# Por que não um link simbólico para a pasta do projeto? Um
# `gnome-extensions install --force` posterior apagaria o destino do link —
# ou seja, o código-fonte. Copiar via pacote é mais seguro e testa
# exatamente o que será publicado.
#
# No Wayland o Shell em execução NÃO recarrega o código de uma extensão:
# teste numa sessão aninhada (scripts/dev-nested.sh) ou faça logout/login.

set -euo pipefail
cd "$(dirname "$0")/.."

./scripts/build.sh
gnome-extensions install --force build/wavebar@vinicius.shell-extension.zip
echo "Instalado em ~/.local/share/gnome-shell/extensions/wavebar@vinicius"
