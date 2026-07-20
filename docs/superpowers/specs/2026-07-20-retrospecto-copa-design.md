# Retrospecto da Copa — Wrapped pessoal do Bolão

**Data:** 2026-07-20
**Status:** aprovado (aguardando revisão da spec)

## 1. Objetivo

Quando a Copa encerra, dar a cada participante um **retrospecto pessoal estilo "Spotify
Wrapped"**: uma sequência de slides em tela cheia que revela, um a um, os melhores (e piores)
momentos da *sua* Copa, terminando na colocação final. É celebração + diversão em cima de
dados que já existem — não um recurso de análise.

Não-objetivos (v1): superlativos de grupo, ver o retrospecto dos outros, exportar imagem.

## 2. Princípios de arquitetura

- **Zero endpoint novo.** Todos os dados já vêm do `GET /api/estado`. Isso é obrigatório: o
  projeto está no limite de 12 serverless functions (Hobby) — nada de banco/API nova.
- **Cálculo puro e testável.** A lógica de derivar os momentos vive em `src/ranking.js` como
  função pura, no mesmo espírito das funções que já estão lá (`calcularDetalhamento`,
  `calcularEvolucao`, `calcularStats`). O componente React só renderiza.
- **Reaproveitar o que existe.** `GraficoTrajetoria` (SVG), confete, e o padrão visual de
  banner/modal do Campeão do Bolão.
- **Slides resilientes.** Um slide do meio só aparece se o momento existir. Quem quase não
  palpitou vê um Wrapped curto e honesto, sem card vazio/triste.

## 3. Dados disponíveis (já no `estado` / `palpitesMap`)

- `estado.jogos`: `{ id, casa, fora, kickoff, gh, ga, fase, peso, live }`
- `palpitesMap[jogoId][participanteId]`: `{ h, a, atualizado_em }` — **de todos** (após kickoff)
- `estado.participantes`: `{ id, nome, avatarEmoji, avatarCor }`
- `estado.antecedenciaMedia`: `[{ participante_id, segundos }]`
- `estado.resultadoEspecial`: `{ campeao: {valor,confirmado}, artilheiro: {valor,confirmado} }`
- Funções prontas em `ranking.js`: `calcularDetalhamento`, `calcularEvolucao`,
  `calcularStats`, `calcularBonus`, `compararRanking`, `pontosDoPalpite`, `pontosComPeso`,
  `pesoDoJogo`, `temPlacar`, constantes `PTS_EXATO`, `PTS_RESULTADO`, `BONUS_*`.

## 4. Gatilho "Copa encerrada"

`copaEncerrada` = **todos os jogos com placar final** (`jogos.length > 0` e todo jogo tem
`gh != null && ga != null && !live`) **E** o campeão do bônus confirmado
(`estado.resultadoEspecial.campeao?.confirmado === true`).

É exatamente quando o ranking congela e o `BannerCampeaoBolao` já aparece. **Na
implementação, reusar o mesmo sinal que já dispara o banner do Campeão do Bolão** (a condição
que produz a lista `campeoes`), pra não ter duas definições de "acabou" divergentes.

## 5. Pontos de entrada (UI)

- **Header** (`src/App.jsx` ~L434): quando `copaEncerrada`, o eyebrow
  `COPA DO MUNDO · 2026` passa a `COPA DO MUNDO · 2026 · ENCERRADA` (o "· ENCERRADA" com
  realce âmbar).
- **Banner de entrada**: um componente `BannerRetrospecto` (mesmo padrão visual do
  `BannerCampeaoBolao`), texto **"🎬 Ver meu retrospecto"**, clicável, renderizado junto do
  banner do Campeão do Bolão quando `copaEncerrada`. Abre o `RetrospectoCopa` do usuário
  logado (`estado.eu.id`).
- **Borda:** admin-mestre (`estado.eu.id === null`, o "Organizador" de bootstrap) não tem
  palpites → o banner **não** aparece pra ele.

## 6. Conteúdo — os 7 slides

A ordem sobe até o clímax. `[C]` = condicional (pula se não houver substância);
`[S]` = sempre aparece.

1. **[S] Capa — "A sua Copa 2026"**
   Avatar + nome + contadores ("N palpites em M jogos"). Um **selo de persona** derivado da
   antecedência média (`estado.antecedenciaMedia`):
   - `>= 12h` (43200s) antes do kickoff, em média → **"O Precavido"**
   - `<= 2h` (7200s) → **"O Afobado"**
   - entre os dois → **"O Equilibrado"**
   - sem dado → sem selo.

2. **[S] 🎯 Cravadas**
   `acertosExatos` (de `calcularDetalhamento`). Se 0: variante gentil — *"Nenhuma cravada,
   mas você acertou o resultado X vezes"* (`acertosResult`).

3. **[C] 🚀 Sua maior arrancada**
   Agrupa `porJogo` (com `ptsPeso`) pela **data local** do `kickoff`; soma os pontos por dia;
   escolhe o dia de maior total. Card: "+Y pts na noite de <data>". Pula se o melhor dia = 0.

