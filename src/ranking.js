/* ============================================================
   ranking.js — FONTE ÚNICA de cálculo de ranking (item M1 do review)
   Funções puras (sem React/DOM) para serem testáveis e evitar a
   lógica de pontuação duplicada que existia espalhada pelo App.jsx.
   ============================================================ */

export const PTS_EXATO = 3;
export const PTS_RESULTADO = 1;
export const BONUS_CAMPEAO = 12;
export const BONUS_ARTILHEIRO = 18;

/* "Tem placar que conta pontos" — INCLUI jogo ao vivo (gh/ga preenchidos).
   Diferente de `temResultado` (no App.jsx), que exige jogo encerrado (!live).
   Usado para alinhar os totais ao vivo em todo lugar (item M4 do review). */
export const temPlacar = (m) => m.gh !== null && m.ga !== null;

/* Peso (multiplicador de pontos) do jogo por fase: grupos 1×, 16-avos/oitavas 2×,
   quartas 3×, semi e 3º lugar 4×, final 5×. Fonte: coluna `peso` do banco
   (preenchida pela busca/admin).
   Fallback 1 mantém compatibilidade se vier um jogo sem o campo. */
export const pesoDoJogo = (jogo) => Number(jogo?.peso) || 1;

/* Rótulo da rodada a partir do peso. O banco só guarda `fase` como
   grupos|eliminatórias, então o peso é a única pista de QUAL rodada é.
   3× identifica as quartas sem ambiguidade; 4× é semi OU disputa de 3º lugar
   (indistinguíveis com o que temos) — daí o rótulo duplo, em vez de chutar.
   `destaque` liga o realce âmbar das fases decisivas. Null = grupos (sem tag). */
export function rotuloDoPeso(peso) {
  switch (Number(peso)) {
    case 5: return { texto: "🏆 Final", destaque: true };
    case 4: return { texto: "⚔ Semi / 3º lugar", destaque: true };
    case 3: return { texto: "⚔ Quartas de final", destaque: false };
    case 2: return { texto: "⚔ Mata-mata", destaque: false };
    default: return null;
  }
}
export const rotuloDaFase = (jogo) => rotuloDoPeso(pesoDoJogo(jogo));

/* Pontos BRUTOS de UM palpite contra UM jogo (sem peso) — usado para CLASSIFICAR
   (exato/resultado/erro) e contar exatos/resultados no desempate.
   Retorna null se não há palpite ou o jogo ainda não tem placar.
   (Conta jogo ao vivo: basta gh/ga preenchidos — política tratada por quem chama.) */
export function pontosDoPalpite(palpite, jogo) {
  if (!palpite || jogo.gh === null || jogo.ga === null) return null;
  const ph = Number(palpite.h), pa = Number(palpite.a);
  if (Number.isNaN(ph) || Number.isNaN(pa)) return null;
  if (ph === jogo.gh && pa === jogo.ga) return PTS_EXATO;
  const sinal = (x, y) => (x > y ? 1 : x < y ? -1 : 0);
  if (sinal(ph, pa) === sinal(jogo.gh, jogo.ga)) return PTS_RESULTADO;
  return 0;
}

/* Pontos JÁ COM PESO da fase — é o que entra no total e aparece pra galera
   (ex.: placar exato na final = 3 × 4 = 12). Retorna null se sem placar/palpite. */
export function pontosComPeso(palpite, jogo) {
  const base = pontosDoPalpite(palpite, jogo);
  return base === null ? null : base * pesoDoJogo(jogo);
}

/* Bônus de campeã (+9) e artilheiro (+6) de um participante, mais os flags
   de acerto (usados como critério de desempate). */
