# Retrospecto da Copa — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar a cada participante um retrospecto pessoal estilo "Wrapped" (slides em tela cheia) que abre quando a Copa encerra, revelando seus melhores/piores momentos até a colocação final.

**Architecture:** Toda a lógica de derivar os "momentos" é uma função pura nova em `src/ranking.js` (`calcularMomentos`), testada no harness existente (`node src/ranking.test.mjs`). A UI é um componente novo (`RetrospectoCopa`) + um banner de entrada (`BannerRetrospecto`) em `src/App.jsx`, reaproveitando `Avatar`, `GraficoTrajetoria`, `ConfeteCampeao` e o sinal `bolaoEncerrado` que já existe. Nenhum endpoint/tabela nova.

**Tech Stack:** React (hooks por nome, sem `React.`), Vite, SVG inline, CSS global no componente `Estilo()`. Testes = asserts em Node puro.

## Global Constraints

- **Zero endpoint novo / zero tabela nova.** Projeto no limite de 12 serverless functions (Hobby). Todos os dados já vêm de `GET /api/estado`.
- **Lógica pura em `src/ranking.js`**, componente em `src/App.jsx` — mesma divisão do resto do código.
- **Copy em pt-BR.**
- **"Copa encerrada" = a variável `bolaoEncerrado` já existente** (`src/App.jsx:379` = campeão E artilheiro confirmados). Não criar outra definição.
- **CSS global** vai dentro do `<style>` do componente `Estilo()` (`src/App.jsx:4208`), junto dos estilos `.campeao-bolao-*`/`.banner-campeao-bolao` (~L5041).
- **Hooks importados por nome** (`useState`, `useEffect`, `useRef`, `useMemo`) — o arquivo já usa esse estilo. Adicionar `useMemo`/`useRef` ao import do React se faltarem.
- Rodar `npm test` (não pode quebrar) e `npm run build` (tem que passar) nas tarefas indicadas.

---

### Task 1: `calcularMomentos` — núcleo (persona, cravadas, melhor/pior, evolução, final)

**Files:**
- Modify: `src/ranking.js` (adicionar função exportada no fim do arquivo)
- Test: `src/ranking.test.mjs` (adicionar bloco de teste no fim)

**Interfaces:**
- Consumes: `calcularDetalhamento`, `calcularEvolucao`, `calcularStats`, `compararRanking` (já em `ranking.js`, mesmo módulo — sem import).
- Produces: `calcularMomentos(participanteId, estado, palpitesMap, opts = {})` → objeto:
  ```
  {
    persona: { chave: 'precavido'|'afobado'|'equilibrado'|null, label: string|null },
    apostasFeitas: number,
    jogosContados: number,
    cravadas: { exatos: number, resultados: number },
    arrancada: null,   // preenchido na Task 2
    coragem: null,     // preenchido na Task 3
    melhorPior: { melhor: {jogo,palpite,pts,ptsPeso}|null, pior: {jogo,palpite,pts,ptsPeso}|null },
    evolucao: Array<{jogo,pts,acumulado}>,
    final: { pos:number, total:number, empatado:boolean, pontos:number, acertouCampeao:boolean, acertouArtilheiro:boolean } | null
  }
  ```
  `opts.chaveData(iso)` só é usado na Task 2; aceitar já aqui na assinatura.

- [ ] **Step 1: Escrever o teste que falha**

Adicionar no FIM de `src/ranking.test.mjs` (antes da linha final de resumo/`process.exit`, se houver; senão no fim):

