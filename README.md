# Wavebar Music

Controle de mídia universal para o painel do GNOME Shell 51.

- Funciona com **qualquer player MPRIS**. Foi testada com Spotify, Deezer, YouTube Music Desktop, Firefox, Brave, Vivaldi (e outros navegadores Chromium) e VLC.
- Ícone em forma de **pílula com 3 barrinhas** que animam enquanto algo toca. Ele só aparece quando há um player ativo.
- **Clique esquerdo** no ícone: pausa o que estiver tocando, em qualquer player (se houver vários tocando, pausa todos). Se nada estiver tocando, retoma o último player usado.
- **Clique direito** no ícone (ou Enter/Espaço com o ícone focado): abre o card com a capa, o título, o artista, o player, a **letra com rolagem automática**, a **onda de progresso** (clique ou arraste para pular) e os controles.
- Botões **Aleatório** (à esquerda) e **Repetir** (à direita) no card. O Repetir alterna entre não repetir, repetir a lista e repetir a música. Ligados, ficam na cor de destaque. Aparecem quando o player oferece a opção: Spotify, Deezer e VLC têm; navegadores não. Se o player só oferece um dos dois, o outro lado fica vazio para o play/pause continuar centralizado.
- **Tema claro e escuro**, com integração ao **Blur my Shell**.
- Com vários players, use as setas ao lado do nome do player para alternar. Clicar no nome traz a janela do player para a frente.