export function calcularBonus(p, estado) {
  let bonus = 0;
  const re = estado.resultadoEspecial;
  const acertouCampeao = !!(re?.campeao?.confirmado && (estado.palpitesCampeao || []).some(
    (pc) => pc.participante_id === p.id && pc.selecao === re.campeao.valor
  ));
  if (acertouCampeao) bonus += BONUS_CAMPEAO;
  const acertouArtilheiro = !!(re?.artilheiro?.confirmado && (estado.premiadosArtilheiro || []).includes(p.id));
  if (acertouArtilheiro) bonus += BONUS_ARTILHEIRO;
  return { bonus, acertouCampeao, acertouArtilheiro };
}

/* Stats completos de um participante sobre um conjunto de jogos.
   opts.jogos: lista de jogos a considerar (default: estado.jogos).
   opts.hojeKey + opts.chaveData: opcionais — só para contar `exatosHoje`
   (usado pelo confete); se não vierem, exatosHoje fica 0. */
export function calcularStats(p, estado, palpitesMap, opts = {}) {
  const { jogos = estado.jogos, hojeKey = null, chaveData = null } = opts;
  const { bonus, acertouCampeao, acertouArtilheiro } = calcularBonus(p, estado);
  let pontos = bonus, exatos = 0, resultados = 0, exatosHoje = 0;
  for (const m of jogos) {
    const pts = pontosDoPalpite(palpitesMap[m.id]?.[p.id], m);
    /* peso entra SÓ no total de pontos; as contagens de exatos/resultados
       (usadas no desempate) seguem sem peso: 1 exato = 1 exato. */
    if (pts === PTS_EXATO) {
      exatos++; pontos += pts * pesoDoJogo(m);
      /* exatosHoje dispara o GOOOL + confete: só vale CRAVADA confirmada, isto é,
         jogo ENCERRADO (não ao vivo). Sem o !m.live, um placar parcial igual ao
         palpite (ex.: 1×1 com a bola rolando) faria todo mundo "gritar gol" sem
         ter acertado de verdade. */
      if (hojeKey && chaveData && !m.live && m.kickoff && chaveData(m.kickoff) === hojeKey) exatosHoje++;
    } else if (pts === PTS_RESULTADO) { resultados++; pontos += pts * pesoDoJogo(m); }
  }
  return { ...p, pontos, exatos, resultados, bonus, exatosHoje, acertouCampeao, acertouArtilheiro };
}

/* Detalhamento jogo-a-jogo de UM participante (Meu Perfil e Campeão do Bolão
   usam o mesmo cálculo — antes só existia inline dentro do PerfilPicker,
   preso ao participante logado). Sem bônus de propósito: é sobre desempenho
   nos JOGOS (aproveitamento, melhor/pior), o bônus tem seu próprio bloco. */
export function calcularDetalhamento(participanteId, estado, palpitesMap) {
  const jogosEncerrados = (estado.jogos || []).filter(temPlacar);
  const temAoVivo = jogosEncerrados.some((m) => m.live);
  const porJogo = jogosEncerrados.map((m) => {
    const palpite = palpitesMap[m.id]?.[participanteId];
    return { jogo: m, palpite, pts: pontosDoPalpite(palpite, m), ptsPeso: pontosComPeso(palpite, m) };
  });
  const comPalpite = porJogo.filter((x) => x.palpite);
  const acertosExatos = porJogo.filter((x) => x.pts === PTS_EXATO).length;
  const acertosResult = porJogo.filter((x) => x.pts === PTS_RESULTADO).length;
  const erros = comPalpite.filter((x) => x.pts === 0).length;
  const totalPtsJogos = porJogo.reduce((s, x) => s + (x.ptsPeso || 0), 0);
  const maxPossivel = porJogo.reduce((s, x) => s + (x.palpite ? pesoDoJogo(x.jogo) * PTS_EXATO : 0), 0);
  const aproveitamento = maxPossivel > 0 ? Math.round((totalPtsJogos / maxPossivel) * 100) : 0;
  const melhor = comPalpite.reduce((b, x) => (!b || x.ptsPeso > b.ptsPeso) ? x : b, null);
  const pior = comPalpite.reduce((w, x) => (!w || x.ptsPeso < w.ptsPeso) ? x : w, null);
  return {
    jogosEncerrados, temAoVivo, porJogo, comPalpite,
    apostasFeitas: comPalpite.length, acertosExatos, acertosResult, erros,
    totalPtsJogos, maxPossivel, aproveitamento, melhor, pior,
  };
}

