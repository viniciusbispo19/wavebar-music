# Wavebar

Controle de mídia universal para o painel do GNOME Shell 51.

- Funciona com **qualquer player MPRIS**: Spotify, Firefox, Chrome, VLC, mpv (com `mpv-mpris`), Rhythmbox…
- Ícone em forma de **pílula com 3 barrinhas** que animam enquanto algo toca. Ele só aparece quando há um player ativo.
- O card abre ao clicar no ícone e mostra a capa, o título, o artista, o player, a **letra sincronizada**, a **onda de progresso** (clique ou arraste para pular) e os controles.
- Com vários players, use as setas ao lado do nome do player para alternar. Clicar no nome traz a janela do player para a frente.

As letras vêm do [LRCLIB](https://lrclib.net).

## Instalação

```bash
./scripts/install.sh
```

Isso empacota a extensão com `gnome-extensions pack` e a instala em `~/.local/share/gnome-shell/extensions/wavebar@vinicius/`.

No **Wayland** o Shell só carrega código novo de extensão depois de um **logout/login**. Depois do login, ative a extensão:

```bash
gnome-extensions enable wavebar@vinicius
```

## Testar sem sair da sessão

A sessão aninhada roda um segundo GNOME Shell numa janela, com D-Bus e dconf próprios: nada do que você muda lá dentro vaza para a sua sessão.

```bash
./scripts/dev-nested.sh                 # abre a janela do devkit (Ctrl+C encerra)
HEADLESS=1 ./scripts/dev-nested.sh      # sem janela, para testes automáticos
```

Como o D-Bus é separado, **os players da sua sessão real não aparecem lá dentro**. Use o player falso:

```bash
./scripts/nested-run.sh gjs -m scripts/fake-player.js
./scripts/nested-run.sh gjs -m scripts/fake-player.js --name vlc --identity VLC --desktop-entry vlc --paused
```

Ou rode um player de verdade no D-Bus aninhado (`--aout=dummy` evita sair som):

```bash
./scripts/nested-run.sh cvlc --aout=dummy musica.flac
```

Outras ferramentas, todas com a sessão aninhada rodando:

| Script | Para quê |
|---|---|
| `scripts/nested-restart.sh` | Reinstala e reinicia a sessão aninhada em segundo plano |
| `scripts/nested-eval.sh 'código'` | Roda JavaScript dentro do Shell aninhado |
| `scripts/nested-screenshot.sh [png]` | Tira um print do Shell aninhado |
| `scripts/nested-test.sh [ciclos]` | Testa robustez e vazamentos: ativar/desativar com o card aberto, timers, bloqueio de tela |
| `scripts/nested-stop.sh` | Encerra a sessão aninhada |

`Eval` e `Screenshot` funcionam porque a extensão auxiliar `dev/wavebar-devtools@vinicius` liga o *unsafe mode*. Ela faz isso **só** quando `WAVEBAR_DEV=1`, variável que apenas o `dev-nested.sh` define, e nunca é publicada.

Testes da lógica pura (parser LRC, onda, cache), sem precisar do Shell:

```bash
gjs -m tests/run.js
```

## Estrutura

```
extension.js          monta/desmonta tudo (enable/disable)
lib/mpris.js          players MPRIS via D-Bus (NameOwnerChanged, PropertiesChanged, Seeked)
lib/panelIndicator.js botão do painel + ícone de equalizador (Cairo + Clutter.Timeline)
lib/playerCard.js     card vertical (capa, info, letra, onda, controles)
lib/waveform.js       onda de progresso com seek (Cairo + Clutter.PanGesture)
lib/coverArt.js       capas file:// / data: / http(s) → arquivo local
lib/lyrics.js         cliente LRCLIB (Soup 3) com cache
lib/lrc.js, util.js   funções puras (testáveis com gjs)
lib/cache.js          cache LRU em memória e pasta de cache com limite
```

## Solução de problemas

**Ver os logs**

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i wavebar
```

**O ícone não aparece.** Ele só aparece com um player *ativo*, ou seja, tocando, pausado ou com faixa carregada. Para ver o que está no D-Bus:

```bash
gdbus call --session -d org.freedesktop.DBus -o /org/freedesktop/DBus \
    -m org.freedesktop.DBus.ListNames | tr ',' '\n' | grep mpris
```

**O player aparece duas vezes.** O `playerctld` já é ignorado. Se outro "espelho" de MPRIS aparecer duplicado, abra uma issue com o nome que ele usa no barramento.

**O mpv não aparece.** O mpv não tem MPRIS nativo. Instale o plugin `mpv-mpris`.

**A letra não aparece ou está fora de sincronia.** O LRCLIB precisa da duração certa da faixa, com tolerância de ±3 s. Versões ao vivo e remasterizações costumam ter outra duração. Títulos com "(Official Video)" e afins são limpos automaticamente. Para forçar uma nova busca, apague o cache:

```bash
rm -rf ~/.cache/wavebar/lyrics
```

**A barra de progresso não deixa pular.** O player informou `CanSeek = false`, ou não informou a duração da faixa. Isso é comum em transmissões ao vivo.

**A posição "pula" de vez em quando.** Pela especificação MPRIS, a posição não é avisada continuamente. A Wavebar estima a posição localmente e confere com o player a cada ~3 s. Alguns players respondem com atraso.

## Privacidade

- Para buscar letras, a Wavebar envia ao `lrclib.net` o **título, o artista, o álbum e a duração** da faixa que está tocando. Nada mais: o User-Agent é genérico (`Wavebar/0.1`).
- As capas vindas de `http(s)` são baixadas do endereço que o próprio player informou.
- O cache fica em `~/.cache/wavebar/`, com no máximo 300 capas e 1000 letras. Pode apagar quando quiser.