```js
/* ---- calcularMomentos: retrospecto pessoal ---- */
{
  const chaveDataM = (iso) => (iso ? iso.slice(0, 10) : "__semdata__");
  const estadoM = {
    participantes: [
      { id: 1, nome: "Ana" }, { id: 2, nome: "Bruno" },
      { id: 3, nome: "Caio" }, { id: 4, nome: "Duda" },
    ],
    jogos: [
      { id: 10, casa: "BRA", fora: "ARG", kickoff: "2026-06-14T18:00:00Z", gh: 2, ga: 1, live: false, peso: 1 },
      { id: 11, casa: "FRA", fora: "ESP", kickoff: "2026-06-14T21:00:00Z", gh: 0, ga: 0, live: false, peso: 1 },
      { id: 12, casa: "ITA", fora: "POR", kickoff: "2026-06-15T18:00:00Z", gh: 3, ga: 0, live: false, peso: 3 },
      { id: 13, casa: "ALE", fora: "URU", kickoff: "2026-06-16T18:00:00Z", gh: 1, ga: 1, live: false, peso: 1 },
      { id: 14, casa: "ENG", fora: "NED", kickoff: "2026-06-15T21:00:00Z", gh: 2, ga: 1, live: false, peso: 1 },
    ],
    resultadoEspecial: { campeao: { confirmado: true, valor: "BRA" }, artilheiro: { confirmado: true } },
    palpitesCampeao: [ { participante_id: 1, selecao: "BRA" } ],
    premiadosArtilheiro: [],
    antecedenciaMedia: [
      { participante_id: 1, segundos: 50000 }, // Ana: precavido (>=43200)
      { participante_id: 2, segundos: 3000 },  // Bruno: afobado (<=7200)
      { participante_id: 3, segundos: 20000 }, // Caio: equilibrado
      // Duda: sem dado
    ],
  };
  const palM = {
    10: { 1: { h: 2, a: 1 }, 2: { h: 1, a: 0 }, 3: { h: 0, a: 2 } },
    11: { 1: { h: 0, a: 0 }, 2: { h: 1, a: 1 } },
    12: { 1: { h: 3, a: 0 }, 2: { h: 2, a: 0 }, 3: { h: 1, a: 0 }, 4: { h: 0, a: 1 } },
    13: { 1: { h: 2, a: 0 }, 2: { h: 1, a: 1 } },
    14: { 1: { h: 2, a: 0 }, 2: { h: 1, a: 1 }, 3: { h: 3, a: 3 }, 4: { h: 0, a: 2 } },
  };
  const mAna = calcularMomentos(1, estadoM, palM, { chaveData: chaveDataM });
  check(mAna.persona.chave === "precavido", `Ana persona deveria ser precavido, veio ${mAna.persona.chave}`);
  check(calcularMomentos(2, estadoM, palM, { chaveData: chaveDataM }).persona.chave === "afobado", "Bruno = afobado");
  check(calcularMomentos(3, estadoM, palM, { chaveData: chaveDataM }).persona.chave === "equilibrado", "Caio = equilibrado");
  check(calcularMomentos(4, estadoM, palM, { chaveData: chaveDataM }).persona.chave === null, "Duda sem antecedência = null");
  check(mAna.cravadas.exatos === 3, `Ana exatos deveria ser 3, veio ${mAna.cravadas.exatos}`);
  check(mAna.cravadas.resultados === 1, `Ana resultados deveria ser 1, veio ${mAna.cravadas.resultados}`);
  check(mAna.melhorPior.melhor && mAna.melhorPior.melhor.jogo.id === 12, "melhor = jogo 12 (peso 3, exato = 9)");
  check(mAna.melhorPior.pior && mAna.melhorPior.pior.jogo.id === 13, "pior = jogo 13 (erro)");
  check(mAna.evolucao.length === 5, `evolução deveria ter 5 jogos, veio ${mAna.evolucao.length}`);
  check(mAna.final && mAna.final.pos === 1, "Ana termina em 1º");
  check(mAna.final.total === 4, "total de 4 participantes");
  check(mAna.final.acertouCampeao === true, "Ana acertou a campeã (bônus)");
  const mDuda = calcularMomentos(4, estadoM, palM, { chaveData: chaveDataM });
  check(mDuda.melhorPior.melhor === null, "Duda sem acerto positivo → melhor null");
  check(mDuda.cravadas.exatos === 0, "Duda 0 exatos");
}
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — `calcularMomentos is not defined` (ou `is not a function`).

- [ ] **Step 3: Implementar `calcularMomentos` (núcleo)**

Adicionar no FIM de `src/ranking.js`:

```js
/* Momentos do "Retrospecto da Copa" (Wrapped pessoal) de UM participante.
   Função pura: recebe o estado e o mapa de palpites, devolve os dados de cada
   slide. arrancada/coragem são preenchidos nas etapas 2 e 3.
   opts.chaveData(iso) → chave de dia local (para agrupar a arrancada). */