4. **[C] 💎 Coragem premiada** (palpite na contramão que deu certo)
   Entre os jogos em que o participante **pontuou** (`pts >= PTS_RESULTADO`), para cada um
   conta quantos **outros** participantes fizeram o **mesmo palpite exato `(h,a)`**
   (`sameCount`) e quantos palpitaram o jogo (`totalG`). Escolhe o "mais corajoso":
   menor `sameCount`, desempate por ter sido exato. **Inclui o slide só se**
   `sameCount <= 2` **e** `totalG >= 4` (precisa de plateia pra ir contra). Card: "No X×Y
   você cravou N×M e foi 1 de só (sameCount+1) que apostou nisso." (Limiares ajustáveis;
   estes são os defaults.)

5. **[C] ⚖️ O melhor e o pior**
   Dois painéis num card. **Melhor** = `detalhamento.melhor` (maior `ptsPeso`), mostrado só
   se `ptsPeso > 0`. **Pior** = menor `ptsPeso` entre `comPalpite` (um erro = 0). Se não
   houver nenhum com `pts > 0`, mostra só o pior com copy leve. Pula o card inteiro se a
   pessoa não palpitou nenhum jogo encerrado.

6. **[C] 📈 Sua escalada**
   `calcularEvolucao` → `GraficoTrajetoria`. Pula se `evolucao.length < 2` (o componente já
   retorna null nesse caso).

7. **[S] 🏅 Onde você terminou**
   Clímax. Calcula o ranking final (`calcularStats` + `compararRanking`, **mesma lógica do
   app**) → posição, total de participantes, pontos. Faixas de bônus se
   `acertouCampeao` / `acertouArtilheiro`. Confete. Trata empate ("empatado em Nº").
   Dica discreta no rodapé: "📸 tira um print e manda no grupo".

## 7. Estrutura técnica

### `src/ranking.js` — nova função pura
```
calcularMomentos(participanteId, estado, palpitesMap) → {
  persona,        // { chave: 'precavido'|'afobado'|'equilibrado'|null, label }
  apostasFeitas, jogosContados,
  cravadas,       // { exatos, resultados }
  arrancada,      // { dataLabel, pts, nJogos } | null
  coragem,        // { jogo, meuPalpite, sameCount, totalG, exato } | null
  melhorPior,     // { melhor|null, pior|null }
  evolucao,       // resultado de calcularEvolucao (array)
  final,          // { pos, total, empatado, pontos, acertouCampeao, acertouArtilheiro }
}
```
Reusa `calcularDetalhamento`, `calcularEvolucao`, `calcularStats`, `calcularBonus`,
`compararRanking`. Precisa de um helper de **data local** (chave YYYY-MM-DD do kickoff) — usar
o mesmo `chaveData` que o App.jsx já usa (passar como opção ou extrair pra util
compartilhada).

### `src/App.jsx` — componentes novos
- `BannerRetrospecto({ onAbrir })` — botão-banner (espelha `BannerCampeaoBolao`).
- `RetrospectoCopa({ participanteId, estado, palpitesMap, onFechar })` — overlay tela cheia:
  - monta `momentos` e a **lista de slides existentes** (filtra os `[C]` vazios);
  - estado `idx`; navegação: toque na metade direita / swipe ← = próximo; metade esquerda /
    swipe → = anterior; botão ✕ e tecla `Esc` fecham;
  - **barra de progresso** segmentada (um traço por slide);
  - animação de entrada por card (reusa classes `entra-*`);
  - respeita `prefers-reduced-motion` (sem confete/animação pesada);
  - slide final dispara confete.
- Sub-componentes de slide (um por tipo) — pequenos e focados.
- Estado `abrirRetrospecto` + o eyebrow condicional no header.

## 8. Casos de borda

- `estado.eu.id === null` (admin-mestre) → banner escondido.
- 0 palpites → só capa + final.
- Empate na colocação final → "empatado em Nº".
- Todos os jogos no mesmo dia → arrancada = a Copa toda (ok).
- `prefers-reduced-motion` → animações/confete reduzidos.

## 9. Testes

- Unitários em `src/ranking.test.mjs` para `calcularMomentos`:
  - agrupamento da arrancada (maior dia vence; empate; dia único);
  - seleção da coragem (menor `sameCount`, desempate por exato, limiar de inclusão);
  - limiares de persona (precavido/afobado/equilibrado/sem dado);
  - fallbacks de dados vazios (0 palpites → só capa+final; 0 exatos → variante).
- `RetrospectoCopa` é visual: verificação manual (build + abrir com a Copa marcada como
  encerrada; navegar slides; testar 1 participante com muitos dados e 1 quase vazio).

## 10. Fora de escopo (v1)

Exportar/compartilhar imagem, superlativos de grupo, ver retrospecto de outros. O último
slide sugere print manual como ponte.