/* Evolução de pontos (COM peso, SEM bônus) de um participante ao longo da
   Copa, em ordem cronológica — usado no gráfico de linha do Campeão do
   Bolão. Palpite ausente/errado soma 0 (a linha nunca cai, só sobe ou
   estagna: acumulado é sempre não-decrescente). */
export function calcularEvolucao(participanteId, estado, palpitesMap) {
  const jogosEncerrados = (estado.jogos || [])
    .filter((m) => temPlacar(m) && m.kickoff)
    .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  let acumulado = 0;
  return jogosEncerrados.map((m) => {
    const palpite = palpitesMap[m.id]?.[participanteId];
    const pts = pontosDoPalpite(palpite, m);
    acumulado += pontosComPeso(palpite, m) || 0;
    return { jogo: m, pts, acumulado };
  });
}

/* 5º critério de desempate: ANTECEDÊNCIA MÉDIA (segundos antes do kickoff).
   Maior = palpita mais cedo, em média = vence. Quem tem dado vence quem não tem
   (não palpitou nenhum jogo com horário). Empate real (mesma média ou ambos sem
   dado) cai pra divisão do prêmio. */
function compararAntecedencia(antA, antB) {
  const temA = antA != null, temB = antB != null;
  if (temA && temB) return antB - antA; // maior média primeiro
  if (temA) return -1;                   // só A tem dado → A na frente
  if (temB) return 1;                    // só B tem dado → B na frente
  return 0;                              // empate técnico
}

/* Comparador canônico do ranking. MESMA ordem do criterioDesempate abaixo —
   precisam ficar em sincronia (antes estavam em dois lugares com regras
   diferentes, o que gerava setas de tendência falsas: item M2).
   antecedenciaMap: { [participante_id]: antecedência média em segundos }. */
export function compararRanking(a, b, antecedenciaMap = {}) {
  return (
    b.pontos - a.pontos ||
    b.exatos - a.exatos ||
    (b.acertouCampeao ? 1 : 0) - (a.acertouCampeao ? 1 : 0) ||
    (b.acertouArtilheiro ? 1 : 0) - (a.acertouArtilheiro ? 1 : 0) ||
    b.resultados - a.resultados ||
    compararAntecedencia(antecedenciaMap[a.id], antecedenciaMap[b.id])
  );
}

/* Rótulo de QUAL critério separou dois participantes empatados em pontos.
   Espelha a ordem do compararRanking. */
export function criterioDesempate(a, b) {
  if (a.pontos !== b.pontos) return null;
  if (a.exatos !== b.exatos) return { icon: "🎯", label: "mais exatos" };
  if (!!a.acertouCampeao !== !!b.acertouCampeao) return { icon: "🏆", label: "acertou a campeã" };
  if (!!a.acertouArtilheiro !== !!b.acertouArtilheiro) return { icon: "⚽", label: "acertou o artilheiro" };
  if (a.resultados !== b.resultados) return { icon: "✅", label: "mais resultados" };
  return { icon: "⏱", label: "palpita com mais antecedência" };
}

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

  return {
    persona,
    apostasFeitas: d.apostasFeitas,
    jogosContados: d.jogosEncerrados.length,
    cravadas: { exatos: d.acertosExatos, resultados: d.acertosResult },
    arrancada,
    coragem: null,
    melhorPior: {
      melhor: d.melhor && d.melhor.ptsPeso > 0 ? d.melhor : null,
      pior: d.pior || null,
    },
    evolucao: calcularEvolucao(participanteId, estado, palpitesMap),
    final,
  };
}
