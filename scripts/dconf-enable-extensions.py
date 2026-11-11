#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Vinicius Bispo
"""Ativa extensões no dconf em uso (respeita DCONF_PROFILE).

Uso interno do scripts/dev-nested.sh: roda DENTRO do barramento da sessão
aninhada, antes do Shell subir.

Uso: dconf-enable-extensions.py UUID [UUID...]
"""
import ast
import subprocess
import sys


def gsettings(*args):
    return subprocess.check_output(['gsettings', *args], text=True, timeout=10).strip()


def get_list(key):
    out = gsettings('get', 'org.gnome.shell', key)
    return [] if out.startswith('@as') else ast.literal_eval(out)


def set_list(key, values):
    gsettings('set', 'org.gnome.shell', key, str(values))


ours = sys.argv[1:]
enabled = get_list('enabled-extensions')
set_list('enabled-extensions', enabled + [u for u in ours if u not in enabled])
set_list('disabled-extensions', [u for u in get_list('disabled-extensions') if u not in ours])
gsettings('set', 'org.gnome.shell', 'disable-user-extensions', 'false')