export function calcularMomentos(participanteId, estado, palpitesMap, opts = {}) {
  const d = calcularDetalhamento(participanteId, estado, palpitesMap);

  // Persona pela antecedência média (segundos antes do kickoff).
  const seg = (estado.antecedenciaMedia || [])
    .find((r) => r.participante_id === participanteId)?.segundos;
  let persona = { chave: null, label: null };
  if (seg != null && !Number.isNaN(seg)) {
    if (seg >= 43200) persona = { chave: "precavido", label: "O Precavido" };
    else if (seg <= 7200) persona = { chave: "afobado", label: "O Afobado" };
    else persona = { chave: "equilibrado", label: "O Equilibrado" };
  }

  // Colocação final: MESMO ranking do app (calcularStats + compararRanking).
  const antecedenciaMap = {};
  for (const r of estado.antecedenciaMedia || []) antecedenciaMap[r.participante_id] = r.segundos;
  const ranking = estado.participantes
    .map((p) => calcularStats(p, estado, palpitesMap, { jogos: estado.jogos }))
    .sort((a, b) => compararRanking(a, b, antecedenciaMap));
  const me = ranking.find((p) => p.id === participanteId) || null;
  let final = null;
  if (me) {
    const pos = 1 + ranking.filter((p) => compararRanking(p, me, antecedenciaMap) < 0).length;
    const empatado = ranking.filter((p) => compararRanking(p, me, antecedenciaMap) === 0).length > 1;
    final = {
      pos, total: ranking.length, empatado, pontos: me.pontos,
      acertouCampeao: me.acertouCampeao, acertouArtilheiro: me.acertouArtilheiro,
    };
  }

  return {
    persona,
    apostasFeitas: d.apostasFeitas,
    jogosContados: d.jogosEncerrados.length,
    cravadas: { exatos: d.acertosExatos, resultados: d.acertosResult },
    arrancada: null,
    coragem: null,
    melhorPior: {
      melhor: d.melhor && d.melhor.ptsPeso > 0 ? d.melhor : null,
      pior: d.pior || null,
    },
    evolucao: calcularEvolucao(participanteId, estado, palpitesMap),
    final,
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS — todas as linhas de `calcularMomentos` verdes, e os testes antigos continuam passando.

- [ ] **Step 5: Commit**

```bash
git add src/ranking.js src/ranking.test.mjs
git commit -m "feat: calcularMomentos (núcleo do retrospecto pessoal)"
```

---

### Task 2: `calcularMomentos.arrancada` — a maior noite (agrupamento por dia)

**Files:**
- Modify: `src/ranking.js` (dentro de `calcularMomentos`)
- Test: `src/ranking.test.mjs` (adicionar asserts no MESMO bloco da Task 1)

**Interfaces:**
- Consumes: `d.porJogo` (de `calcularDetalhamento`), `opts.chaveData`.
- Produces: `momentos.arrancada` = `{ dataKey: string, pts: number, nJogos: number } | null`.

- [ ] **Step 1: Escrever o teste que falha**

Adicionar dentro do bloco `{ ... }` da Task 1 (depois dos asserts existentes, antes de fechar o bloco):

```js
  // arrancada: melhor DIA em pontos. Ana: 14/06 = 3+3 = 6; 15/06 = 9+1 = 10; 16/06 = 0.
  check(mAna.arrancada && mAna.arrancada.dataKey === "2026-06-15", `arrancada deveria ser 2026-06-15, veio ${mAna.arrancada && mAna.arrancada.dataKey}`);
  check(mAna.arrancada.pts === 10, `arrancada.pts deveria ser 10, veio ${mAna.arrancada.pts}`);
  check(mAna.arrancada.nJogos === 2, `arrancada.nJogos deveria ser 2, veio ${mAna.arrancada.nJogos}`);
  check(mDuda.arrancada === null, "Duda (sem pontuar) → arrancada null");
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — `arrancada` vem `null` (`Cannot read properties of null (reading 'dataKey')` ou o check de igualdade falha).

- [ ] **Step 3: Implementar a arrancada**

Em `src/ranking.js`, dentro de `calcularMomentos`, ANTES do `return`, adicionar:

```js
  // Maior arrancada: dia (local) em que somou mais pontos COM peso.
  const chaveData = opts.chaveData || ((iso) => (iso ? iso.slice(0, 10) : "__semdata__"));
  const porDia = {};
  for (const x of d.porJogo) {
    if (!x.jogo.kickoff) continue;
    const k = chaveData(x.jogo.kickoff);
    (porDia[k] ||= { pts: 0, n: 0 });
    porDia[k].pts += x.ptsPeso || 0;
    porDia[k].n += 1;
  }
  let arrancada = null;
  for (const [k, v] of Object.entries(porDia)) {
    if (v.pts > 0 && (!arrancada || v.pts > arrancada.pts)) {
      arrancada = { dataKey: k, pts: v.pts, nJogos: v.n };
    }
  }
```

E no objeto de retorno, trocar `arrancada: null,` por `arrancada,`.

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ranking.js src/ranking.test.mjs
git commit -m "feat: arrancada (maior noite) no retrospecto"
```

---

### Task 3: `calcularMomentos.coragem` — o acerto na contramão

**Files:**
- Modify: `src/ranking.js` (dentro de `calcularMomentos`)
- Test: `src/ranking.test.mjs` (asserts no bloco da Task 1 + um bloco novo pro caso null)

**Interfaces:**
- Consumes: `d.porJogo`, `palpitesMap`, constantes `PTS_EXATO`/`PTS_RESULTADO` (já no módulo).
- Produces: `momentos.coragem` = `{ jogo, meuPalpite:{h,a}, sameCount:number, totalG:number, exato:boolean } | null`. Regra de inclusão: `sameCount <= 2 && totalG >= 4`.

- [ ] **Step 1: Escrever o teste que falha**

Adicionar dentro do bloco da Task 1 (junto dos outros asserts de `mAna`):

```js
  // coragem: entre os jogos que Ana pontuou, o mais "contra a maioria".
  // jogo 12 (3×0): Ana crava 3×0, ninguém mais → sameCount 0, totalG 4, exato.
  check(mAna.coragem && mAna.coragem.jogo.id === 12, `coragem deveria ser jogo 12, veio ${mAna.coragem && mAna.coragem.jogo.id}`);
  check(mAna.coragem.sameCount === 0, `coragem.sameCount deveria ser 0, veio ${mAna.coragem.sameCount}`);
  check(mAna.coragem.totalG === 4, `coragem.totalG deveria ser 4, veio ${mAna.coragem.totalG}`);
  check(mAna.coragem.exato === true, "coragem do jogo 12 foi cravada");
```

E, DEPOIS de fechar o bloco `{ ... }` da Task 1, adicionar um bloco novo pro caso null:

```js
/* ---- coragem: null quando não há plateia suficiente (totalG < 4) ---- */
{
  const chaveDataM = (iso) => (iso ? iso.slice(0, 10) : "__semdata__");
  const est2 = {
    participantes: [{ id: 1, nome: "A" }, { id: 2, nome: "B" }, { id: 3, nome: "C" }],
    jogos: [{ id: 1, casa: "X", fora: "Y", kickoff: "2026-06-14T18:00:00Z", gh: 2, ga: 1, live: false, peso: 1 }],
    resultadoEspecial: { campeao: { confirmado: false }, artilheiro: { confirmado: false } },
    palpitesCampeao: [], premiadosArtilheiro: [], antecedenciaMedia: [],
  };
  const pal2 = { 1: { 1: { h: 2, a: 1 }, 2: { h: 1, a: 0 }, 3: { h: 0, a: 1 } } };
  const m2 = calcularMomentos(1, est2, pal2, { chaveData: chaveDataM });
  check(m2.coragem === null, "coragem null quando só 3 palpitaram (totalG < 4)");
}
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: FAIL — `coragem` vem `null` no cenário da Ana.

- [ ] **Step 3: Implementar a coragem**

Em `src/ranking.js`, dentro de `calcularMomentos`, logo depois do bloco da arrancada, adicionar:

```js
  // Coragem premiada: entre os jogos que a pessoa PONTUOU, aquele em que menos
  // gente fez o MESMO palpite exato (mais contramão). Desempate por ter cravado.
  let coragem = null;
  for (const x of d.porJogo) {
    if (!x.palpite || x.pts < PTS_RESULTADO) continue;
    const pals = palpitesMap[x.jogo.id] || {};
    let sameCount = 0, totalG = 0;
    for (const [pid, pal] of Object.entries(pals)) {
      totalG += 1;
      if (Number(pid) === participanteId) continue;
      if (Number(pal.h) === Number(x.palpite.h) && Number(pal.a) === Number(x.palpite.a)) sameCount += 1;
    }
    const exato = x.pts === PTS_EXATO;
    // Menor sameCount vence; empate → quem cravou; empate ainda → maior totalG
    // (mais gente batida = mais impressionante). Sem o 3º critério, um jogo de
    // plateia pequena (totalG < 4) poderia ser escolhido e depois zerado pelo
    // portão abaixo, escondendo uma coragem válida de plateia maior.
    const melhora = !coragem
      || sameCount < coragem.sameCount
      || (sameCount === coragem.sameCount && exato && !coragem.exato)
      || (sameCount === coragem.sameCount && exato === coragem.exato && totalG > coragem.totalG);
    if (melhora) coragem = { jogo: x.jogo, meuPalpite: x.palpite, sameCount, totalG, exato };
  }
  if (!(coragem && coragem.sameCount <= 2 && coragem.totalG >= 4)) coragem = null;
```

E no retorno, trocar `coragem: null,` por `coragem,`.

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS (todos os blocos).

- [ ] **Step 5: Commit**

```bash
git add src/ranking.js src/ranking.test.mjs
git commit -m "feat: coragem premiada (acerto na contramão) no retrospecto"
```

---

### Task 4: Componentes `RetrospectoCopa` + `BannerRetrospecto` + CSS

**Files:**
- Modify: `src/App.jsx` — adicionar `calcularMomentos` ao import de `./ranking.js`; adicionar os dois componentes perto das celebrações do campeão (depois de `ModalCampeaoBolao`, ~L4282); adicionar CSS no `Estilo()` (~L5041, junto de `.banner-campeao-bolao`); garantir `useMemo`/`useRef` no import do React.
- Test: build (`npm run build`) — não há harness de componente neste repo.

**Interfaces:**
- Consumes: `calcularMomentos` (Task 1-3), `Avatar`, `GraficoTrajetoria`, `ConfeteCampeao`, `chaveData` (module-level, `src/App.jsx:1197`), `BONUS_CAMPEAO`/`BONUS_ARTILHEIRO` (já importados).
- Produces: `BannerRetrospecto({ onAbrir })` e `RetrospectoCopa({ participanteId, estado, palpitesMap, onFechar })`.

- [ ] **Step 1: Adicionar `calcularMomentos` ao import e garantir hooks**

No topo de `src/App.jsx`, no import de `"./ranking.js"`, incluir `calcularMomentos` na lista. No import de React/hooks, garantir que `useMemo` e `useRef` estão presentes (adicionar se faltarem).

- [ ] **Step 2: Adicionar os componentes**

Colar, logo APÓS o fim de `ModalCampeaoBolao` (antes do componente `Estilo()`), em `src/App.jsx`:

```jsx
/* Banner de entrada do retrospecto (mesmo padrão do BannerCampeaoBolao). */
function BannerRetrospecto({ onAbrir }) {
  return (
    <button className="banner-retrospecto entra-2" onClick={onAbrir}>
      <span className="banner-retrospecto-emoji" aria-hidden="true">🎬</span>
      <span className="banner-retrospecto-txt">Ver meu retrospecto da Copa</span>
      <span className="banner-retrospecto-cta">Bora →</span>
    </button>
  );
}

/* Retrospecto pessoal estilo "Wrapped": slides em tela cheia com os momentos
   da Copa do participante. Slides condicionais pulam quando não há substância.
   Dados de calcularMomentos (ranking.js). */
const MESES_RETRO = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
function RetrospectoCopa({ participanteId, estado, palpitesMap, onFechar }) {
  const participante = estado.participantes.find((p) => p.id === participanteId);
  const m = useMemo(
    () => calcularMomentos(participanteId, estado, palpitesMap, { chaveData }),
    [participanteId, estado, palpitesMap]
  );
  const reduzMovimento = typeof window !== "undefined" && window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fmtDia = (key) => {
    const [, mes, dia] = (key || "").split("-");
    return mes && dia ? `${Number(dia)} de ${MESES_RETRO[Number(mes) - 1]}` : "";
  };

  const slides = [];
  slides.push({ tipo: "capa" });
  slides.push({ tipo: "cravadas" });
  if (m.arrancada) slides.push({ tipo: "arrancada" });
  if (m.coragem) slides.push({ tipo: "coragem" });
  if (m.melhorPior.melhor || m.melhorPior.pior) slides.push({ tipo: "melhorPior" });
  if (m.evolucao && m.evolucao.length >= 2) slides.push({ tipo: "escalada" });
  slides.push({ tipo: "final" });

  const total = slides.length;
  const [idx, setIdx] = useState(0);
  const avancar = () => setIdx((i) => Math.min(i + 1, total - 1));
  const voltar = () => setIdx((i) => Math.max(i - 1, 0));

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onFechar();
      else if (e.key === "ArrowRight") avancar();
      else if (e.key === "ArrowLeft") voltar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [total]);

  const toqueX = useRef(null);
  const onTouchStart = (e) => { toqueX.current = e.touches[0].clientX; };
  const onTouchEnd = (e) => {
    if (toqueX.current == null) return;
    const dx = e.changedTouches[0].clientX - toqueX.current;
    if (dx < -40) avancar(); else if (dx > 40) voltar();
    toqueX.current = null;
  };
  const onClickArea = (e) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    if (x < e.currentTarget.clientWidth * 0.35) voltar(); else avancar();
  };

  const slide = slides[idx];
  const ehUltimo = idx === total - 1;
  const jogoTxt = (j) => `${j.casa} ${j.gh}×${j.ga} ${j.fora}`;

  return (
    <div className="retro-overlay" role="dialog" aria-modal="true">
      <div className="retro-progresso">
        {slides.map((s, i) => (
          <span key={i} className={"retro-progresso-seg" + (i <= idx ? " on" : "")} />
        ))}
      </div>
      <button className="retro-fechar" onClick={onFechar} aria-label="Fechar">✕</button>

      <div
        className={"retro-palco" + (reduzMovimento ? "" : " retro-anima")}
        key={idx}
        onClick={onClickArea}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {slide.tipo === "capa" && (
          <div className="retro-card retro-capa">
            <span className="retro-anel">
              <Avatar nome={participante?.nome} emoji={participante?.avatarEmoji} cor={participante?.avatarCor} size={84} />
            </span>
            <div className="retro-eyebrow">A SUA COPA 2026</div>
            <div className="retro-nome">{participante?.nome}</div>
            {m.persona.label && <div className="retro-selo">{m.persona.label}</div>}
            <div className="retro-sub">{m.apostasFeitas} palpites em {m.jogosContados} jogos. Bora relembrar?</div>
          </div>
        )}

        {slide.tipo === "cravadas" && (
          <div className="retro-card">
            <span className="retro-emoji" aria-hidden="true">🎯</span>
            {m.cravadas.exatos > 0 ? (
              <>
                <div className="retro-numerao">{m.cravadas.exatos}</div>
                <div className="retro-frase">{m.cravadas.exatos === 1 ? "placar cravado na mosca" : "placares cravados na mosca"}</div>
              </>
            ) : (
              <>
                <div className="retro-frase">Nenhuma cravada dessa vez…</div>
                <div className="retro-sub">mas você acertou o resultado {m.cravadas.resultados} {m.cravadas.resultados === 1 ? "vez" : "vezes"}.</div>
              </>
            )}
          </div>
        )}

        {slide.tipo === "arrancada" && (
          <div className="retro-card">
            <span className="retro-emoji" aria-hidden="true">🚀</span>
            <div className="retro-eyebrow">SUA MAIOR ARRANCADA</div>
            <div className="retro-numerao">+{m.arrancada.pts}</div>
            <div className="retro-frase">pts na noite de {fmtDia(m.arrancada.dataKey)}</div>
            <div className="retro-sub">{m.arrancada.nJogos} {m.arrancada.nJogos === 1 ? "jogo" : "jogos"} numa tacada só.</div>
          </div>
        )}

        {slide.tipo === "coragem" && (
          <div className="retro-card">
            <span className="retro-emoji" aria-hidden="true">💎</span>
            <div className="retro-eyebrow">CORAGEM PREMIADA</div>
            <div className="retro-frase">{jogoTxt(m.coragem.jogo)}</div>
            <div className="retro-sub">
              Você {m.coragem.exato ? "cravou" : "acertou"} e foi {m.coragem.sameCount === 0 ? "o ÚNICO" : `1 de só ${m.coragem.sameCount + 1}`} a apostar nisso.
            </div>
          </div>
        )}

        {slide.tipo === "melhorPior" && (
          <div className="retro-card retro-melhorpior">
            <div className="retro-eyebrow">O MELHOR E O PIOR</div>
            {m.melhorPior.melhor && (
              <div className="retro-mp-linha bom">
                <span className="retro-mp-ico">💪</span>
                <span className="retro-mp-jogo">{jogoTxt(m.melhorPior.melhor.jogo)}</span>
                <span className="retro-mp-pts">+{m.melhorPior.melhor.ptsPeso}</span>
              </div>
            )}
            {m.melhorPior.pior && (
              <div className="retro-mp-linha ruim">
                <span className="retro-mp-ico">😬</span>
                <span className="retro-mp-jogo">{jogoTxt(m.melhorPior.pior.jogo)}</span>
                <span className="retro-mp-pts">+{m.melhorPior.pior.ptsPeso}</span>
              </div>
            )}
            <div className="retro-sub">a gente finge que não viu o de baixo 🙈</div>
          </div>
        )}

        {slide.tipo === "escalada" && (
          <div className="retro-card">
            <span className="retro-emoji" aria-hidden="true">📈</span>
            <div className="retro-eyebrow">SUA ESCALADA</div>
            <GraficoTrajetoria evolucao={m.evolucao} />
            <div className="retro-sub">como você subiu ao longo da Copa.</div>
          </div>
        )}

        {slide.tipo === "final" && (
          <div className="retro-card retro-final">
            {!reduzMovimento && <ConfeteCampeao />}
            <div className="retro-eyebrow">ONDE VOCÊ TERMINOU</div>
            <div className="retro-posicao">{m.final.empatado ? "empatado em " : ""}{m.final.pos}º</div>
            <div className="retro-frase">de {m.final.total} · {m.final.pontos} pts</div>
            {m.final.acertouCampeao && <div className="retro-bonus">🏆 Acertou a campeã (+{BONUS_CAMPEAO})</div>}
            {m.final.acertouArtilheiro && <div className="retro-bonus">⚽ Acertou o artilheiro (+{BONUS_ARTILHEIRO})</div>}
            <div className="retro-sub">📸 tira um print e manda no grupo!</div>
          </div>
        )}
      </div>

      {!ehUltimo && <div className="retro-dica" aria-hidden="true">toque para continuar →</div>}
      {ehUltimo && <button className="retro-final-btn" onClick={onFechar}>Fechar</button>}
    </div>
  );
}
```

- [ ] **Step 3: Adicionar o CSS**

Dentro do `<style>` de `Estilo()` (`src/App.jsx:4208`), junto dos estilos `.banner-campeao-bolao` (~L5041), colar:

```css
      .banner-retrospecto {
        display: flex; align-items: center; gap: 10px; width: 100%;
        margin: 10px 0; padding: 12px 14px; border: 0; cursor: pointer;
        border-radius: 14px; text-align: left;
        background: linear-gradient(100deg, #2a1e46, #3a2a63);
        color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.25);
      }
      .banner-retrospecto-emoji { font-size: 22px; }
      .banner-retrospecto-txt { font-weight: 700; flex: 1; }
      .banner-retrospecto-cta { opacity: .85; font-size: 14px; white-space: nowrap; }

      .retro-overlay {
        position: fixed; inset: 0; z-index: 60; display: flex;
        flex-direction: column; align-items: center; justify-content: center;
        background: radial-gradient(120% 90% at 50% 0%, #3a2a63 0%, #16121f 70%);
        padding: 16px;
      }
      .retro-progresso {
        position: absolute; top: 10px; left: 12px; right: 12px;
        display: flex; gap: 4px;
      }
      .retro-progresso-seg {
        flex: 1; height: 3px; border-radius: 2px; background: rgba(255,255,255,.22);
      }
      .retro-progresso-seg.on { background: var(--ambar, #ffc53d); }
      .retro-fechar {
        position: absolute; top: 16px; right: 14px; z-index: 2;
        background: transparent; border: 0; color: #fff; font-size: 20px;
        cursor: pointer; opacity: .8;
      }
      .retro-palco {
        width: 100%; max-width: 380px; min-height: 60vh;
        display: flex; align-items: center; justify-content: center;
        user-select: none;
      }
      .retro-anima { animation: retroEntra .45s ease both; }
      @keyframes retroEntra {
        from { opacity: 0; transform: translateY(14px) scale(.98); }
        to { opacity: 1; transform: none; }
      }
      .retro-card {
        width: 100%; text-align: center; color: #fff;
        display: flex; flex-direction: column; align-items: center; gap: 10px;
        position: relative;
      }
      .retro-eyebrow {
        font-size: 13px; letter-spacing: .12em; opacity: .8; font-weight: 700;
      }
      .retro-emoji { font-size: 56px; }
      .retro-numerao {
        font-size: 88px; font-weight: 800; line-height: 1;
        color: var(--ambar, #ffc53d);
      }
      .retro-posicao {
        font-size: 72px; font-weight: 800; line-height: 1;
        color: var(--ambar, #ffc53d);
      }
      .retro-frase { font-size: 20px; font-weight: 700; }
      .retro-sub { font-size: 15px; opacity: .82; max-width: 300px; }
      .retro-nome { font-size: 26px; font-weight: 800; }
      .retro-selo {
        font-size: 14px; font-weight: 700; padding: 4px 12px; border-radius: 999px;
        background: rgba(255,197,61,.16); color: var(--ambar, #ffc53d);
      }
      .retro-anel {
        display: inline-flex; padding: 4px; border-radius: 50%;
        background: linear-gradient(135deg, var(--ambar, #ffc53d), #fff3cf);
      }
      .retro-melhorpior { gap: 14px; }
      .retro-mp-linha {
        display: flex; align-items: center; gap: 10px; width: 100%;
        padding: 12px 14px; border-radius: 12px; background: rgba(255,255,255,.06);
      }
      .retro-mp-linha.bom { box-shadow: inset 0 0 0 1px rgba(74,222,128,.4); }
      .retro-mp-linha.ruim { box-shadow: inset 0 0 0 1px rgba(255,255,255,.12); opacity: .85; }
      .retro-mp-ico { font-size: 22px; }
      .retro-mp-jogo { flex: 1; text-align: left; font-weight: 600; }
      .retro-mp-pts { font-weight: 800; color: var(--ambar, #ffc53d); }
      .retro-bonus { font-size: 15px; font-weight: 700; }
      .retro-dica { position: absolute; bottom: 22px; font-size: 13px; opacity: .6; color: #fff; }
      .retro-final-btn {
        position: absolute; bottom: 20px; padding: 10px 22px; border: 0;
        border-radius: 999px; cursor: pointer; font-weight: 700;
        background: var(--ambar, #ffc53d); color: #16121f;
      }
      @media (prefers-reduced-motion: reduce) { .retro-anima { animation: none; } }
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS (build limpo, sem erro de import/JSX).

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "feat: componentes RetrospectoCopa e BannerRetrospecto + CSS"
```

---

### Task 5: Ligar no App (estado, eyebrow "ENCERRADA", banner, modal) + verificação

**Files:**
- Modify: `src/App.jsx` — estado do modal (~L193), eyebrow do header (L434), banner após `</header>` (~L442), render do modal (~L493-501).
- Test: `npm run build` + verificação manual num preview.

**Interfaces:**
- Consumes: `bolaoEncerrado` (`src/App.jsx:379`), `BannerRetrospecto`/`RetrospectoCopa` (Task 4), `estado.eu.id`, `palpitesMap`.
- Produces: entrada visível e funcional do retrospecto quando `bolaoEncerrado`.

- [ ] **Step 1: Estado do modal**

Depois de `const [campeaoModalAberto, setCampeaoModalAberto] = useState(false);` (`src/App.jsx:193`), adicionar:

```jsx
  const [abrirRetrospecto, setAbrirRetrospecto] = useState(false);
```

- [ ] **Step 2: Selo "ENCERRADA" no eyebrow**

Trocar (`src/App.jsx:434`):

```jsx
        <div className="topo-eyebrow">COPA DO MUNDO · 2026</div>
```

por:

```jsx
        <div className="topo-eyebrow">
          COPA DO MUNDO · 2026{bolaoEncerrado && <span className="topo-encerrada"> · ENCERRADA</span>}
        </div>
```

E no CSS de `Estilo()`, adicionar:

```css
      .topo-encerrada { color: var(--ambar, #ffc53d); font-weight: 700; }
```

- [ ] **Step 3: Banner de entrada após o header**

Logo depois de `</header>` (`src/App.jsx:442`), adicionar:

```jsx
      {bolaoEncerrado && estado.eu.id !== null && (
        <BannerRetrospecto onAbrir={() => setAbrirRetrospecto(true)} />
      )}
```

- [ ] **Step 4: Render do modal**

Junto dos outros modais (depois do bloco `{campeaoModalAberto && ...}`, ~`src/App.jsx:501`), adicionar:

```jsx
      {abrirRetrospecto && estado.eu.id !== null && (
        <RetrospectoCopa
          participanteId={estado.eu.id}
          estado={estado}
          palpitesMap={palpitesMap}
          onFechar={() => setAbrirRetrospecto(false)}
        />
      )}
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Verificação manual (preview)**

Como a "Copa encerrada" depende de dados reais (os dois bônus confirmados no banco — o que já é o caso agora que a Copa acabou), verificar num **preview deploy do branch** (ou apontando o front pro deploy) com um token de participante:

1. O eyebrow do header mostra **"· ENCERRADA"** em âmbar.
2. Aparece o banner **"🎬 Ver meu retrospecto da Copa"**; clicar abre o Wrapped.
3. Navegar: tocar na direita avança, na esquerda volta; setas ←/→ no teclado; `Esc` e ✕ fecham; a barra de progresso acompanha.
4. O último slide mostra a colocação, faixas de bônus (se houver) e confete.
5. Testar com **um participante com muitos dados** e **um que quase não palpitou** (deck curto: capa + cravadas/variante + final, sem cards vazios).
6. Conferir que o admin-mestre (link sem participante) **não** vê o banner.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "feat: liga o retrospecto no App (header ENCERRADA + banner + modal)"
```

---

## Self-Review

**Cobertura da spec:**
- §5 slides → Tasks 1-3 (dados) + Task 4 (render). Todos os 7 slides presentes. ✓
- §4 gatilho → Task 5 usa `bolaoEncerrado` (nota: a spec dizia "campeão confirmado"; o sinal real e canônico do app é campeão **E** artilheiro — Task 5 usa esse, que é o correto e o que já dispara o banner do campeão). ✓
- §5 entrada (header + banner) → Task 5. ✓
- §7 `calcularMomentos` puro, sem endpoint → Tasks 1-3. ✓
- §8 bordas: admin-mestre (Task 5 step 3/4/6), 0 palpites (Task 1 teste Duda + Task 4 filtro de slides), empate (Task 1 `final.empatado`), reduced-motion (Task 4). ✓
- §9 testes → Tasks 1-3 no `ranking.test.mjs`; UI manual (Task 5) — honesto quanto à falta de harness de componente. ✓
- §10 fora de escopo (export/share) → não implementado, dica de print no slide final. ✓

**Placeholders:** nenhum — todo passo tem código/comando concreto.

**Consistência de tipos:** `calcularMomentos(participanteId, estado, palpitesMap, opts)` e o shape de retorno são idênticos entre Tasks 1-3 e o consumo em Task 4. `arrancada.dataKey/pts/nJogos`, `coragem.jogo/sameCount/totalG/exato`, `melhorPior.melhor/pior` (com `.ptsPeso`, `.jogo`), `final.pos/total/empatado/pontos/acertou*` — todos batem com o uso no componente.
