#!/usr/bin/env bash
# Teste de robustez/vazamentos no Shell aninhado (precisa do dev-nested.sh rodando).
#
# O que verifica:
#   - ativar/desativar N vezes (padrão 8) com o card ABERTO e letras sendo
#     baixadas (parte dos ciclos desativa no meio da requisição);
#   - nenhum ator Wavebar* sobra no palco; nenhum menu sobra no painel;
#   - nenhum timer GLib criado pela Wavebar continua vivo após o disable()
#     (o teste intercepta GLib.timeout_add/source_remove durante a execução);
#   - bloquear a tela (modo unlock-dialog) desativa e desbloquear reativa;
#   - nenhuma linha nova de erro/aviso no log vinda da Wavebar.
#
# Uso: ./scripts/nested-test.sh [ciclos]

set -euo pipefail
cd "$(dirname "$0")/.."

CYCLES="${1:-8}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wavebar"
LOG=$(ls -t "$STATE_DIR"/nested-*.log | head -1)
BEFORE=$(wc -l < "$LOG")

# Dois players de teste (se ainda não estiverem rodando).
for spec in "wavebar_fake" "wavebar_fake2 --identity Segundo --paused --track 1"; do
    name=${spec%% *}
    if ! ./scripts/nested-run.sh gdbus call --session -d org.freedesktop.DBus \
        -o /org/freedesktop/DBus -m org.freedesktop.DBus.NameHasOwner \
        "org.mpris.MediaPlayer2.$name" | grep -q true; then
        # shellcheck disable=SC2086
        ./scripts/nested-run.sh gjs -m scripts/fake-player.js --name $spec \
            > "$STATE_DIR/$name.out" 2>&1 &
    fi
done
sleep 2

EVAL_TIMEOUT=120 ./scripts/nested-eval.sh "(async () => {
  const {default: GLib} = await import('gi://GLib');
  const {default: Gio} = await import('gi://Gio');
  const uuid = 'wavebar@vinicius', m = Main.extensionManager;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ind = () => Main.panel.statusArea[uuid];

  // Conta atores cujas classes GObject registramos (GTypeName Wavebar*).
  const countOurs = a => (a.constructor.\$gtype?.name?.startsWith('Wavebar') ? 1 : 0) +
    a.get_children().reduce((n, c) => n + countOurs(c), 0);
  const snap = () => ({
    estado: m.lookup(uuid).state,
    erro: m.lookup(uuid).error || null,
    atores: countOurs(global.stage),
    menus: Main.panel.menuManager._menus.length,
    noPainel: !!ind(),
  });
  // Apaga o cache de letras em disco para forçar requisições de rede.
  const clearLyrics = () => {
    const dir = Gio.File.new_for_path(GLib.get_user_cache_dir() + '/wavebar/lyrics');
    try {
      const en = dir.enumerate_children('standard::name', 0, null);
      let info;
      while ((info = en.next_file(null)))
        dir.get_child(info.get_name()).delete(null);
    } catch {}
  };

  // Rastreia timers criados por código da Wavebar.
  const live = new Map();
  let created = 0;
  const origAdd = GLib.timeout_add, origRemove = GLib.source_remove;
  GLib.timeout_add = function (prio, ms, fn, ...rest) {
    // (sem barras invertidas: o gdbus reinterpretaria os escapes)
    const where = new Error().stack.split(String.fromCharCode(10)).find(l => l.includes(uuid));
    let id = 0;
    id = origAdd.call(GLib, prio, ms, (...args) => {
      const ret = fn(...args);
      if (ret !== true)
        live.delete(id);
      return ret;
    }, ...rest);
    if (where)
      created++;
    if (where)
      live.set(id, where.slice(where.indexOf('extensions/') + 11));
    return id;
  };
  GLib.source_remove = function (id) {
    live.delete(id);
    return origRemove.call(GLib, id);
  };

  try {
    await wait(1500);
    const antes = snap();
    for (let i = 0; i < ${CYCLES}; i++) {
      m.disableExtension(uuid); await wait(100);
      clearLyrics();
      m.enableExtension(uuid); await wait(1000); // players ficam prontos (D-Bus assíncrono)
      ind()?.menu.open(false);
      // Ciclos ímpares desativam no meio da busca da letra (300 ms de espera + rede).
      await wait(i % 2 ? 450 : 1500);
    }
    const depois = snap();
    m.disableExtension(uuid); await wait(400);
    const desativada = {...snap(), timersCriados: created, timersVivos: [...live.values()]};
    m.enableExtension(uuid); await wait(1200);
    Main.sessionMode.pushMode('unlock-dialog'); await wait(500);
    const bloqueada = snap();
    Main.sessionMode.popMode('unlock-dialog'); await wait(1200);
    const desbloqueada = snap();
    return {antes, depois, desativada, bloqueada, desbloqueada};
  } finally {
    GLib.timeout_add = origAdd;
    GLib.source_remove = origRemove;
  }
})()" | sed "s/^(true, '//; s/')\$//" | python3 -I -c '
import json, sys
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except json.JSONDecodeError:
    print("Falha no Eval:", raw); sys.exit(1)
print(json.dumps(data, indent=1, ensure_ascii=False))
a, d, off = data["antes"], data["depois"], data["desativada"]
checks = {
    "ativa e sem erro após os ciclos": d["estado"] == 1 and not d["erro"],
    "nenhum menu sobrando no painel": d["menus"] == a["menus"],
    "nenhum ator Wavebar sobrando após os ciclos": d["atores"] == a["atores"],
    "desativar remove todos os atores Wavebar": off["atores"] == 0 and not off["noPainel"],
    "rastreador viu timers da Wavebar (teste válido)": off["timersCriados"] > 0,
    "desativar não deixa timers vivos": off["timersVivos"] == [],
    "bloquear a tela desativa (sem atores)": data["bloqueada"]["atores"] == 0,
    "desbloquear reativa": data["desbloqueada"]["noPainel"] and data["desbloqueada"]["estado"] == 1,
}
for name, ok in checks.items():
    print(("  ✓ " if ok else "  ✗ ") + name)
print("RESULTADO:", "OK" if all(checks.values()) else "FALHOU")
'

echo "--- avisos/erros novos no log vindos da Wavebar:"
tail -n +$((BEFORE + 1)) "$LOG" | python3 -I -c '
import re, sys
blocks, cur = [], []
for line in sys.stdin.read().splitlines():
    if re.search(r"(CRITICAL|WARNING|ERROR) \*\*|JS ERROR|\[Wavebar\]", line):
        if cur: blocks.append(cur)
        cur = [line]
    elif cur and line.strip():
        cur.append(line)
    elif cur:
        blocks.append(cur); cur = []
if cur: blocks.append(cur)
ours = [b for b in blocks if any("wavebar@" in l or "[Wavebar]" in l for l in b)]
for b in ours:
    print("\n".join(b[:6])); print()
if not ours:
    print("(nenhum)")
print(f"(outros avisos novos no log, de outras extensões/do Shell: {len(blocks) - len(ours)})")
'