As letras vêm do [LRCLIB](https://lrclib.net).

## Instalação

```bash
./scripts/install.sh
```

Isso empacota a extensão com `gnome-extensions pack` e a instala em `~/.local/share/gnome-shell/extensions/wavebar-music@vinicius/`.

No **Wayland** o Shell só carrega código novo de extensão depois de um **logout/login**. Depois do login, ative a extensão:

```bash
gnome-extensions enable wavebar-music@vinicius
```

Preferências: app **Extensões** → Wavebar Music → ⚙. A janela tem duas páginas: **Geral** (tema, Blur my Shell, cache) e **Sobre mim** (o autor e os outros projetos dele). Também abre com:

```bash
gnome-extensions prefs wavebar-music@vinicius
```

## Aparência

| Opção | O que faz |
|---|---|
| **Tema do card: Automático** | Segue o Blur my Shell, se ele estiver desfocando menus. Senão, segue o tema claro/escuro do GNOME. |
| **Tema do card: Escuro / Claro** | Força o tema. Com o Blur my Shell ativo, o desfoque continua por trás e o card ganha um "vidro" na cor escolhida. |
| **Integrar com o Blur my Shell** | Usa o fundo desfocado, o estilo de popups (claro, escuro ou transparente) e o raio dos cantos configurados nele. A capa acompanha o raio, para os cantos ficarem concêntricos. |

O ícone do painel herda a cor do texto do painel, então funciona também com o painel transparente do Blur my Shell.

## Letras

- **Letra sincronizada:** a linha atual fica destacada e centralizada. Se você rolar com o mouse, a rolagem automática pausa e volta sozinha para a linha atual depois de ~3 s.
- **Letra sem sincronia:** rola sozinha, proporcionalmente ao tempo da música.
- **Vídeos de navegador** como "Artista - Música (Official Video)", "Vídeo oficial" ou canais "VEVO"/"- Topic" são limpos antes da busca e na exibição.
- **Clipes com introdução:** se a duração do vídeo não bate com a da música, a letra aparece sem sincronia, porque a sincronia ficaria errada.

## Particularidades dos players (tratadas)

| Player | Comportamento | Como a Wavebar Music lida |
|---|---|---|
| Spotify | Demora 1–2 s para atualizar status e posição. Às vezes manda `Metadata` vazio entre faixas. Não avisa (`Seeked`) quando "anterior" reinicia a faixa. | Play/pause e seek otimistas, o `Metadata` vazio é ignorado e a posição é relida após ⏮/⏭. |
| Navegadores Chromium (Brave, Vivaldi, Chrome) | Sem `DesktopEntry`. Capa em arquivo temporário sem extensão. | O app é achado pelo processo (PID) ou pelo `StartupWMClass`. A capa carrega normalmente. |
| Apps Electron (YouTube Music, Deezer…) | Registram-se como `chromium.instanceN`. | O app é identificado pela `Identity` (e não pelo nome "chromium"). |
| Deezer (Flatpak) | Informa `DesktopEntry=deezer-desktop`, mas o app é `dev.aunetx.deezer`. | Busca por ID do app instalado. |
| Firefox | `Identity` = "Mozilla org.mozilla.firefox". | Usa o `DesktopEntry`. |

## Testar sem sair da sessão

A sessão aninhada roda um segundo GNOME Shell numa janela, com D-Bus e dconf próprios: nada do que você muda lá dentro vaza para a sua sessão.

```bash
./scripts/dev-nested.sh                 # abre a janela do devkit (Ctrl+C encerra)
HEADLESS=1 ./scripts/dev-nested.sh      # sem janela, para testes automáticos
```

**Players de verdade na sessão de teste.** A ponte MPRIS espelha os seus players (Spotify, navegadores…) dentro da sessão aninhada. Comandos dados lá controlam os players reais.

```bash
HEADLESS=1 BRIDGE=1 ./scripts/nested-restart.sh   # reinicia a sessão de teste já com a ponte
gjs -m scripts/mpris-bridge.js                    # ou só a ponte, com a sessão já aberta
```

**Diagnóstico direto na sua sessão.** Só leitura: mostra metadados, se a posição estimada bate com a real, a capa e a letra de cada player aberto.

```bash
gjs -m scripts/probe-players.js
```

**Player falso.** Útil para reproduzir um caso exato:

```bash
./scripts/nested-run.sh gjs -m scripts/fake-player.js
./scripts/nested-run.sh gjs -m scripts/fake-player.js --name deezer --identity Deezer \
    --desktop-entry deezer-desktop --title 'No Role Modelz' --artist 'J. Cole' --length 292
```

Outras ferramentas, todas com a sessão aninhada rodando:

| Script | Para quê |
|---|---|
| `scripts/nested-eval.sh 'código'` | Roda JavaScript dentro do Shell aninhado |
| `scripts/nested-screenshot.sh [png]` | Tira um print do Shell aninhado |
| `scripts/nested-test.sh [ciclos]` | Testa robustez e vazamentos: ativar/desativar com o card aberto, timers, bloqueio de tela |
| `scripts/nested-stop.sh` | Encerra a sessão aninhada e a ponte |

`Eval` e `Screenshot` funcionam porque a extensão auxiliar `dev/wavebar-music-devtools@vinicius` liga o *unsafe mode*. Ela faz isso **só** quando `WAVEBAR_MUSIC_DEV=1`, variável que apenas o `dev-nested.sh` define, e nunca é publicada.

Testes da lógica pura (parser LRC, limpeza de títulos, onda, cache), sem precisar do Shell:

```bash
gjs -m tests/run.js
```

## Estrutura

```
extension.js          monta/desmonta tudo (enable/disable)
prefs.js              preferências: páginas "Geral" e "Sobre mim" (GTK 4 + libadwaita)
lib/mpris.js          players MPRIS via D-Bus (sem dependência do Shell), repetição (LoopStatus) e aleatório (Shuffle)
lib/appLookup.js      descobre o app (.desktop) de cada player
lib/appearance.js     tema claro/escuro + integração com o Blur my Shell
lib/panelIndicator.js botão do painel + ícone de equalizador (Cairo + Clutter.Timeline)
lib/playerCard.js     card vertical (capa, info, letra, onda, controles)
lib/waveform.js       onda de progresso com seek (Cairo + Clutter.PanGesture)
lib/coverArt.js       capas file:// / data: / http(s) → arquivo local
lib/lyrics.js         cliente LRCLIB (Soup 3) com cache
lib/lrc.js, util.js   funções puras (testáveis com gjs)
lib/cache.js          cache LRU em memória e pasta de cache com limite
schemas/              configurações (GSettings)
```

## Solução de problemas

**Ver os logs**

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i wavebar-music
```

**O ícone não aparece.** Ele só aparece com um player *ativo*, ou seja, tocando, pausado ou com faixa carregada. Apps Electron (Deezer, YouTube Music) só publicam MPRIS depois que algo começa a tocar. Para ver o que está no D-Bus:

```bash
gdbus call --session -d org.freedesktop.DBus -o /org/freedesktop/DBus \
    -m org.freedesktop.DBus.ListNames | tr ',' '\n' | grep mpris
```

**Apps Flatpak não abrem ("Can't find source path /run/user/1000/doc").** O portal de documentos perdeu a montagem. Reinicie o serviço:

```bash
systemctl --user restart xdg-document-portal.service
```

**O player aparece duas vezes.** O `playerctld` já é ignorado. Se outro "espelho" de MPRIS aparecer duplicado, abra uma issue com o nome que ele usa no barramento.

**O mpv não aparece.** O mpv não tem MPRIS nativo. Instale o plugin `mpv-mpris`.

**A letra não aparece.** Nem toda música está no LRCLIB (é um banco colaborativo). Para forçar uma nova busca, use **Preferências → Limpar** ou:

```bash
rm -rf ~/.cache/wavebar-music/lyrics
```

**A barra de progresso não deixa pular.** O player informou `CanSeek = false`, ou não informou a duração da faixa. Isso é comum em transmissões ao vivo.

## Privacidade

- Para buscar letras, a Wavebar Music envia ao `lrclib.net` o **título, o artista, o álbum e a duração** da faixa que está tocando. Nada mais: o User-Agent é genérico (`WavebarMusic/0.4`).
- As capas vindas de `http(s)` são baixadas do endereço que o próprio player informou.
- O cache fica em `~/.cache/wavebar-music/`, com no máximo 300 capas e 1000 letras.

## Licença

Copyright (C) 2026 Vinicius Bispo.

A Wavebar Music é software livre: você pode redistribuí-la e/ou modificá-la sob os termos da **GNU General Public License**, versão 3 ou (a seu critério) qualquer versão posterior, publicada pela Free Software Foundation. Veja o arquivo [LICENSE](LICENSE).
