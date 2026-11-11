#!/usr/bin/env bash
# Gera o pacote .zip da extensão em build/ com a ferramenta OFICIAL
# (`gnome-extensions pack`) — o mesmo formato aceito pelo extensions.gnome.org.
#
# O pack inclui sozinho: metadata.json, extension.js e stylesheet.css.
# Todo o resto precisa ser listado com --extra-source.

set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p build
gnome-extensions pack --force --out-dir=build \
    --extra-source=lib \
    --extra-source=README.md \
    .
echo "Pacote: build/wavebar@vinicius.shell-extension.zip"
