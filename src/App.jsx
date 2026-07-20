import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  PTS_EXATO, PTS_RESULTADO, temPlacar, BONUS_CAMPEAO, BONUS_ARTILHEIRO,
  pontosDoPalpite, pontosComPeso, pesoDoJogo, rotuloDaFase, rotuloDoPeso, calcularStats, compararRanking, criterioDesempate,
  calcularDetalhamento, calcularEvolucao, calcularMomentos,
} from "./ranking";

/* ============================================================
   BOLÃO DA COPA 2026 — versão compartilhada (Vercel + Neon)
   Cada amigo acessa pelo seu link com token (?t=...).
   Regras: placar exato = 3 pts | resultado certo = 1 pt
   Travamento de palpites validado NO SERVIDOR.
   ============================================================ */

/* PTS_EXATO, PTS_RESULTADO, criterioDesempate e pontosDoPalpite agora vêm de
   ./ranking.js (fonte única — item M1 do review). */

/* Constantes do bolão (item P3 — tira números mágicos espalhados).
   DEADLINE_PAGAMENTO e _LABEL precisam ficar em sincronia se a data mudar. */
const VALOR_ENTRADA = 20; // R$ por participante
const DEADLINE_PAGAMENTO = new Date("2026-06-13T21:59:00Z"); // 18:59 BRT (UTC-3)
const DEADLINE_PAGAMENTO_LABEL = "13/06 às 18:59";

/* Lembrete de palpites: só jogos começando em até 26h (jogos do dia + madrugada
   seguinte). Depois de fechado, reaparece faltando 2h e depois 30min pro mais
   próximo (estágios 0=no dia, 1=2h, 2=30min). */
const LEMBRETE_JANELA = 26 * 60 * 60 * 1000;
const LEMBRETE_2H = 2 * 60 * 60 * 1000;
const LEMBRETE_30MIN = 30 * 60 * 1000;

const reduzMovimento = () =>
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const temResultado = (m) => m.gh !== null && m.ga !== null && !m.live;

function fmtQuando(m) {
  if (!m.kickoff) return "";
  const d = new Date(m.kickoff);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/* só a hora (HH:MM em SP) — a data já vem no cabeçalho do grupo */
function fmtHora(m) {
  if (!m.kickoff) return "";
  const d = new Date(m.kickoff);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
}

/* momento absoluto de um ISO (dd/mm hh:mm em SP) */
function fmtMomento(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/* jogos abertos (em até 26h) que EU ainda não palpitei, + estágio de urgência
   do mais próximo: 0 = no dia, 1 = faltam ≤2h, 2 = faltam ≤30min, -1 = nenhum. */
function analisarLembrete(estado, nowMs) {
  const eu = estado?.eu?.id;
  if (eu == null) return { pendentes: [], nearest: null, stage: -1 };
  const meus = new Set();
  for (const p of estado.palpites) if (p.participante_id === eu) meus.add(p.jogo_id);
  const pendentes = estado.jogos
    .filter((m) => m.kickoff && !temResultado(m) && !meus.has(m.id))
    .filter((m) => {
      const t = new Date(m.kickoff).getTime() - nowMs;
      return t > 0 && t <= LEMBRETE_JANELA;
    })
    .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  const nearest = pendentes[0] || null;
  let stage = -1;
  if (nearest) {
    const t = new Date(nearest.kickoff).getTime() - nowMs;
    stage = t <= LEMBRETE_30MIN ? 2 : t <= LEMBRETE_2H ? 1 : 0;
  }
  return { pendentes, nearest, stage };
}

/* quanto antes do kickoff o palpite foi feito (ex.: "3d 5h antes") */
function fmtAntecedencia(kickoff, criadoIso) {
  if (!kickoff || !criadoIso) return "";
  const diff = new Date(kickoff).getTime() - new Date(criadoIso).getTime();
  if (!(diff > 0)) return "";
  const min = Math.floor(diff / 60000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return `${d}d ${h}h antes`;
  if (h > 0) return `${h}h ${m}min antes`;
  return `${m}min antes`;
}

/* kickoff (ISO do banco) -> valor de input datetime-local */
function kickoffParaInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function api(caminho, opts = {}) {
  const r = await fetch(caminho, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.error || "Erro " + r.status);
  return corpo;
}

function lerToken() {
  try {
    const t = new URLSearchParams(window.location.search).get("t");
    if (t) {
      localStorage.setItem("bolao_token", t);
      return t;
    }
    return localStorage.getItem("bolao_token") || "";
  } catch {
    return "";
  }
}

/* Lê o estado salvo em cache, mas SÓ devolve se tiver o formato esperado.
   O estado serve de render inicial (antes do fetch) — se for de um deploy
   antigo e faltar um campo (ex.: `jogos`), o primeiro render estoura de
   forma síncrona e o app some, deixando só o fundo verde. Validar o formato
   evita que um cache velho "brique" quem já abriu o app antes. */
function lerEstadoCache(token) {
  try {
    const c = localStorage.getItem(`bolao-${token}`);
    if (!c) return null;
    const e = JSON.parse(c);
    const ok =
      e && typeof e === "object" &&
      e.eu && typeof e.eu === "object" &&
      Array.isArray(e.jogos) &&
      Array.isArray(e.participantes) &&
      Array.isArray(e.palpites) &&
      Array.isArray(e.contagens);
    if (!ok) {
      localStorage.removeItem(`bolao-${token}`);
      return null;
    }
    return e;
  } catch {
    return null;
  }
}

/* Contagem animada (placar de estádio subindo) */
function useCountUp(valor, dur = 800) {
  const [v, setV] = useState(valor);
  const prev = useRef(valor);
  useEffect(() => {
    if (reduzMovimento()) { prev.current = valor; setV(valor); return; }
    const de = prev.current, para = valor;
    if (de === para) return;
    prev.current = para;
    const t0 = performance.now();
    let raf;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setV(Math.round(de + (para - de) * e));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [valor, dur]);
  return v;
}

export default function App() {
  const [token] = useState(lerToken);
  const [estado, setEstado] = useState(() => lerEstadoCache(lerToken()));
  const [erroAuth, setErroAuth] = useState("");
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem("bolao-tab") || "ranking"; } catch { return "ranking"; }
  });
  const [abrirPerfil, setAbrirPerfil] = useState(false);
  const [abrirRegras, setAbrirRegras] = useState(false);
  const [abrirPagamento, setAbrirPagamento] = useState(false);
  const [abrirLembrete, setAbrirLembrete] = useState(false);
  const [participanteModal, setParticipanteModal] = useState(null);
  const [campeaoModalAberto, setCampeaoModalAberto] = useState(false);
  const [abrirRetrospecto, setAbrirRetrospecto] = useState(false);
  const [proximoFechado, setProximoFechado] = useState(false);
  const [jogoPreSel, setJogoPreSel] = useState(null);
  const [statsPreSel, setStatsPreSel] = useState(null);
  const offsetRef = useRef(0);
  const rankingJaAbriu = useRef(false);
  const pagamentoVerificado = useRef(false);
  /* estágio de lembrete já fechado por jogo — SÓ nesta sessão (em memória).
     Reabrir/recarregar o app zera, então o popup volta a aparecer. Os limiares
     de 2h/30min continuam escalando dentro da sessão. */
  const lembreteDismiss = useRef({});
  const [tick, setTick] = useState(0);
  const [installPrompt, setInstallPrompt] = useState(null);

  const carregar = useCallback(async () => {
    if (!token) return;
    try {
      const e = await api(`/api/estado?t=${encodeURIComponent(token)}`);
      offsetRef.current = Date.parse(e.agora) - Date.now();
      setEstado(e);
      try { localStorage.setItem(`bolao-${token}`, JSON.stringify(e)); } catch { /* storage cheio */ }
      setErroAuth("");
    } catch (err) {
      if (!estado) setErroAuth(err.message);
    }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const salvarAvatar = useCallback(async (emoji, cor) => {
    await api("/api/participante", {
      method: "PATCH",
      body: JSON.stringify({ t: token, emoji, cor }),
    });
    await carregar();
  }, [token, carregar]);

  /* abre popup de pagamento na primeira carga, uma vez por sessão */
  useEffect(() => {
    if (!estado || pagamentoVerificado.current) return;
    pagamentoVerificado.current = true;
    const euP = estado.participantes.find((p) => p.id === estado.eu.id);
    if (euP && !euP.pagou && !estado.eu.isAdmin) setAbrirPagamento(true);
  }, [estado]);

  /* lembrete de palpites: abre quando o estágio de urgência do jogo pendente
     mais próximo ultrapassa o que o usuário já fechou. Reavalia na carga e a
     cada tick (30s), então escalona sozinho para 2h e 30min. Pagamento tem
     prioridade (não empilha). */
  useEffect(() => {
    if (!estado || abrirPagamento || abrirLembrete) return;
    const { nearest, stage } = analisarLembrete(estado, Date.now() + offsetRef.current);
    if (!nearest || stage < 0) return;
    const jaFechado = lembreteDismiss.current[nearest.id] ?? -1;
    if (stage > jaFechado) setAbrirLembrete(true);
  }, [estado, tick, abrirPagamento, abrirLembrete]);

  const fecharLembrete = useCallback(() => {
    setAbrirLembrete(false);
    if (!estado) return;
    const { pendentes, stage } = analisarLembrete(estado, Date.now() + offsetRef.current);
    if (stage < 0) return;
    const d = lembreteDismiss.current;
    for (const m of pendentes) d[m.id] = stage; // marca neste estágio (só nesta sessão)
  }, [estado]);

  const palpitarDoLembrete = useCallback(() => {
    const { nearest } = analisarLembrete(estado, Date.now() + offsetRef.current);
    fecharLembrete();
    if (nearest) irParaPalpites(nearest.id);
  }, [estado, fecharLembrete]); // eslint-disable-line react-hooks/exhaustive-deps

  /* registra service worker uma vez */
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  /* captura prompt de instalação do PWA (Android/Chrome) */
  useEffect(() => {
    const handler = (e) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  /* carga inicial + polling 30s + refetch ao voltar pra aba */
  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => {
    if (!token) return;
    const poll = setInterval(carregar, 30000);
    const tick = setInterval(() => setTick((n) => n + 1), 30000);
    const onFoco = () => document.visibilityState === "visible" && carregar();
    document.addEventListener("visibilitychange", onFoco);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onFoco);
    };
  }, [token, carregar]);

  /* polling de placar ao vivo: 60s quando há jogo em andamento.
     A janela é limitada a ~3h após o kickoff: sem isso, qualquer jogo passado
     sem resultado lançado (órfão) mantinha temJogoVivo=true pra sempre, fazendo
     todos os clientes martelarem a football-data eternamente por jogos que nem
     estão acontecendo (combinado com o rate limit, derruba o placar ao vivo). */
  /* 4h, não 3h: um mata-mata com prorrogação + pênaltis dura ~3h do kickoff ao
     apito final; 4h dá folga pra não cortar o polling no clímax. Ainda é uma
     janela fechada, então jogo órfão (passado sem placar) para de pollar. */
  const JANELA_VIVO = 4 * 60 * 60 * 1000;
  const temJogoVivo = !!estado && estado.jogos.some((m) => {
    if (!m.kickoff || temResultado(m)) return false;
    const decorrido = (Date.now() + offsetRef.current) - new Date(m.kickoff).getTime();
    return decorrido >= 0 && decorrido <= JANELA_VIVO;
  });
  useEffect(() => {
    if (!token || !temJogoVivo) return;
    const buscar = () =>
      api(`/api/futebol?t=${encodeURIComponent(token)}&acao=placar-vivo`)
        .then(carregar)
        .catch(() => {});
    buscar();
    const id = setInterval(buscar, 60000);
    return () => clearInterval(id);
  }, [token, temJogoVivo]); // eslint-disable-line react-hooks/exhaustive-deps

  const irParaPalpites = useCallback((jogoId) => {
    setJogoPreSel(jogoId);
    setTab("palpites");
  }, []);

  /* abre a aba Jogos já com o modal de estatísticas do jogo aberto */
  const verEstatisticas = useCallback((jogoId) => {
    setStatsPreSel(jogoId);
    setTab("jogos");
  }, []);

  /* hora do SERVIDOR (relógio do celular do amigo não manda aqui) */
  const agoraServ = () => new Date(Date.now() + offsetRef.current);
  const comecou = (m) => !!m.kickoff && new Date(m.kickoff) <= agoraServ();

  if (!token)
    return (
      <Casca>
        <div className="vazio entra-1">
          <span className="bola-quica" aria-hidden="true">⚽</span>
          <span>Este bolão é por convite — peça seu link de acesso ao organizador do grupo.</span>
        </div>
      </Casca>
    );

  if (erroAuth && !estado)
    return (
      <Casca>
        <div className="vazio entra-1">
          <span className="bola-quica" aria-hidden="true">⚽</span>
          <span>{erroAuth}</span>
        </div>
      </Casca>
    );

  if (!estado)
    return (
      <Casca>
        <div className="carregando"><span className="bola-quica">⚽</span> Abrindo o bolão…</div>
      </Casca>
    );

  /* mapa de palpites: jogoId -> participanteId -> {h, a} */
  const palpitesMap = {};
  for (const p of estado.palpites) {
    (palpitesMap[p.jogo_id] ||= {})[p.participante_id] = { h: p.h, a: p.a, atualizado_em: p.atualizado_em };
  }
  const contagensMap = {};
  for (const c of estado.contagens) contagensMap[c.jogo_id] = c.total;

  const hojeKey = fmtSP(Date.now() + offsetRef.current);

  const antecedenciaMap = {};
  for (const r of estado.antecedenciaMedia || []) antecedenciaMap[r.participante_id] = r.segundos;

  const ranking = estado.participantes
    .map((p) => calcularStats(p, estado, palpitesMap, { jogos: estado.jogos, hojeKey, chaveData }))
    .sort((a, b) => compararRanking(a, b, antecedenciaMap));

  /* Campeão do bolão: só depois que os DOIS bônus especiais são confirmados
     (na prática, só acontece depois da final). "campeões" no plural cobre o
     raro empate que sobrevive a todos os critérios de desempate — reusa o
     próprio compararRanking pra achar quem empatou de verdade com o 1º. */
  const bolaoEncerrado = !!(estado.resultadoEspecial?.campeao?.confirmado && estado.resultadoEspecial?.artilheiro?.confirmado);
  const campeoesDoBolao = bolaoEncerrado && ranking.length > 0
    ? ranking.filter((p) => compararRanking(p, ranking[0], antecedenciaMap) === 0)
    : [];

  /* posições antes dos jogos de hoje — para setas de tendência.
     Usa o MESMO comparador do ranking (compararRanking), só que sobre os jogos
     de antes de hoje. Antes usava um comparador diferente (por nome), o que
     gerava setas ↑/↓ falsas entre empatados — item M2 do review. */
  const posAntes = {};
  const temJogoEncerradoHoje = estado.jogos.some(
    (m) => temResultado(m) && m.kickoff && chaveData(m.kickoff) === hojeKey
  );
  if (temJogoEncerradoHoje) {
    const jogosAntes = estado.jogos.filter(
      (m) => !(m.kickoff && chaveData(m.kickoff) === hojeKey)
    );
    estado.participantes
      .map((p) => calcularStats(p, estado, palpitesMap, { jogos: jogosAntes }))
      .sort((a, b) => compararRanking(a, b, antecedenciaMap))
      .forEach((p, i) => { posAntes[p.id] = i; });
  }

  const encerrados = estado.jogos.filter(temResultado).length;
  /* "tem placar" inclui jogo ao vivo: o ranking já acende com pontos parciais — M4 */
  const comPlacar = estado.jogos.filter(temPlacar).length;
  const ehAdmin = estado.eu.isAdmin;
  const euParticipante = estado.participantes.find((p) => p.id === estado.eu.id);

  return (
    <Casca>
      <header className="topo entra-1">
        <div className="topo-acoes">
          <button
            className="regras-btn"
            onClick={() => setAbrirRegras(true)}
            aria-label="Ver regras do bolão"
            title="Regras"
          >?</button>
          {estado.eu.id !== null && (
            <button
              className="avatar-header-btn"
              onClick={() => setAbrirPerfil((v) => !v)}
              title="Editar perfil"
              aria-label="Editar avatar"
            >
              <Avatar
                nome={estado.eu.nome}
                emoji={euParticipante?.avatarEmoji}
                cor={euParticipante?.avatarCor}
                size={36}
              />
            </button>
          )}
        </div>
        <div className="topo-eyebrow">
          COPA DO MUNDO · 2026{bolaoEncerrado && <span className="topo-encerrada"> · ENCERRADA</span>}
        </div>
        <h1 className="topo-titulo">BOLÃO DOS GURIS</h1>
        <div className="topo-divider" aria-hidden="true" />
        <div className="topo-stats">
          <span>⚽ {estado.participantes.length} jogadores</span>
          <span className="topo-stats-sep" aria-hidden="true">·</span>
          <span>{encerrados} encerrado{encerrados === 1 ? "" : "s"}</span>
        </div>
      </header>

      {bolaoEncerrado && euParticipante && (
        <BannerRetrospecto onAbrir={() => setAbrirRetrospecto(true)} />
      )}

      {abrirRegras && <ModalRegras onFechar={() => setAbrirRegras(false)} />}
      {abrirPagamento && <ModalPagamento onFechar={() => setAbrirPagamento(false)} />}
      {abrirLembrete && !abrirPagamento && (() => {
        const { pendentes, nearest } = analisarLembrete(estado, Date.now() + offsetRef.current);
        return nearest ? (
          <ModalLembretePalpites
            pendentes={pendentes}
            nearest={nearest}
            offsetMs={offsetRef.current}
            onPalpitar={palpitarDoLembrete}
            onFechar={fecharLembrete}
          />
        ) : null;
      })()}

      {abrirPerfil && estado.eu.id !== null && (
        <PerfilPicker
          nome={estado.eu.nome}
          emoji={euParticipante?.avatarEmoji || ""}
          cor={euParticipante?.avatarCor || ""}
          onSalvar={salvarAvatar}
          onFechar={() => setAbrirPerfil(false)}
          euId={estado.eu.id}
          isAdmin={estado.eu.isAdmin}
          estado={estado}
          palpitesMap={palpitesMap}
          ranking={ranking}
        />
      )}

      {!proximoFechado && (
        <ProximoJogo
          jogos={estado.jogos}
          offsetMs={offsetRef.current}
          onFechar={() => setProximoFechado(true)}
          onNavegar={irParaPalpites}
        />
      )}

      {participanteModal && (
        <ModalPalpites
          participante={participanteModal}
          jogos={estado.jogos}
          palpitesMap={palpitesMap}
          euId={estado.eu.id}
          onFechar={() => setParticipanteModal(null)}
        />
      )}

      {campeaoModalAberto && campeoesDoBolao.length > 0 && (
        <ModalCampeaoBolao
          campeoes={campeoesDoBolao}
          estado={estado}
          palpitesMap={palpitesMap}
          euId={estado.eu.id}
          onFechar={() => setCampeaoModalAberto(false)}
        />
      )}

      {abrirRetrospecto && euParticipante && (
        <RetrospectoCopa
          participanteId={estado.eu.id}
          estado={estado}
          palpitesMap={palpitesMap}
          onFechar={() => setAbrirRetrospecto(false)}
        />
      )}

      <nav className="abas entra-2" role="tablist">
        {[
          ["ranking", "Ranking"],
          ["jogos", "Jogos"],
          ["palpites", "Palpites"],
          ["campeao", "Bônus"],
          ["galera", "Galera"],
        ].map(([id, rotulo]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "aba ativa" : "aba"}
            onClick={() => { setTab(id); try { localStorage.setItem("bolao-tab", id); } catch {} }}
          >
            {rotulo}
          </button>
        ))}
      </nav>

      <main key={tab} className="conteudo-aba">
        {tab === "ranking" && (
          <Ranking
            ranking={ranking}
            temJogos={comPlacar > 0}
            primeiraVez={!rankingJaAbriu.current}
            aoAbrir={() => { rankingJaAbriu.current = true; }}
            posAntes={posAntes}
            onClickParticipante={setParticipanteModal}
            palpitesMap={palpitesMap}
            jogos={estado.jogos}
            euId={estado.eu.id}
            campeoes={campeoesDoBolao}
            onAbrirCampeao={() => setCampeaoModalAberto(true)}
          />
        )}
        {tab === "jogos" && (
          <Jogos
            estado={estado}
            palpitesMap={palpitesMap}
            contagensMap={contagensMap}
            comecou={comecou}
            ehAdmin={ehAdmin}
            token={token}
            recarregar={carregar}
            offsetMs={offsetRef.current}
            statsInicial={statsPreSel}
            onStatsConsumido={() => setStatsPreSel(null)}
            onIrParaPalpites={irParaPalpites}
          />
        )}
        {tab === "palpites" && (
          <Palpites
            estado={estado}
            palpitesMap={palpitesMap}
            comecou={comecou}
            token={token}
            recarregar={carregar}
            offsetMs={offsetRef.current}
            jogoInicial={jogoPreSel}
            onVerStats={verEstatisticas}
          />
        )}
        {tab === "campeao" && (
          <Campeao
            token={token}
            euId={estado.eu.id}
            artilheiroGols={estado.artilheiroGols || {}}
            selecoesEliminadas={estado.selecoesEliminadas || []}
            resultadoEspecial={estado.resultadoEspecial}
            premiadosArtilheiro={estado.premiadosArtilheiro || []}
          />
        )}
        {tab === "galera" && (
          <Galera estado={estado} ehAdmin={ehAdmin} token={token} recarregar={carregar} installPrompt={installPrompt} onInstalled={() => setInstallPrompt(null)} />
        )}
      </main>

      <footer className="rodape entra-3">
        <span className="ponto-salvo" aria-hidden="true"></span>
        Placar compartilhado · atualiza sozinho
      </footer>
    </Casca>
  );
}

function Casca({ children }) {
  return (
    <div className="bolao-root">
      <Estilo />
      {children}
    </div>
  );
}

/* ================= CONFETE ================= */
function Confete() {
  const [pecas] = useState(() =>
    Array.from({ length: 64 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 2.6,
      dur: 2.8 + Math.random() * 2,
      cor: ["#ffc53d","#4ade80","#60a5fa","#f472b6","#a78bfa","#fb923c","#ffffff"][i % 7],
      w: 6 + Math.floor(Math.random() * 8),
    }))
  );
  return (
    <div className="confete-wrap" aria-hidden="true">
      {pecas.map((p) => (
        <div
          key={p.id}
          className="confete-peca"
          style={{
            left: `${p.left}%`,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
            background: p.cor,
            width: `${p.w}px`,
            height: `${Math.round(p.w * 0.45)}px`,
          }}
        />
      ))}
    </div>
  );
}

/* ================= RANKING ================= */
function LedPontos({ valor }) {
  const v = useCountUp(valor);
  return <span className="col-pts led">{v}</span>;
}

/* selinho "⚡ parcial": aparece onde os pontos incluem um jogo AO VIVO,
   que ainda pode mudar (item M4 do review). */
function SeloParcial({ style }) {
  return (
    <span
      title="Inclui pontos de jogo ao vivo — ainda pode mudar"
      style={{ fontSize: "10px", fontWeight: 700, color: "#ffb020", letterSpacing: ".03em", whiteSpace: "nowrap", ...style }}
    >
      ⚡ parcial
    </span>
  );
}

/* frase do critério que desempatou (chave = ícone fixo de criterioDesempate),
   usada na legenda abaixo do pódio. */
const CRIT_FRASE = {
  "🎯": "ter mais placares exatos",
  "🏆": "ter acertado a campeã",
  "⚽": "ter acertado o artilheiro",
  "✅": "ter mais resultados certos",
  "⏱": "palpitar mais cedo",
};
const ORDINAL = ["1º", "2º", "3º"];

/* Pódio visual do top 3 — mesma paleta do app (ouro âmbar / prata / bronze),
   reusa o Avatar. Ordem na tela: 2º à esquerda, 1º no centro (maior), 3º à direita. */
function Podio({ top3, ranking, posAntes, onClick, euId }) {
  const cols = [
    { p: top3[1], rank: 1, cls: "podio2", ped: "podio-ped-2" },
    { p: top3[0], rank: 0, cls: "podio1", ped: "podio-ped-1" },
    { p: top3[2], rank: 2, cls: "podio3", ped: "podio-ped-3" },
  ]
    .filter((c) => c.p)
    /* desempate: só quando empata em pontos com o próximo colocado */
    .map((c) => ({ ...c, crit: ranking[c.rank + 1] ? criterioDesempate(c.p, ranking[c.rank + 1]) : null }));
  /* empates entre colocados do pódio viram uma legenda abaixo — assim o pódio
     em si fica sempre limpo (sem selo encavalando o número do pedestal). */
  const desempates = cols.filter((c) => c.crit);
  return (
    <>
      <div className="podio-wrap" role="list" aria-label="Pódio">
        {cols.map(({ p, rank, cls, ped }) => {
          const subiu = posAntes[p.id] !== undefined && posAntes[p.id] > rank;
          const caiu = posAntes[p.id] !== undefined && posAntes[p.id] < rank;
          return (
            <button
              key={p.id}
              className={"podio-col " + cls}
              onClick={() => onClick(p)}
              role="listitem"
              title={`Ver palpites de ${p.nome}`}
            >
              {rank === 0 && <span className="podio-crown" aria-hidden="true">👑</span>}
              <span className="podio-av">
                <Avatar nome={p.nome} emoji={p.avatarEmoji} cor={p.avatarCor} size={rank === 0 ? 60 : 48} />
              </span>
              <span className="podio-nome">{p.nome}{p.id === euId ? " (você)" : ""}</span>
              <span className="podio-pts">{p.pontos} pts</span>
              <span className="podio-exatos">
                🎯 {p.exatos} · ✓ {p.resultados}{p.bonus > 0 ? ` · +${p.bonus}` : ""}
                {subiu && <span className="trend-up"> ↑</span>}
                {caiu && <span className="trend-down"> ↓</span>}
              </span>
              <span className={"podio-ped " + ped}>{rank + 1}</span>
            </button>
          );
        })}
      </div>
      {desempates.length > 0 && (
        <div className="podio-legenda">
          <span className="podio-legenda-tit">Desempate</span>
          {desempates.map(({ p, rank, crit }) => (
            <span key={p.id} className="podio-legenda-item">
              <span className="podio-legenda-ico" aria-hidden="true">{crit.icon}</span>
              <b>{p.nome}{p.id === euId ? " (você)" : ""}</b> fica em {ORDINAL[rank]} por {CRIT_FRASE[crit.icon] || "critério de desempate"}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function Ranking({ ranking, temJogos, primeiraVez, aoAbrir, posAntes, onClickParticipante, palpitesMap, jogos, euId, campeoes, onAbrirCampeao }) {
  const temAoVivo = (jogos || []).some((m) => m.live && temPlacar(m));
  useEffect(() => { aoAbrir(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (ranking.length === 0)
    return <Vazio texto="O organizador ainda não cadastrou os participantes." />;

  /* "você" (se for participante) p/ o painel de status; pódio visual do top 3
     só quando já há pontos — senão cai na lista plana de sempre. */
  const eu = euId != null ? ranking.find((p) => p.id === euId) : null;
  const euPos = eu ? ranking.indexOf(eu) + 1 : null;
  const podioAtivo = temJogos && ranking.length >= 3 && ranking[0].pontos > 0;
  const top3 = podioAtivo ? ranking.slice(0, 3) : [];
  const linhas = podioAtivo
    ? ranking.slice(3).map((p, k) => ({ p, i: k + 3 }))
    : ranking.map((p, i) => ({ p, i }));
  return (
    <div>
      {primeiraVez && ranking.some((p) => p.exatosHoje > 0) && <Confete />}
      <BannerCampeaoBolao campeoes={campeoes} onAbrir={onAbrirCampeao} />
      {!temJogos && (
        <p className="dica">Nenhum jogo encerrado ainda — o placar acende quando entrar o primeiro resultado.</p>
      )}
      {temAoVivo && (
        <div style={{ textAlign: "right", margin: "0 2px 6px" }}>
          <SeloParcial /> <span style={{ fontSize: "10px", color: "#9aa" }}>· ranking conta o jogo ao vivo</span>
        </div>
      )}
      {eu && (
        <button className="meu-status" onClick={() => onClickParticipante(eu)} title="Ver seus palpites">
          <span className="meu-status-l">
            <span className="meu-status-label">SUA POSIÇÃO</span>
            <span className="meu-status-pos">{euPos}º<small> / {ranking.length}</small></span>
          </span>
          <span className="meu-status-r">
            <span className="meu-status-pts"><b>{eu.pontos}</b> pts</span>
            <span className="meu-status-sub">🎯 {eu.exatos} exatos · ✓ {eu.resultados} result.</span>
          </span>
        </button>
      )}

      {podioAtivo && (
        <Podio top3={top3} ranking={ranking} posAntes={posAntes} onClick={onClickParticipante} euId={euId} />
      )}

      <div className="placar">
        <div className="placar-cab">
          <span className="col-pos">#</span>
          <span className="col-nome">PARTICIPANTE</span>
          <span className="col-num col-num-hd" title="Placares exatos">🎯<br/>EXATOS</span>
          <span className="col-num col-num-hd" title="Resultados certos">✓<br/>RESULT.</span>
          <span className="col-pts">PTS</span>
        </div>
        {linhas.map(({ p, i }) => {
          const podio = p.pontos > 0 && i < 3;
          const cls = "placar-linha"
            + (podio && i === 0 ? " podio-ouro" : "")
            + (podio && i === 1 ? " podio-prata" : "")
            + (podio && i === 2 ? " podio-bronze" : "");
          const medalha = podio ? ["🥇", "🥈", "🥉"][i] : i + 1;
          return (
          <div
            key={p.id}
            className={cls}
            style={{ "--i": Math.min(i, 10), position: "relative", overflow: "visible", cursor: "pointer" }}
            onClick={() => onClickParticipante(p)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClickParticipante(p); } }}
            role="button"
            tabIndex={0}
            title={`Ver palpites de ${p.nome}`}
          >
            {p.exatosHoje > 0 && primeiraVez && (
              <span
                className="gol-burst"
                style={{ animationDelay: `${0.25 + i * 0.12}s` }}
                aria-hidden="true"
              >
                ⚽ GOOOL!
              </span>
            )}
            <span className={"col-pos" + (podio ? " col-pos-medal" : "")}>{medalha}</span>
            <span className="col-nome">
              <span className="col-nome-inner">
                <Avatar nome={p.nome} emoji={p.avatarEmoji} cor={p.avatarCor} size={24} />
                <span>{p.nome}{i === 0 && p.pontos > 0 ? " 🏆" : ""}</span>
                {p.bonus > 0 && <span className="bonus-badge" title={`bônus: +${p.bonus} pts`}>+{p.bonus}</span>}
                {posAntes[p.id] !== undefined && posAntes[p.id] > i && (
                  <span className="trend-up">↑{posAntes[p.id] - i}</span>
                )}
                {posAntes[p.id] !== undefined && posAntes[p.id] < i && (
                  <span className="trend-down">↓{i - posAntes[p.id]}</span>
                )}
                {(() => {
                  const prox = ranking[i + 1];
                  if (!prox) return null;
                  const c = criterioDesempate(p, prox);
                  if (!c) return null;
                  return (
                    <span className="desempate-badge" title={`Desempatado por: ${c.label}`}>
                      {c.icon} {c.label}
                    </span>
                  );
                })()}
              </span>
              <span className="col-detalhe-mobile">🎯 {p.exatos} exatos · ✓ {p.resultados} result.</span>
            </span>
            <span className="col-num">{p.exatos}</span>
            <span className="col-num">{p.resultados}</span>
            <LedPontos valor={p.pontos} />
          </div>
          );
        })}
      </div>
      <GraficoEvolucao ranking={ranking} palpitesMap={palpitesMap} jogos={jogos} euId={euId} />
      <EstatisticasInutils ranking={ranking} palpitesMap={palpitesMap} jogos={jogos} />
    </div>
  );
}

/* ================= GRÁFICO DE EVOLUÇÃO ================= */
function GraficoEvolucao({ ranking, palpitesMap, jogos, euId }) {
  const [aberto, setAberto] = useState(false);

  /* âncora fixa em destaque: "você" se for participante, senão o líder. */
  const idPadrao = (euId != null && ranking.some((p) => p.id === euId))
    ? euId
    : (ranking[0]?.id ?? null);
  const [destacados, setDestacados] = useState(() => new Set(idPadrao != null ? [idPadrao] : []));
  const toggle = (id) => {
    setDestacados((prev) => {
      const s = new Set(prev);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  };

  /* inclui jogo ao vivo (temPlacar) para o último ponto bater com o ranking — M4 */
  const jogosEncerrados = jogos
    .filter(temPlacar)
    .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  const temAoVivo = jogosEncerrados.some((m) => m.live);

  if (jogosEncerrados.length < 2 || ranking.length < 2) return null;

  const W = 560, H = 220;
  const ml = 28, mr = 84, mt = 12, mb = 24;
  const pw = W - ml - mr;
  const ph = H - mt - mb;
  const n = jogosEncerrados.length;

  /* com muitos jogos, o ponto-por-rodada vira poeira visual: deixa só a linha
     (e o ponto final). E afina os rótulos do eixo X pra não se amontoarem. */
  const mostrarPontos = n <= 14;
  const passoX = Math.ceil(n / 9);
  const mostrarX = (i) => i === 0 || i === n - 1 || (i % passoX === 0 && n - 1 - i >= passoX);

  const xOf = (i) => ml + (n === 1 ? pw / 2 : (i * pw) / (n - 1));

  /* Cor ÚNICA e estável por participante: matizes espalhados por HSL, ordenados
     por id (não pela posição no ranking) — assim a cor de cada um não muda quando
     sobe/desce no ranking, e nunca se repete, pra qualquer número de participantes.
     Não usa avatarCor de propósito: dois participantes podem ter o mesmo avatarCor,
     o que geraria cor repetida no gráfico (os avatares na lista seguem normais). */
  const ordemEstavel = [...ranking].sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0));
  const corPorId = new Map(
    ordemEstavel.map((p, i) => [p.id, `hsl(${Math.round((i * 360) / ordemEstavel.length)}, 68%, 60%)`])
  );

  const series = ranking.map((p) => {
    let acum = p.bonus;
    const pts = jogosEncerrados.map((j) => {
      acum += pontosComPeso(palpitesMap[j.id]?.[p.id], j);
      return acum;
    });
    return { ...p, pts, cor: corPorId.get(p.id) };
  });

  const maxPts = Math.max(...series.flatMap((s) => s.pts), 1);
  const yOf = (v) => mt + ph - (v / maxPts) * ph;

  /* rótulos dos nomes à direita: posição ideal = y do último ponto. Quando dois
     ficam colados (empate ou pontuação próxima), os nomes se sobrepõem — então
     empilha com espaçamento mínimo (GAP) e, se estourar embaixo, sobe o bloco
     todo. Cada rótulo nudgeado ganha um fio-guia até a ponta real da linha. */
  const GAP = 12;
  const labels = series
    .filter((s) => destacados.has(s.id)) /* só os destacados ganham nome */
    .map((s) => ({
      nome: s.nome.split(" ")[0].slice(0, 9),
      cor: s.cor,
      yReal: yOf(s.pts[n - 1]),
    }))
    .sort((a, b) => a.yReal - b.yReal);
  let prevY = -Infinity;
  for (const L of labels) { L.y = Math.max(L.yReal, prevY + GAP); prevY = L.y; }
  const estouro = prevY - (mt + ph);
  if (estouro > 0) for (const L of labels) L.y -= estouro;
  if (labels.length && labels[0].y < mt) { const d = mt - labels[0].y; for (const L of labels) L.y += d; }

  return (
    <div className="grafico-bloco">
      <button className="grafico-toggle" onClick={() => setAberto((v) => !v)}>
        📈 Evolução do ranking {temAoVivo && <SeloParcial />} <span className="grafico-chevron">{aberto ? "▲" : "▼"}</span>
      </button>
      {aberto && (
        <>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", marginTop: 8 }}>
          {/* grade */}
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <line key={f} x1={ml} y1={mt + ph * (1 - f)} x2={ml + pw} y2={mt + ph * (1 - f)}
              stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="4,4" />
          ))}
          {/* eixos */}
          <line x1={ml} y1={mt} x2={ml} y2={mt + ph} stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
          <line x1={ml} y1={mt + ph} x2={ml + pw} y2={mt + ph} stroke="rgba(255,255,255,0.18)" strokeWidth="1" />

          {/* linhas: pelotão apagado primeiro (fundo), destacados por cima */}
          {[...series]
            .sort((a, b) => (destacados.has(a.id) ? 1 : 0) - (destacados.has(b.id) ? 1 : 0))
            .map((s) => {
              const on = destacados.has(s.id);
              const pontos = s.pts.map((v, i) => `${xOf(i)},${yOf(v)}`).join(" ");
              return (
                <g key={s.id}>
                  <polyline points={pontos} fill="none"
                    stroke={on ? s.cor : "rgba(255,255,255,0.10)"}
                    strokeWidth={on ? 2.6 : 1}
                    strokeLinejoin="round" strokeLinecap="round" opacity={on ? 0.95 : 1} />
                  {on && (mostrarPontos
                    ? s.pts.map((v, i) => <circle key={i} cx={xOf(i)} cy={yOf(v)} r="3" fill={s.cor} />)
                    : <circle cx={xOf(n - 1)} cy={yOf(s.pts[n - 1])} r="3.5" fill={s.cor} />)}
                </g>
              );
            })}

          {/* nomes à direita, sem sobreposição, com fio-guia até a ponta da linha */}
          {labels.map((L, idx) => (
            <g key={idx}>
              {Math.abs(L.y - L.yReal) > 1.5 && (
                <line x1={ml + pw} y1={L.yReal} x2={ml + pw + 7} y2={L.y}
                  stroke={L.cor} strokeWidth="1" opacity="0.4" />
              )}
              <text x={ml + pw + 10} y={L.y} fill={L.cor}
                fontSize="10" fontFamily="IBM Plex Mono, monospace" dominantBaseline="middle">
                {L.nome}
              </text>
            </g>
          ))}

          {/* rótulos eixo X (afinados pra não amontoar) */}
          {jogosEncerrados.map((j, i) => (
            mostrarX(i) && (
              <text key={j.id} x={xOf(i)} y={mt + ph + 16} fill="rgba(255,255,255,0.35)"
                fontSize="9" textAnchor="middle" fontFamily="IBM Plex Mono, monospace">
                {i + 1}
              </text>
            )
          ))}

          {/* rótulos eixo Y */}
          {[0, Math.round(maxPts / 2), maxPts].map((v) => (
            <text key={v} x={ml - 4} y={yOf(v) + 3} fill="rgba(255,255,255,0.35)"
              fontSize="9" textAnchor="end" fontFamily="IBM Plex Mono, monospace">
              {v}
            </text>
          ))}
        </svg>
        <div className="grafico-chips" role="group" aria-label="Comparar participantes">
          {series.map((s) => {
            const on = destacados.has(s.id);
            const eu = euId != null && s.id === euId;
            return (
              <button
                key={s.id}
                className={"grafico-chip" + (on ? " grafico-chip-on" : "")}
                onClick={() => toggle(s.id)}
                aria-pressed={on}
                style={on ? { borderColor: s.cor, color: s.cor } : undefined}
              >
                <span className="grafico-chip-dot" style={{ background: on ? s.cor : "rgba(255,255,255,.25)" }} />
                {s.nome.split(" ")[0].slice(0, 10)}{eu ? " (você)" : ""}
              </button>
            );
          })}
        </div>
        <p className="grafico-dica">Toque nos nomes pra comparar a evolução.</p>
        </>
      )}
    </div>
  );
}

/* ================= ESTATÍSTICAS INÚTEIS ================= */
function EstatisticasInutils({ ranking, palpitesMap, jogos }) {
  const [aberto, setAberto] = useState(false);

  const jogosEncerrados = jogos.filter(temResultado);
  if (jogosEncerrados.length < 5 || ranking.length < 2) return null;

  const plural = (n) => (n === 1 ? "" : "s");

  /* Retorna TODOS os participantes empatados no maior valor de `valorFn`.
     Devolve { ps, valor } ou null se o maior valor não atingir `min`. */
  const topEmpatados = (valorFn, min = 1) => {
    let max = -Infinity;
    for (const p of ranking) { const v = valorFn(p); if (v > max) max = v; }
    if (!Number.isFinite(max) || max < min) return null;
    const ps = ranking.filter((p) => valorFn(p) === max).sort((a, b) => a.nome.localeCompare(b.nome));
    return { ps, valor: max };
  };

  /* 🥄 Lanterna — verdadeiro último colocado, usando os MESMOS critérios de
     desempate do ranking (pontos → exatos → campeã → artilheiro → resultados).
     Só agrupa quem for idêntico em TODOS esses critérios. */
  const piorColocado = ranking[ranking.length - 1];
  const mesmaLanterna = (a, b) =>
    a.pontos === b.pontos &&
    a.exatos === b.exatos &&
    !!a.acertouCampeao === !!b.acertouCampeao &&
    !!a.acertouArtilheiro === !!b.acertouArtilheiro &&
    a.resultados === b.resultados;
  const lanternaPs = ranking.filter((p) => mesmaLanterna(p, piorColocado)).sort((a, b) => a.nome.localeCompare(b.nome));

  /* 🧊 Pé Frio — mais zeros em jogos encerrados */
  const contaZeros = (id) => jogosEncerrados.filter((m) => pontosDoPalpite(palpitesMap[m.id]?.[id], m) === 0).length;
  const peFrio = topEmpatados((p) => contaZeros(p.id), 1);

  /* 🔮 Otimista — maior média de gols palpitados (mín. 3 palpites em jogos encerrados) */
  const mediaById = {};
  for (const p of ranking) {
    const pals = jogosEncerrados.filter((m) => palpitesMap[m.id]?.[p.id]);
    mediaById[p.id] = pals.length < 3 ? -1
      : pals.reduce((acc, m) => acc + Number(palpitesMap[m.id][p.id].h) + Number(palpitesMap[m.id][p.id].a), 0) / pals.length;
  }
  const otimista = topEmpatados((p) => mediaById[p.id], 0);

  /* 🎯 Sniper — maior % de exatos entre quem palpitou mín. 3 jogos encerrados */
  const pctById = {};
  for (const p of ranking) {
    const comPalpite = jogosEncerrados.filter((m) => palpitesMap[m.id]?.[p.id]).length;
    pctById[p.id] = comPalpite < 3 ? -1 : (p.exatos / comPalpite) * 100;
  }
  const sniper = topEmpatados((p) => pctById[p.id], 0);

  /* ⚽ Sr. 1×0 — palpitou 1×0 mais vezes */
  const conta1x0 = (id) => jogos.filter((m) => { const pal = palpitesMap[m.id]?.[id]; return pal && Number(pal.h) === 1 && Number(pal.a) === 0; }).length;
  const sr1x0 = topEmpatados((p) => conta1x0(p.id), 1);

  /* 🦍 Trave — mais vezes que errou o placar exato por só 1 gol (em jogos encerrados) */
  const contaTrave = (id) => jogosEncerrados.filter((m) => {
    const pal = palpitesMap[m.id]?.[id];
    if (!pal) return false;
    return Math.abs(Number(pal.h) - m.gh) + Math.abs(Number(pal.a) - m.ga) === 1;
  }).length;
  const trave = topEmpatados((p) => contaTrave(p.id), 1);

  /* 🎰 Empatador — mais palpites de empate (h === a), acertando ou não */
  const contaEmpates = (id) => jogos.filter((m) => { const pal = palpitesMap[m.id]?.[id]; return pal && Number(pal.h) === Number(pal.a); }).length;
  const empatador = topEmpatados((p) => contaEmpates(p.id), 1);

  /* ⚖️ Equilibrista — cravou o empate: palpitou empate com o placar EXATO
     (ex.: apostou 2×2 e o jogo terminou 2×2) */
  const contaEmpateCravou = (id) => jogosEncerrados.filter((m) => {
    const pal = palpitesMap[m.id]?.[id];
    return pal && Number(pal.h) === Number(pal.a) && Number(pal.h) === m.gh && Number(pal.a) === m.ga;
  }).length;
  const equilibrista = topEmpatados((p) => contaEmpateCravou(p.id), 1);

  /* 🎆 Festival de Gols — maior nº de gols (soma h+a) num jogo encerrado em que
     CRAVOU o placar exato (não basta chutar uma goleada: tem que ter acertado) */
  const melhorSoma = (id) => {
    let best = -1;
    for (const m of jogosEncerrados) {
      const pal = palpitesMap[m.id]?.[id];
      if (!pal) continue;
      if (Number(pal.h) !== m.gh || Number(pal.a) !== m.ga) continue; // só placar exato
      const s = m.gh + m.ga;
      if (s > best) best = s;
    }
    return best;
  };
  const festival = topEmpatados((p) => melhorSoma(p.id), 4); // só conta se for goleada de verdade

  /* 🎇 Sonhador de Gols — maior nº de gols (soma h+a) que PALPITOU num jogo,
     acertando ou não (a contraparte honesta da Festival de Gols) */
  const melhorSomaPalpite = (id) => {
    let best = -1;
    for (const m of jogos) {
      const pal = palpitesMap[m.id]?.[id];
      if (!pal) continue;
      const s = Number(pal.h) + Number(pal.a);
      if (!Number.isNaN(s) && s > best) best = s;
    }
    return best;
  };
  const sonhador = topEmpatados((p) => melhorSomaPalpite(p.id), 4);

  /* 🐑 Manada / 🦄 Do Contra — quem mais seguiu (ou mais fugiu) do placar mais palpitado pela galera
     (só conta jogos com mín. 3 palpites e uma maioria real, mín. 2 iguais) */
  const seguiuManada = {};
  const fugiuManada = {};
  for (const m of jogos) {
    const palsJogo = ranking
      .map((p) => ({ id: p.id, pal: palpitesMap[m.id]?.[p.id] }))
      .filter((x) => x.pal);
    if (palsJogo.length < 3) continue;
    const cont = {};
    for (const { pal } of palsJogo) {
      const k = `${Number(pal.h)}-${Number(pal.a)}`;
      cont[k] = (cont[k] || 0) + 1;
    }
    let modK = null, modN = 0;
    for (const [k, n] of Object.entries(cont)) if (n > modN) { modN = n; modK = k; }
    if (modN < 2) continue; // sem maioria de verdade
    for (const { id, pal } of palsJogo) {
      if (`${Number(pal.h)}-${Number(pal.a)}` === modK) seguiuManada[id] = (seguiuManada[id] || 0) + 1;
      else fugiuManada[id] = (fugiuManada[id] || 0) + 1;
    }
  }
  const manada = topEmpatados((p) => seguiuManada[p.id] || 0, 1);
  const doContra = topEmpatados((p) => fugiuManada[p.id] || 0, 1);

  const premios = [
    { emoji: "🔦", titulo: "Lanterna", ps: lanternaPs, detalhe: `${piorColocado.pontos} pt${plural(piorColocado.pontos)} · ${piorColocado.exatos} exato${plural(piorColocado.exatos)}` },
    peFrio && { emoji: "🧊", titulo: "Pé Frio", ps: peFrio.ps, detalhe: `${peFrio.valor} zero${plural(peFrio.valor)} em jogos encerrados` },
    otimista && { emoji: "🔮", titulo: "Otimista", ps: otimista.ps, detalhe: `média ${otimista.valor.toFixed(1)} gols/jogo` },
    sniper && { emoji: "🎯", titulo: "Sniper", ps: sniper.ps, detalhe: `${sniper.valor.toFixed(0)}% de placares exatos` },
    sr1x0 && { emoji: "⚽", titulo: "Sr. 1×0", ps: sr1x0.ps, detalhe: `palpitou 1×0 em ${sr1x0.valor} jogo${plural(sr1x0.valor)}` },
    trave && { emoji: "🦍", titulo: "Trave", ps: trave.ps, detalhe: `errou por 1 gol em ${trave.valor} jogo${plural(trave.valor)}` },
    empatador && { emoji: "🎰", titulo: "Empatador", ps: empatador.ps, detalhe: `palpitou empate em ${empatador.valor} jogo${plural(empatador.valor)}` },
    equilibrista && { emoji: "⚖️", titulo: "Equilibrista", ps: equilibrista.ps, detalhe: `cravou o empate em ${equilibrista.valor} jogo${plural(equilibrista.valor)}` },
    festival && { emoji: "🎆", titulo: "Festival de Gols", ps: festival.ps, detalhe: `cravou um jogo de ${festival.valor} gols` },
    sonhador && { emoji: "🎇", titulo: "Sonhador de Gols", ps: sonhador.ps, detalhe: `palpitou um jogo de ${sonhador.valor} gols` },
    manada && { emoji: "🐑", titulo: "Manada", ps: manada.ps, detalhe: `seguiu a maioria em ${manada.valor} jogo${plural(manada.valor)}` },
    doContra && { emoji: "🦄", titulo: "Do Contra", ps: doContra.ps, detalhe: `discordou da maioria em ${doContra.valor} jogo${plural(doContra.valor)}` },
  ].filter(Boolean);

  return (
    <div style={{ marginTop: "20px" }}>
      <button className="stats-toggle" onClick={() => setAberto((v) => !v)} aria-expanded={aberto}>
        <span>🏅 ESTATÍSTICAS INÚTEIS</span>
        <span className="seletor-data-chevron">{aberto ? "▾" : "▸"}</span>
      </button>
      {aberto && (
        <div className="stats-grid">
          {premios.map(({ emoji, titulo, ps, detalhe }, i) => (
            <div key={titulo} className="stats-card entra-cartao" style={{ "--i": i }}>
              <div className="stats-emoji">{emoji}</div>
              <div className="stats-info">
                <div className="stats-titulo">
                  {titulo}
                  {ps.length > 1 && <span className="stats-empate"> (empate)</span>}
                </div>
                {ps.map((p) => (
                  <div key={p.id} className="stats-nome">
                    <Avatar nome={p.nome} emoji={p.avatarEmoji} cor={p.avatarCor} size={20} />
                    {p.nome}
                  </div>
                ))}
                <div className="stats-detalhe">{detalhe}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================= AGRUPAMENTO POR DATA ================= */

const DIAS_SEMANA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

const fmtSP = (ts) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ts));

const chaveData = (iso) => (iso ? fmtSP(new Date(iso).getTime()) : "__semdata__");

const labelData = (chave, offsetMs = 0) => {
  if (chave === "__semdata__") return "Sem data definida";
  const agora = Date.now() + offsetMs;
  if (chave === fmtSP(agora))              return `Hoje · ${chave.slice(8)}/${chave.slice(5, 7)}`;
  if (chave === fmtSP(agora + 86400000))   return `Amanhã · ${chave.slice(8)}/${chave.slice(5, 7)}`;
  const dow = new Date(chave + "T12:00:00").getDay();
  return `${DIAS_SEMANA[dow]} · ${chave.slice(8)}/${chave.slice(5, 7)}`;
};

const agruparPorData = (jogos) => {
  const grupos = new Map();
  for (const m of jogos) {
    const chave = chaveData(m.kickoff);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(m);
  }
  return [...grupos.entries()];
};

/* ================= COUNTDOWN ================= */

const MSGS_CD = [
  { min: 24 * 60, msg: "Calma, ainda dá pra palpitar ☕",                cls: "cd-ok" },
  { min: 12 * 60, msg: "Hoje tem jogo! Não esquece o palpite 👊",        cls: "cd-ok" },
  { min:  6 * 60, msg: "O palpite não vai se fazer sozinho 😤",          cls: "cd-ok" },
  { min:  2 * 60, msg: "Tic tac… hora de decidir! ⏰",                   cls: "cd-atencao" },
  { min:      60, msg: "Corre que vai fechar! 🏃💨",                     cls: "cd-atencao" },
  { min:      30, msg: "MENOS DE 1 HORA! Vai deixar pra quando?! 🚨",    cls: "cd-alerta" },
  { min:      15, msg: "Você vai deixar pra última hora mesmo?? 😅🔥",   cls: "cd-alerta" },
  { min:       5, msg: "TÁ FECHANDO!! ENTRA LOGO PELO AMOR!! 💀🔥",      cls: "cd-critico" },
  { min:       1, msg: "ÚLTIMO MINUTO!!! QUE SUFOCO!!! 😱",              cls: "cd-critico" },
  { min:       0, msg: "FECHA EM SEGUNDOS!!! MISERICÓRDIA!! 🆘",         cls: "cd-critico" },
];

function Countdown({ kickoff, offsetMs = 0 }) {
  const calc = useCallback(
    () => new Date(kickoff).getTime() - (Date.now() + offsetMs),
    [kickoff, offsetMs]
  );
  const [restante, setRestante] = useState(calc);
  useEffect(() => {
    const id = setInterval(() => setRestante(calc()), 1000);
    return () => clearInterval(id);
  }, [calc]);

  if (restante <= 0) return null;

  const totalMin = restante / 60000;
  const { msg, cls } = MSGS_CD.find((m) => totalMin > m.min) ?? MSGS_CD.at(-1);
  const h = Math.floor(restante / 3600000);
  const min = Math.floor((restante % 3600000) / 60000);
  const seg = Math.floor((restante % 60000) / 1000);
  const tempo = h > 0
    ? `${h}h ${String(min).padStart(2, "0")}min`
    : min > 0
    ? `${min}min ${String(seg).padStart(2, "0")}s`
    : `${seg}s`;

  return (
    <div className={`countdown ${cls}`} aria-live="polite">
      <span className="cd-msg">{msg}</span>
      <span className="cd-tempo">{tempo}</span>
    </div>
  );
}

/* ================= ESTATÍSTICAS DO JOGO (100% client-side) ================= */

/* grupo inferido dos nossos próprios jogos: na fase de grupos (round-robin de
   4), os times que enfrentam casa/fora são justamente os 4 do grupo. Mata-mata
   não tem grupo (devolve []). */
function grupoDoJogo(jogos, jogo) {
  if (jogo.fase !== "grupos") return [];
  const { casa: a, fora: b } = jogo;
  const set = new Set([a, b]);
  for (const j of jogos) {
    if (j.fase !== "grupos") continue;
    if (j.casa === a || j.fora === a || j.casa === b || j.fora === b) {
      set.add(j.casa); set.add(j.fora);
    }
  }
  return [...set];
}

/* tabela do grupo calculada dos nossos jogos (inclui ao vivo via temPlacar). */
function tabelaDoGrupo(jogos, times) {
  const tset = new Set(times);
  const tab = {};
  for (const t of times) tab[t] = { time: t, j: 0, v: 0, e: 0, d: 0, gp: 0, gc: 0, pts: 0 };
  for (const j of jogos) {
    if (j.fase !== "grupos" || !tset.has(j.casa) || !tset.has(j.fora) || !temPlacar(j)) continue;
    const A = tab[j.casa], B = tab[j.fora];
    A.j++; B.j++;
    A.gp += j.gh; A.gc += j.ga; B.gp += j.ga; B.gc += j.gh;
    if (j.gh > j.ga) { A.v++; A.pts += 3; B.d++; }
    else if (j.gh < j.ga) { B.v++; B.pts += 3; A.d++; }
    else { A.e++; B.e++; A.pts++; B.pts++; }
  }
  return Object.values(tab)
    .map((r) => ({ ...r, sg: r.gp - r.gc }))
    .sort((x, y) => y.pts - x.pts || y.sg - x.sg || y.gp - x.gp || x.time.localeCompare(y.time, "pt-BR"));
}

/* últimos jogos do time NO TORNEIO (só nossos dados), mais recentes primeiro. */
/* normaliza texto pra comparar/agrupar nomes: sem acento, sem caixa, sem borda.
   Usado pra casar o pick de artilheiro (texto livre) com o mapa de gols. */
const normTexto = (s) =>
  String(s ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();

/* Casa o nome do artilheiro real (digitado pelo admin) com o pick de um
   participante — tolerante a caixa, acento e sobrenome vs nome completo
   (ex.: "Mbappé" bate com "MBAPPE", "mbappe" e "Kylian Mbappe"). NÃO cobre
   erro de digitação (ex.: "Mbapé") — esses o admin marca na mão. É só DESTAQUE:
   a marcação de quem ganha os pontos continua manual (clique em "Marcar"). */
function bateArtilheiro(real, pick) {
  const a = normTexto(real), b = normTexto(pick);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const palavras = (s) => s.split(/\s+/).filter((w) => w.length >= 3);
  const setB = new Set(palavras(b));
  return palavras(a).some((w) => setB.has(w)); /* sobrenome/primeiro nome em comum */
}

/* Mesma seleção? Casa pelo código de bandeira (FLAG_CODES) quando existir — assim
   grafias variantes do MESMO time contam como iguais nas estatísticas (ex.:
   "Bosnia-Herzegovina" cadastrado na mão vs "Bósnia e Herzegovina" traduzido
   pelo robô, ambos → "ba"). Sem código nos dois, cai no nome exato. */
const mesmaSelecao = (a, b) => {
  if (a === b) return true;
  const ca = FLAG_CODES[a], cb = FLAG_CODES[b];
  return !!ca && ca === cb;
};

function formaDoTime(jogos, time, limite = 5) {
  return jogos
    .filter((j) => (mesmaSelecao(j.casa, time) || mesmaSelecao(j.fora, time)) && temPlacar(j) && j.kickoff)
    .sort((a, b) => new Date(b.kickoff) - new Date(a.kickoff))
    .slice(0, limite)
    .map((j) => {
      const emCasa = mesmaSelecao(j.casa, time);
      const gf = emCasa ? j.gh : j.ga;
      const gc = emCasa ? j.ga : j.gh;
      return { id: j.id, adversario: emCasa ? j.fora : j.casa, gf, gc, res: gf > gc ? "V" : gf < gc ? "D" : "E" };
    });
}

/* Snapshot de Elo (World Football Elo) por código de país — mesma chave do
   FLAG_CODES, então casa com o nome do jogo em PT ou EN. TOP 20 com valores
   REAIS de 24/06/2026 (eloratings.net/Wikipedia); demais calibrados na mesma
   escala. O auto-ajuste pelos resultados da Copa mantém os números frescos.
   Ainda é estimativa de favoritismo, não odds de mercado. */
const ELO_BASE = {
  // top 20 — valores reais (24/06/2026). EXCEÇÃO: Portugal calibrado na mão
  // (Elo cru ~1988) p/ refletir o favoritismo de mercado — o Elo o subestima
  // por causa da qualificação europeia mais leve frente à CONMEBOL.
  ar:2144, es:2134, fr:2090, "gb-eng":2028, pt:2035, br:2009, co:2006, nl:1972,
  de:1954, no:1951, jp:1925, ch:1914, mx:1912, hr:1896, ma:1877, dk:1869,
  it:1869, be:1869, ec:1864, uy:1851,
  // 21+ — calibrados na mesma escala
  at:1850, sn:1845, ir:1822, ua:1820, tr:1815, rs:1815, gr:1810, pl:1810,
  dz:1808, ci:1802, eg:1800, ca:1800, se:1798, py:1796, ng:1795, cm:1790,
  kr:1788, hu:1786, cz:1784, "gb-sct":1780, cd:1778, "gb-wls":1772, cl:1762,
  ve:1758, ml:1758, za:1750, gh:1740, tn:1732, au:1730, cv:1702, uz:1700,
  pa:1698, qa:1688, sa:1680, jm:1678, pe:1772, jo:1660, cr:1658, hn:1640,
  iq:1638, nz:1505,
  // adicionados 01/07/2026: participantes que faltavam na base (sem eles, as
  // "chances de ganhar" no modal de stats não apareciam — chancesDoJogo=null).
  us:1790, ba:1718,
};

/* Elo ajustado pelos resultados JÁ ENCERRADOS do torneio — mantém o snapshot
   fresco conforme a Copa anda. Fórmula padrão (K=40 + multiplicador de saldo). */
function eloAjustado(jogos) {
  const elo = { ...ELO_BASE };
  const finais = jogos
    .filter((j) => temResultado(j) && j.kickoff)
    .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  for (const j of finais) {
    const ca = FLAG_CODES[j.casa], cb = FLAG_CODES[j.fora];
    if (elo[ca] == null || elo[cb] == null) continue;
    const exp = 1 / (1 + Math.pow(10, -(elo[ca] - elo[cb]) / 400));
    const real = j.gh > j.ga ? 1 : j.gh < j.ga ? 0 : 0.5;
    const gd = Math.abs(j.gh - j.ga);
    const mult = gd <= 1 ? 1 : gd === 2 ? 1.5 : 1.75 + (gd - 3) / 8;
    const delta = 40 * mult * (real - exp);
    elo[ca] += delta; elo[cb] -= delta;
  }
  return elo;
}

/* probabilidades vitória/empate/derrota a partir do Elo (estimativa). */
function chancesDoJogo(elo, casa, fora) {
  const ea = elo[FLAG_CODES[casa]], eb = elo[FLAG_CODES[fora]];
  if (ea == null || eb == null) return null;
  const we = 1 / (1 + Math.pow(10, -(ea - eb) / 400)); // score esperado da casa (0..1)
  const empate = 0.30 * (1 - Math.abs(2 * we - 1));
  const casaP = Math.max(0, we - empate / 2);
  const foraP = Math.max(0, 1 - we - empate / 2);
  const s = casaP + empate + foraP || 1;
  return { casa: casaP / s, empate: empate / s, fora: foraP / s };
}

const STAT_RES_LABEL = { V: "Vitória", E: "Empate", D: "Derrota" };

function ModalEstatisticas({ jogo, jogos, onFechar }) {
  const grupo = grupoDoJogo(jogos, jogo);
  const tabela = grupo.length ? tabelaDoGrupo(jogos, grupo) : [];
  const chances = chancesDoJogo(eloAjustado(jogos), jogo.casa, jogo.fora);
  const pct = (x) => Math.round(x * 100);
  /* Elo e mercado discordam em jogos apertados; não cravamos "Favorito" quando
     a diferença de chance de vitória é pequena — mostramos "equilibrado". */
  const equilibrado = chances && Math.abs(chances.casa - chances.fora) < 0.06;

  /* Link puro de busca no Google (sem API): só "Time A x Time B", SEM a palavra
     "escalação" — com ela o Google abre o AI Overview (resposta em texto) em vez
     do card do jogo. Só os dois times caem no card esportivo, que traz placar,
     info e a aba de escalações, além de notícias dos times. */
  const urlEscalacao = `https://www.google.com/search?q=${encodeURIComponent(`${jogo.casa} x ${jogo.fora}`)}`;

  const blocoForma = (time) => {
    const forma = formaDoTime(jogos, time);
    return (
      <div className="stat-forma-bloco">
        <div className="stat-forma-time">
          <span className="stat-forma-nome">{fl(time)}{time}</span>
          <span className="stat-forma-badges">
            {forma.length === 0
              ? <span className="stat-forma-vazio">sem jogos ainda</span>
              : forma.map((f) => <span key={f.id} className={"stat-badge stat-badge-" + f.res} title={STAT_RES_LABEL[f.res]}>{f.res}</span>)}
          </span>
        </div>
        {forma.map((f) => (
          <div key={f.id} className="stat-forma-linha">
            <span className={"stat-res stat-res-" + f.res}>{STAT_RES_LABEL[f.res]}</span>
            <span className="stat-forma-placar">
              {fl(time)} <strong>{f.gf}–{f.gc}</strong> {fl(f.adversario)}{f.adversario}
            </span>
          </div>
        ))}
      </div>
    );
  };

  return createPortal(
    <div className="modal-overlay" onClick={onFechar}>
      <div className="modal-painel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-nome">📊 {jogo.casa} × {jogo.fora}</div>
          <button className="apagar" onClick={onFechar} aria-label="Fechar">✕</button>
        </div>

        {jogo.kickoff && <p className="stat-data">{fmtQuando(jogo)}</p>}

        <a className="stat-btn stat-btn-link" href={urlEscalacao} target="_blank" rel="noopener noreferrer">
          📋 Ver escalações dos times ↗
        </a>

        {chances && (
          <>
            <div className="secao-titulo">CHANCES DE GANHAR <span className="stat-estimativa">· estimativa</span></div>
            <div className="stat-chances">
              <div className="stat-chance">
                <div className="stat-chance-top">
                  <span className="stat-chance-nome">
                    {fl(jogo.casa)}{jogo.casa}
                    {!equilibrado && chances.casa > chances.fora && <span className="stat-fav">Favorito</span>}
                  </span>
                  <span className="stat-chance-pct stat-pct-casa">{pct(chances.casa)}%</span>
                </div>
                <div className="stat-barra"><div className="stat-barra-fill stat-fill-casa" style={{ width: pct(chances.casa) + "%" }} /></div>
              </div>
              <div className="stat-chance">
                <div className="stat-chance-top">
                  <span className="stat-chance-nome">Empate</span>
                  <span className="stat-chance-pct stat-pct-empate">{pct(chances.empate)}%</span>
                </div>
                <div className="stat-barra"><div className="stat-barra-fill stat-fill-empate" style={{ width: pct(chances.empate) + "%" }} /></div>
              </div>
              <div className="stat-chance">
                <div className="stat-chance-top">
                  <span className="stat-chance-nome">
                    {fl(jogo.fora)}{jogo.fora}
                    {!equilibrado && chances.fora > chances.casa && <span className="stat-fav">Favorito</span>}
                  </span>
                  <span className="stat-chance-pct stat-pct-fora">{pct(chances.fora)}%</span>
                </div>
                <div className="stat-barra"><div className="stat-barra-fill stat-fill-fora" style={{ width: pct(chances.fora) + "%" }} /></div>
              </div>
            </div>
            {equilibrado && <p className="stat-equilibrio">⚖️ Jogo equilibrado — sem favorito claro pelo modelo.</p>}
          </>
        )}

        {tabela.length > 0 && (
          <>
            <div className="secao-titulo">CLASSIFICAÇÃO DO GRUPO</div>
            <div className="stat-tabela-wrap">
              <table className="stat-tabela">
                <thead>
                  <tr>
                    <th className="stat-th-time">Equipe</th>
                    <th>PTS</th><th>J</th><th>V</th><th>E</th><th>D</th><th>GP</th><th>GC</th><th>SG</th>
                  </tr>
                </thead>
                <tbody>
                  {tabela.map((r, i) => {
                    const on = r.time === jogo.casa || r.time === jogo.fora;
                    return (
                      <tr key={r.time} className={on ? "stat-row-on" : ""}>
                        <td className="stat-td-time">{i + 1} {fl(r.time)}{r.time}</td>
                        <td className="stat-pts">{r.pts}</td>
                        <td>{r.j}</td><td>{r.v}</td><td>{r.e}</td><td>{r.d}</td><td>{r.gp}</td><td>{r.gc}</td>
                        <td className={r.sg > 0 ? "stat-sg-pos" : r.sg < 0 ? "stat-sg-neg" : ""}>{r.sg > 0 ? "+" : ""}{r.sg}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="secao-titulo">ÚLTIMOS JOGOS NA COPA</div>
        {blocoForma(jogo.casa)}
        {blocoForma(jogo.fora)}
      </div>
    </div>,
    document.body
  );
}

/* ================= JOGOS ================= */
function Jogos({ estado, palpitesMap, contagensMap, comecou, ehAdmin, token, recarregar, offsetMs = 0, statsInicial = null, onStatsConsumido, onIrParaPalpites }) {
  const [statsJogo, setStatsJogo] = useState(
    () => (statsInicial ? estado.jogos.find((j) => j.id === statsInicial) || null : null)
  );
  /* veio da aba Palpites pedindo as stats deste jogo: já abriu acima; limpa o
     pré-seleção no App pra não reabrir ao voltar pra esta aba. */
  useEffect(() => { if (statsInicial && onStatsConsumido) onStatsConsumido(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [casa, setCasa] = useState("");
  const [fora, setFora] = useState("");
  const [kickoff, setKickoff] = useState("");
  const [fase, setFase] = useState("grupos");
  const [buscandoJogos, setBuscandoJogos] = useState(false);
  const [buscandoResultados, setBuscandoResultados] = useState(false);
  const [aviso, setAviso] = useState("");
  const [dataFiltro, setDataFiltro] = useState(() => {
    const agora = Date.now() + offsetMs;
    const aoVivo = estado.jogos.find(
      (m) => !temResultado(m) && m.kickoff && new Date(m.kickoff).getTime() <= agora
    );
    if (aoVivo?.kickoff) return chaveData(aoVivo.kickoff);
    const proximo = [...estado.jogos]
      .filter((m) => !temResultado(m) && m.kickoff && new Date(m.kickoff).getTime() > agora)
      .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))[0];
    if (proximo?.kickoff) return chaveData(proximo.kickoff);
    const hoje = fmtSP(agora);
    const chaves = agruparPorData(estado.jogos).map(([c]) => c);
    if (chaves.includes(hoje)) return hoje;
    const futuras = chaves.filter((c) => c > hoje && c !== "__semdata__");
    if (futuras.length > 0) return futuras[0];
    return chaves[chaves.length - 1] || hoje;
  });
  const [aoVivoFiltro, setAoVivoFiltro] = useState(false);

  const hojeKey = fmtSP(Date.now() + offsetMs);
  const jogosPendentesHoje = estado.jogos.filter(
    (m) => m.kickoff && chaveData(m.kickoff) === hojeKey && !temResultado(m) && !comecou(m)
  ).sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  const temFaltandoHoje = jogosPendentesHoje.length > 0 && estado.participantes.some(
    (p) => jogosPendentesHoje.some((m) => !palpitesMap[m.id]?.[p.id])
  );

  const cobrarWhatsApp = async () => {
    const agora = new Date(Date.now() + offsetMs);
    const faltando = estado.participantes
      .map((p) => ({
        nome: p.nome,
        jogos: jogosPendentesHoje.filter((m) => !palpitesMap[m.id]?.[p.id]),
      }))
      .filter((p) => p.jogos.length > 0)
      .sort((a, b) => b.jogos.length - a.jogos.length);

    if (!faltando.length) return;

    const primeiro = jogosPendentesHoje[0];
    const msAte = new Date(primeiro.kickoff) - agora;
    const h = Math.floor(msAte / 3600000);
    const min = Math.floor((msAte % 3600000) / 60000);
    const horario = new Date(primeiro.kickoff).toLocaleString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const countdownStr = h > 0 ? `em ${h}h${min > 0 ? String(min).padStart(2, "0") + "min" : ""}` : `em ${min}min`;

    const linhas = faltando.map(
      (p) => `• ${p.nome} — ${p.jogos.map((m) => `${m.casa} × ${m.fora}`).join(", ")}`
    );

    const msg = [
      "⚽ *BOLÃO DOS GURIS*",
      "",
      "⚠️ Faltam palpites pra hoje:",
      ...linhas,
      "",
      `⏰ Primeiro jogo às ${horario} (${countdownStr})`,
      "",
      "Corre antes de fechar! 🔒",
      window.location.origin,
    ].join("\n");

    if (navigator.share) {
      navigator.share({ text: msg }).catch(() => {});
    } else {
      try {
        await navigator.clipboard.writeText(msg);
        setAviso("Texto copiado! Cole no WhatsApp 📋");
      } catch {
        window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank", "noopener");
      }
    }
  };

  useEffect(() => {
    if (!aviso) return;
    const t = setTimeout(() => setAviso(""), 6000);
    return () => clearTimeout(t);
  }, [aviso]);

  const addJogo = async () => {
    if (!casa.trim() || !fora.trim()) return;
    try {
      /* o seletor combina fase+peso: no banco `fase` é só grupos|eliminatórias,
         e o peso é que diz a rodada (2× mata-mata, 3× quartas, 4× semi/3º, 5× final) */
      const faseReal = fase === "grupos" ? "grupos" : "eliminatórias";
      const PESO_DO_SELETOR = { grupos: 1, "eliminatórias": 2, quartas: 3, semi: 4, final: 5 };
      const peso = PESO_DO_SELETOR[fase] ?? 1;
      await api("/api/jogo", {
        method: "POST",
        body: JSON.stringify({ t: token, casa, fora, kickoff: kickoff ? new Date(kickoff).toISOString() : null, fase: faseReal, peso }),
      });
      setCasa(""); setFora(""); setKickoff(""); setFase("grupos");
      recarregar();
    } catch (e) { setAviso(e.message); }
  };

  const delJogo = async (id) => {
    try {
      await api("/api/jogo", { method: "DELETE", body: JSON.stringify({ t: token, jogoId: id }) });
      recarregar();
    } catch (e) { setAviso(e.message); }
  };

  const salvarResultado = async (jogo, gh, ga, encerrar) => {
    try {
      await api("/api/jogo", {
        method: "PUT",
        body: JSON.stringify({ t: token, jogoId: jogo.id, gh, ga, encerrar }),
      });
      recarregar();
    } catch (e) { setAviso(e.message); }
  };

  const buscarJogosDoDia = async () => {
    setBuscandoJogos(true);
    setAviso("");
    try {
      const r = await api(`/api/futebol?t=${encodeURIComponent(token)}&acao=jogos-hoje`);
      recarregar();
      const adicionados = r.adicionados || 0;
      const atualizados = r.atualizados || 0;
      const total = r.total || 0;
      setAviso(
        total === 0
          ? "Nenhum jogo da Copa hoje."
          : adicionados === 0 && atualizados === 0
          ? "Os jogos de hoje já estão cadastrados."
          : `${adicionados} adicionado${adicionados === 1 ? "" : "s"} · ${atualizados} atualizado${atualizados === 1 ? "" : "s"} ⚽`
      );
    } catch (e) {
      console.error(e);
      setAviso(e.message || "Não consegui buscar agora — tenta de novo ou adiciona manualmente.");
    }
    setBuscandoJogos(false);
  };

  const buscarResultados = async () => {
    const pendentes = estado.jogos.filter((m) => !temResultado(m) && (!m.kickoff || comecou(m)));
    if (pendentes.length === 0) {
      setAviso("Nenhum jogo iniciado aguardando resultado.");
      return;
    }
    setBuscandoResultados(true);
    setAviso("");
    try {
      const r = await api(`/api/futebol?t=${encodeURIComponent(token)}&acao=resultados`);
      recarregar();
      if (r.cached) {
        /* o dedup bloqueou: a busca automática roda no máx. 1x/min. Não é falha. */
        setAviso("Busca automática roda no máximo 1x por minuto — aguarde alguns segundos e tente de novo. ⏳");
      } else {
        const atualizados = r.atualizados || 0;
        setAviso(
          atualizados === 0
            ? "Nenhum resultado final novo — rode 'Jogos de hoje' antes se faltar carimbar o ID externo."
            : `${atualizados} resultado${atualizados === 1 ? "" : "s"} atualizado${atualizados === 1 ? "" : "s"} — confere o ranking! 🏆`
        );
      }
    } catch (e) {
      console.error(e);
      setAviso(e.message || "Não consegui buscar os resultados — tenta de novo ou lança manualmente.");
    }
    setBuscandoResultados(false);
  };

  return (
    <div>
      {ehAdmin && (
        <>
          <div className="linha-botoes">
            <button className="botao botao-largo" onClick={buscarJogosDoDia} disabled={buscandoJogos || buscandoResultados}>
              {buscandoJogos ? <><span className="spinner" aria-hidden="true"></span> Buscando…</> : "⚡ Jogos de hoje"}
            </button>
            <button className="botao botao-largo" onClick={buscarResultados} disabled={buscandoJogos || buscandoResultados}>
              {buscandoResultados ? <><span className="spinner" aria-hidden="true"></span> Buscando…</> : "🏁 Buscar resultados"}
            </button>
            <button
              className="botao botao-largo botao-zap"
              onClick={cobrarWhatsApp}
              disabled={!temFaltandoHoje}
              title={temFaltandoHoje ? "Abrir WhatsApp com cobrança" : "Todos palpitaram ou não há jogos abertos hoje"}
            >
              📲 Cobrar galera
            </button>
          </div>

          <div className="cartao form-jogo">
            <div className="form-linha">
              <input value={casa} onChange={(e) => setCasa(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addJogo()} placeholder="Time da casa" />
              <span className="vs">×</span>
              <input value={fora} onChange={(e) => setFora(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addJogo()} placeholder="Visitante" />
            </div>
            <div className="form-linha">
              <select value={fase} onChange={(e) => setFase(e.target.value)} className="select-fase" aria-label="Fase do jogo">
                <option value="grupos">Fase de grupos (1×)</option>
                <option value="eliminatórias">Mata-mata — 16-avos/oitavas (2×)</option>
                <option value="quartas">Quartas de final (3×)</option>
                <option value="semi">Semifinal / 3º lugar (4×)</option>
                <option value="final">Final (5×)</option>
              </select>
              <input type="datetime-local" value={kickoff} onChange={(e) => setKickoff(e.target.value)} aria-label="Data e hora do jogo" />
              <button className="botao" onClick={addJogo}>Adicionar</button>
            </div>
          </div>
        </>
      )}

      {aviso && <p className="dica toast" role="status">{aviso}</p>}

      {estado.jogos.length === 0 && (
        <Vazio texto={ehAdmin ? "Nenhum jogo ainda. Use o botão de busca ou adicione manualmente." : "O organizador ainda não cadastrou os jogos."} />
      )}

      {estado.jogos.length > 0 && (() => {
        const grupos = agruparPorData(estado.jogos);
        const idxRaw = grupos.findIndex(([c]) => c === dataFiltro);
        const idx = idxRaw === -1 ? Math.max(0, grupos.length - 1) : idxRaw;
        const jogosAoVivo = estado.jogos.filter((m) => !temResultado(m) && comecou(m));
        const jogosMostrar = aoVivoFiltro ? jogosAoVivo : (grupos[idx]?.[1] ?? []);
        return (
          <>
            <div className="nav-data">
              <button
                className={"nav-ao-vivo" + (aoVivoFiltro ? " nav-ao-vivo-ativo" : "")}
                onClick={() => setAoVivoFiltro((v) => !v)}
              >
                Ao vivo
                <span className="nav-vivo-anel" aria-hidden="true" />
              </button>
              <div className="nav-data-nav">
                <button
                  className="nav-data-seta"
                  onClick={() => { setAoVivoFiltro(false); setDataFiltro(grupos[idx - 1][0]); }}
                  disabled={idx === 0}
                  aria-label="Data anterior"
                >‹</button>
                <span className={"nav-data-label" + (aoVivoFiltro ? " nav-data-label-dim" : "")}>
                  {labelData(grupos[idx]?.[0] ?? "__semdata__", offsetMs)}
                </span>
                <button
                  className="nav-data-seta"
                  onClick={() => { setAoVivoFiltro(false); setDataFiltro(grupos[idx + 1][0]); }}
                  disabled={idx >= grupos.length - 1}
                  aria-label="Próxima data"
                >›</button>
              </div>
            </div>

            {jogosMostrar.length === 0 ? (
              <div className="nav-sem-jogos">
                {aoVivoFiltro
                  ? "Nenhum jogo ao vivo no momento."
                  : "⏳ Aguarde — próximos jogos ainda não foram cadastrados."}
              </div>
            ) : (
              jogosMostrar.map((m, i) => {
                const encerrado = temResultado(m);
                const travado = comecou(m);
                const faltam = !encerrado ? estado.participantes.length - (contagensMap[m.id] || 0) : 0;
                /* começou e ainda plausivelmente rolando (mesma janela de 4h do polling):
                   mostra "ao vivo · a confirmar" enquanto a API não traz o placar, em vez
                   de o card parecer que nem começou. Fora da janela vira jogo órfão. */
                const noAr = travado && !encerrado && !m.live && m.kickoff &&
                  (Date.now() + offsetMs) - new Date(m.kickoff).getTime() <= 4 * 60 * 60 * 1000;
                return (
                  <div key={m.id} className={"cartao jogo entra-cartao" + (encerrado ? " encerrado" : "")} style={{ "--i": Math.min(i, 8) }}>
                    <div className="jogo-info">
                      <div className="jogo-times">{fl(m.casa)}{m.casa} <span className="vs">×</span> {fl(m.fora)}{m.fora}</div>
                      <div className="jogo-meta">
                        {fmtQuando(m) && <span className="jogo-quando">{fmtQuando(m)}</span>}
                        {m.fase === "eliminatórias" && rotuloDaFase(m) && (
                          <span className={"tag tag-elim" + (rotuloDaFase(m).destaque ? " tag-final" : "")}>
                            {rotuloDaFase(m).texto} · {pesoDoJogo(m)}× pts
                          </span>
                        )}
                        {!encerrado && travado && <span className="tag tag-travado">🔒 em jogo</span>}
                        {noAr && ehAdmin && (
                          <span className="tag tag-aguardando" title="O jogo começou — placar ainda não veio da API. O automático preenche em instantes; se quiser, lance na mão.">
                            ⏳ aguardando placar
                          </span>
                        )}
                        {!encerrado && !travado && faltam > 0 && (
                          <span className="tag tag-pendente">⚠ faltam {faltam} palpite{faltam === 1 ? "" : "s"}</span>
                        )}
                        {!encerrado && !travado && estado.participantes.length > 0 && faltam === 0 && (
                          <span className="tag tag-ok">✓ palpites completos</span>
                        )}
                        {(() => { const p = palpitesMap[m.id]?.[estado.eu.id]; return p != null ? <span className="tag tag-meu-palpite">você: {p.h}-{p.a}</span> : null; })()}
                      </div>
                      {!encerrado && !travado && faltam > 0 && m.kickoff && (
                        <Countdown kickoff={m.kickoff} offsetMs={offsetMs} />
                      )}
                      <div className="jogo-acoes">
                        <button className="stat-btn" onClick={() => setStatsJogo(m)}>📊 Estatísticas</button>
                        {!encerrado && !travado && onIrParaPalpites && (
                          <button className="stat-btn stat-btn-palpitar" onClick={() => onIrParaPalpites(m.id)}>✏️ Palpitar</button>
                        )}
                      </div>
                    </div>
                    {ehAdmin ? (
                      <ResultadoAdmin jogo={m} salvar={salvarResultado} remover={() => delJogo(m.id)} emAndamento={travado && !encerrado} />
                    ) : encerrado ? (
                      <div className="placar-final led-mini">{m.gh} : {m.ga}</div>
                    ) : m.live ? (
                      <div className="placar-vivo led-mini">
                        <span className="placar-vivo-dot" aria-hidden="true" />
                        {m.gh} : {m.ga}
                      </div>
                    ) : noAr ? (
                      <div className="placar-vivo led-mini placar-vivo-aguardando" title="O jogo começou — placar ainda não confirmado pela API">
                        <span className="placar-vivo-dot" aria-hidden="true" />
                        – : –
                      </div>
                    ) : null}
                    <ReacaoStrip
                      jogoId={m.id}
                      reacoes={(estado.reacoes || []).filter((r) => r.jogo_id === m.id)}
                      euId={estado.eu.id}
                      token={token}
                      onUpdate={recarregar}
                    />
                  </div>
                );
              })
            )}
          </>
        );
      })()}

      {ehAdmin && <BonusAdmin token={token} estado={estado} recarregar={recarregar} />}
      {statsJogo && <ModalEstatisticas jogo={statsJogo} jogos={estado.jogos} onFechar={() => setStatsJogo(null)} />}
    </div>
  );
}

function ResultadoAdmin({ jogo, salvar, remover, emAndamento = false }) {
  const [gh, setGh] = useState(jogo.gh ?? "");
  const [ga, setGa] = useState(jogo.ga ?? "");
  const timer = useRef(null);

  useEffect(() => { setGh(jogo.gh ?? ""); setGa(jogo.ga ?? ""); }, [jogo.gh, jogo.ga]);

  const mudar = (campo, valor) => {
    const nh = campo === "gh" ? valor : gh;
    const na = campo === "ga" ? valor : ga;
    campo === "gh" ? setGh(valor) : setGa(valor);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      /* Editar o placar de um jogo JÁ ENCERRADO = corrigir o final (continua
         encerrado). De um jogo EM ANDAMENTO = correção AO VIVO: mantém ao vivo. O
         automático só volta a mexer quando a API MUDA o placar que reporta, então
         a correção (ex.: gol anulado por VAR) não volta atrás sozinha. */
      const encerrar = temResultado(jogo);
      salvar(jogo, nh === "" ? null : nh, na === "" ? null : na, encerrar);
    }, 800);
  };

  /* botão de escape: finaliza na hora. Só é necessário se o automático não
     fechar sozinho (ex.: a API nunca mandar o FINISHED). */
  const encerrarAgora = () => {
    clearTimeout(timer.current);
    if (gh === "" || ga === "") return;
    salvar(jogo, gh, ga, true);
  };

  return (
    <div className="jogo-resultado">
      {jogo.fase === "eliminatórias" && (
        <span className="aviso-90min" title="Lançar o placar após a prorrogação (90min + prorrogação) — sem contar pênaltis">⏱ 90min + prorrog.</span>
      )}
      <input type="number" min="0" inputMode="numeric" value={gh} placeholder="–"
        onChange={(e) => mudar("gh", e.target.value)} aria-label={"Gols " + jogo.casa} />
      <span className="vs">:</span>
      <input type="number" min="0" inputMode="numeric" value={ga} placeholder="–"
        onChange={(e) => mudar("ga", e.target.value)} aria-label={"Gols " + jogo.fora} />
      {emAndamento && (
        <button
          className="encerrar-jogo"
          onClick={encerrarAgora}
          disabled={gh === "" || ga === ""}
          title="Finalizar o jogo agora — use só se o automático não fechar sozinho"
        >🏁 Encerrar</button>
      )}
      <button className="apagar" onClick={remover} aria-label="Remover jogo">✕</button>
    </div>
  );
}

/* ================= PALPITES ================= */
function Palpites({ estado, palpitesMap, comecou, token, recarregar, offsetMs = 0, jogoInicial = null, onVerStats }) {
  const [jogoSel, setJogoSel] = useState(() => {
    if (jogoInicial) return String(jogoInicial);
    const agora = Date.now() + offsetMs;
    const aoVivo = estado.jogos.find(
      (m) => !temResultado(m) && m.kickoff && new Date(m.kickoff).getTime() <= agora
    );
    if (aoVivo) return String(aoVivo.id);
    const proximo = [...estado.jogos]
      .filter((m) => !temResultado(m) && m.kickoff && new Date(m.kickoff).getTime() > agora)
      .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))[0];
    if (proximo) return String(proximo.id);
    return estado.jogos[0] ? String(estado.jogos[0].id) : "";
  });
  const jogo = estado.jogos.find((m) => String(m.id) === String(jogoSel)) || estado.jogos[0];

  const hoje = fmtSP(Date.now() + offsetMs);
  const [gruposAbertos, setGruposAbertos] = useState(() => {
    const abertos = new Set();
    for (const [chave] of agruparPorData(estado.jogos)) {
      if (chave >= hoje || chave === "__semdata__") abertos.add(chave);
    }
    if (jogoInicial) {
      const j = estado.jogos.find((m) => m.id === jogoInicial);
      if (j?.kickoff) abertos.add(chaveData(j.kickoff));
    }
    return abertos;
  });
  const toggleGrupo = (chave) =>
    setGruposAbertos((prev) => {
      const s = new Set(prev);
      s.has(chave) ? s.delete(chave) : s.add(chave);
      return s;
    });
  const [anterioresAberto, setAnterioresAberto] = useState(false);
  const palpiteRef = useRef(null);
  /* ao escolher um jogo, leva direto para a área do palpite (mesma página) */
  const selecionar = (id) => {
    setJogoSel(String(id));
    const reduz = typeof window !== "undefined" && window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => {
      palpiteRef.current?.scrollIntoView({ behavior: reduz ? "auto" : "smooth", block: "start" });
    });
  };

  if (estado.jogos.length === 0) return <Vazio texto="Ainda não há jogos cadastrados." />;
  if (estado.participantes.length === 0) return <Vazio texto="Ainda não há participantes cadastrados." />;

  const encerrado = temResultado(jogo);
  const travado = comecou(jogo) || encerrado;
  const ehAdmin = estado.eu.isAdmin;
  /* já palpitei neste jogo? o countdown de urgência ("FECHA EM SEGUNDOS…") é um
     empurrão pra palpitar — não faz sentido (e incomoda) depois do palpite dado. */
  const meuPalpite = palpitesMap[jogo.id]?.[estado.eu.id];
  const jaPalpitei = meuPalpite != null && meuPalpite.h != null && meuPalpite.a != null;
  const revelado = travado; /* palpites dos outros só aparecem depois que começa */

  /* separa em "hoje + futuros" (no topo, abertos como antes) e "passados"
     (recolhidos num único grupo "Jogos anteriores" no rodapé), para que os
     dias já jogados não empilhem cabeçalhos acima do jogo de hoje. */
  const grupos = agruparPorData(estado.jogos);
  const passados = grupos
    .filter(([c]) => c !== "__semdata__" && c < hoje)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1)); /* mais recente primeiro */
  const futuros = grupos
    .filter(([c]) => c === "__semdata__" || c >= hoje)
    .sort((a, b) => {
      if (a[0] === "__semdata__") return 1;
      if (b[0] === "__semdata__") return -1;
      return a[0] < b[0] ? -1 : 1; /* mais próximo primeiro */
    });
  const nPassados = passados.reduce((s, [, g]) => s + g.length, 0);

  const renderDia = (chave, grupo) => {
    const aberto = gruposAbertos.has(chave);
    const encGrupo = grupo.filter(temResultado).length;
    return (
      <div key={chave}>
        <button
          className="seletor-data-header"
          onClick={() => toggleGrupo(chave)}
          aria-expanded={aberto}
        >
          <span>{labelData(chave, offsetMs)}</span>
          <span className="seletor-data-info">
            {encGrupo > 0 && <span className="seletor-data-cnt">{encGrupo}/{grupo.length}</span>}
            <span className="seletor-data-chevron">{aberto ? "▾" : "▸"}</span>
          </span>
        </button>
        {aberto && grupo.map((m) => {
          const enc = temResultado(m);
          const ativo = String(m.id) === String(jogo.id);
          const aoVivo = !!m.live;
          /* mesma regra da aba Jogos: começou, ainda dentro da janela de 4h e a
             API não confirmou o placar -> "no ar / aguardando" em vez de futuro. */
          const aguardando = !enc && !aoVivo && comecou(m) && m.kickoff &&
            (Date.now() + offsetMs) - new Date(m.kickoff).getTime() <= 4 * 60 * 60 * 1000;
          const temNum = aoVivo || enc;
          const casaPerdeu = enc && m.gh < m.ga;
          const foraPerdeu = enc && m.ga < m.gh;
          const estadoCls = enc ? " sj-st-fim" : aoVivo ? " sj-st-vivo" : aguardando ? " sj-st-aguard" : " sj-st-prox";
          const cls = "seletor-jogo sj-sofa" + (ativo ? " sj-ativo" : "") + estadoCls;
          return (
            <button
              key={m.id}
              role="option"
              aria-selected={ativo}
              className={cls}
              onClick={() => selecionar(m.id)}
            >
              <span className="sj-status">
                <span className="sj-hora">{fmtHora(m)}</span>
                {(aoVivo || aguardando || enc) && (
                  <span className="sj-estado">
                    {(aoVivo || aguardando) && <span className="placar-vivo-dot" aria-hidden="true" />}
                    {aoVivo ? "Ao vivo" : aguardando ? "No ar" : "Fim"}
                  </span>
                )}
                {pesoDoJogo(m) > 1 && (
                  <span className={"sj-peso" + (rotuloDaFase(m)?.destaque ? " sj-peso-final" : "")}>{pesoDoJogo(m)}×</span>
                )}
              </span>
              <span className="sj-times">
                <span className={"sj-time" + (casaPerdeu ? " sj-perdeu" : "")}>{fl(m.casa)}{m.casa}</span>
                <span className={"sj-time" + (foraPerdeu ? " sj-perdeu" : "")}>{fl(m.fora)}{m.fora}</span>
              </span>
              <span className="sj-gols">
                <span className={"sj-g" + (casaPerdeu ? " sj-perdeu" : "")}>{temNum ? m.gh : "–"}</span>
                <span className={"sj-g" + (foraPerdeu ? " sj-perdeu" : "")}>{temNum ? m.ga : "–"}</span>
              </span>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div>
      <div className="seletor-jogos" role="listbox" aria-label="Selecionar jogo">
        {futuros.map(([chave, grupo]) => renderDia(chave, grupo))}
        {passados.length > 0 && (
          <>
            <button
              className="seletor-data-header seletor-data-mae"
              onClick={() => setAnterioresAberto((v) => !v)}
              aria-expanded={anterioresAberto}
            >
              <span>↩ Jogos anteriores</span>
              <span className="seletor-data-info">
                <span className="seletor-data-cnt">{nPassados}</span>
                <span className="seletor-data-chevron">{anterioresAberto ? "▾" : "▸"}</span>
              </span>
            </button>
            {anterioresAberto && passados.map(([chave, grupo]) => renderDia(chave, grupo))}
          </>
        )}
      </div>

      <div ref={palpiteRef} style={{ scrollMarginTop: 12 }} aria-hidden="true" />

      {pesoDoJogo(jogo) > 1 && rotuloDaFase(jogo) && (
        <div className={"peso-banner" + (rotuloDaFase(jogo).destaque ? " peso-banner-final" : "")}>
          <span className="peso-banner-x">{pesoDoJogo(jogo)}×</span>
          <span>
            {rotuloDaFase(jogo).texto} —{" "}
            placar exato <strong>{PTS_EXATO * pesoDoJogo(jogo)} pts</strong> · resultado <strong>{PTS_RESULTADO * pesoDoJogo(jogo)} pt{PTS_RESULTADO * pesoDoJogo(jogo) === 1 ? "" : "s"}</strong>
          </span>
        </div>
      )}

      {onVerStats && (
        <button className="stat-link" onClick={() => onVerStats(jogo.id)}>
          📊 Em dúvida? Ver estatísticas deste jogo
        </button>
      )}

      {!encerrado && !travado && !jaPalpitei && jogo.kickoff && (
        <Countdown kickoff={jogo.kickoff} offsetMs={offsetMs} />
      )}

      {encerrado && (
        <p className="dica">Resultado final: <strong>{fl(jogo.casa)}{jogo.casa} {jogo.gh} × {jogo.ga} {fl(jogo.fora)}{jogo.fora}</strong></p>
      )}
      {travado && !encerrado && (
        <div className="trava-aviso"><span>🔒 Bola rolando — palpites travados pelo servidor.</span></div>
      )}

      {/* seu palpite */}
      {estado.eu.id !== null && (
        <>
          <div className="secao-titulo">SEU PALPITE</div>
          <LinhaPalpite
            jogo={jogo}
            participante={{ id: estado.eu.id, nome: estado.eu.nome }}
            palpite={palpitesMap[jogo.id]?.[estado.eu.id]}
            bloqueado={travado && !ehAdmin}
            destaque
            token={token}
            ehAdmin={ehAdmin}
            recarregar={recarregar}
          />
        </>
      )}

      {/* palpites da galera */}
      <div className="secao-titulo">{revelado ? "PALPITES DA GALERA" : "PALPITES DA GALERA (revelados quando a bola rolar)"}</div>
      {!revelado && !ehAdmin && (
        <div className="vazio">
          <span aria-hidden="true">🤫</span>
          <span>Segredo até o apito inicial — ninguém copia ninguém por aqui.</span>
        </div>
      )}
      {(revelado || ehAdmin) &&
        estado.participantes
          .filter((p) => p.id !== estado.eu.id)
          .map((p, i) => (
            <LinhaPalpite
              key={p.id}
              jogo={jogo}
              participante={p}
              palpite={palpitesMap[jogo.id]?.[p.id]}
              bloqueado={!ehAdmin}
              token={token}
              ehAdmin={ehAdmin}
              recarregar={recarregar}
              indice={i}
            />
          ))}
    </div>
  );
}

function LinhaPalpite({ jogo, participante, palpite, bloqueado, destaque, token, ehAdmin, recarregar, indice = 0 }) {
  const [h, setH] = useState(palpite?.h ?? "");
  const [a, setA] = useState(palpite?.a ?? "");
  const [status, setStatus] = useState("");
  const timer = useRef(null);

  useEffect(() => {
    setH(palpite?.h ?? "");
    setA(palpite?.a ?? "");
    setStatus("");
  }, [jogo.id, participante.id, palpite?.h, palpite?.a]);

  const pts = pontosDoPalpite(palpite, jogo);     // bruto (classifica exato/result/erro)
  const ptsPeso = pontosComPeso(palpite, jogo);   // já com peso da fase (o que vale no total)
  const peso = pesoDoJogo(jogo);
  const encerrado = temResultado(jogo);

  const mudar = (campo, valor) => {
    const nh = campo === "h" ? valor : h;
    const na = campo === "a" ? valor : a;
    campo === "h" ? setH(valor) : setA(valor);
    clearTimeout(timer.current);
    if (nh === "" || na === "") return;
    setStatus("salvando");
    timer.current = setTimeout(async () => {
      try {
        await api("/api/palpite", {
          method: "POST",
          body: JSON.stringify({
            t: token,
            jogoId: jogo.id,
            h: Number(nh),
            a: Number(na),
            ...(ehAdmin && { participanteId: participante.id }),
          }),
        });
        setStatus("salvo");
        recarregar();
      } catch (e) {
        setStatus("erro");
      }
    }, 700);
  };

  return (
    <div
      className={"cartao palpite-linha entra-cartao" + (destaque ? " meu-palpite" : "")}
      style={{ "--i": Math.min(indice, 8) }}
    >
      <span className="palpite-nome">
        <Avatar nome={participante.nome} emoji={participante.avatarEmoji} cor={participante.avatarCor} size={28} />
        {participante.nome}
      </span>
      <div className="palpite-inputs">
        {status === "salvando" && <span className="palpite-status">salvando…</span>}
        {status === "salvo" && <span className="palpite-status ok">✓</span>}
        {status === "erro" && <span className="palpite-status erro">não salvou ✕</span>}
        <span className="palpite-time-flag" title={jogo.casa}>{fl(jogo.casa)}</span>
        <input type="number" min="0" inputMode="numeric" value={h} placeholder="–"
          disabled={bloqueado}
          onChange={(e) => mudar("h", e.target.value)}
          aria-label={`Palpite de ${participante.nome} para ${jogo.casa}`} />
        <span className="vs">:</span>
        <input type="number" min="0" inputMode="numeric" value={a} placeholder="–"
          disabled={bloqueado}
          onChange={(e) => mudar("a", e.target.value)}
          aria-label={`Palpite de ${participante.nome} para ${jogo.fora}`} />
        <span className="palpite-time-flag" title={jogo.fora}>{fl(jogo.fora)}</span>
        {encerrado && pts !== null && (
          <span className={"pts pts-" + pts}>
            {pts === PTS_EXATO ? "🎯 " : ""}{ptsPeso} pt{ptsPeso === 1 ? "" : "s"}
            {peso > 1 && pts > 0 && <span className="pts-peso-mini"> ({pts}×{peso})</span>}
          </span>
        )}
        {encerrado && pts === null && <span className="pts pts-0">—</span>}
      </div>
      {palpite?.atualizado_em && (() => {
        const txt = [fmtAntecedencia(jogo.kickoff, palpite.atualizado_em), fmtMomento(palpite.atualizado_em)]
          .filter(Boolean).join(" · ");
        return txt
          ? <div className="palpite-quando" title="Quando o palpite foi registrado (vale o último envio — editar reinicia o horário do desempate por antecedência)">⏱ {txt}</div>
          : null;
      })()}
    </div>
  );
}

/* ================= TIMER PAGAMENTO ================= */
function TimerPagamento() {
  const DEADLINE = DEADLINE_PAGAMENTO;
  const [seg, setSeg] = useState(() => Math.max(0, Math.floor((DEADLINE - Date.now()) / 1000)));

  useEffect(() => {
    if (seg <= 0) return;
    const id = setInterval(() => {
      const diff = Math.max(0, Math.floor((DEADLINE - Date.now()) / 1000));
      setSeg(diff);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  if (seg <= 0) return null;

  const h = Math.floor(seg / 3600);
  const m = Math.floor((seg % 3600) / 60);
  const s = seg % 60;
  const pad = (n) => String(n).padStart(2, "0");

  return (
    <div className="timer-pagamento">
      <span className="timer-label">⏰ Prazo para pagamento</span>
      <div className="timer-display">
        <span className="timer-bloco"><span className="timer-num">{pad(h)}</span><span className="timer-unidade">h</span></span>
        <span className="timer-sep">:</span>
        <span className="timer-bloco"><span className="timer-num">{pad(m)}</span><span className="timer-unidade">m</span></span>
        <span className="timer-sep">:</span>
        <span className="timer-bloco"><span className="timer-num">{pad(s)}</span><span className="timer-unidade">s</span></span>
      </div>
      <span className="timer-data">{DEADLINE_PAGAMENTO_LABEL}</span>
    </div>
  );
}

/* ================= GALERA ================= */
function Galera({ estado, ehAdmin, token, recarregar, installPrompt, onInstalled }) {
  const [nome, setNome] = useState("");
  const [novoAdmin, setNovoAdmin] = useState(false);
  const [lista, setLista] = useState(null); /* com tokens, só admin */
  const [aviso, setAviso] = useState("");
  const [copiado, setCopiado] = useState(null);
  const [toggling, setToggling] = useState(null);

  const carregarLista = useCallback(async () => {
    if (!ehAdmin) return;
    try {
      const r = await api(`/api/participante?t=${encodeURIComponent(token)}`);
      setLista(r.participantes);
    } catch (e) { setAviso(e.message); }
  }, [ehAdmin, token]);

  useEffect(() => { carregarLista(); }, [carregarLista]);

  useEffect(() => {
    if (!aviso) return;
    const t = setTimeout(() => setAviso(""), 6000);
    return () => clearTimeout(t);
  }, [aviso]);

  const adicionar = async () => {
    if (!nome.trim()) return;
    try {
      await api("/api/participante", {
        method: "POST",
        body: JSON.stringify({ t: token, nome, admin: novoAdmin }),
      });
      setNome(""); setNovoAdmin(false);
      setAviso("Participante criado — copia o link e manda no WhatsApp 📲");
      carregarLista();
      recarregar();
    } catch (e) { setAviso(e.message); }
  };

  const remover = async (id) => {
    try {
      await api("/api/participante", { method: "DELETE", body: JSON.stringify({ t: token, id }) });
      carregarLista();
      recarregar();
    } catch (e) { setAviso(e.message); }
  };

  const togglePagou = async (p) => {
    setToggling(p.id);
    try {
      await api("/api/participante", { method: "PUT", body: JSON.stringify({ t: token, id: p.id, pagou: !p.pagou }) });
      await carregarLista();
      recarregar();
    } catch (e) { setAviso(e.message); }
    finally { setToggling(null); }
  };

  const regenerarLink = async (p) => {
    /* Guard anti-lockout: trocar o próprio token invalida a sessão atual do
       admin (o token está na URL/localStorage). Bloqueia pra não se trancar. */
    if (p.id === estado.eu.id) {
      setAviso("Não dá pra trocar o seu próprio link por aqui — peça pra outro organizador.");
      return;
    }
    if (!window.confirm(`Gerar um link NOVO para ${p.nome}?\n\nO link antigo dele para de funcionar na hora — você vai precisar enviar o novo.`)) return;
    try {
      await api("/api/participante", {
        method: "PUT",
        body: JSON.stringify({ t: token, id: p.id, regenerarToken: true }),
      });
      await carregarLista();
      setAviso(`Link novo de ${p.nome} gerado — copie e mande pra ele 📲`);
    } catch (e) { setAviso(e.message); }
  };

  const copiarLink = async (p) => {
    const url = `${window.location.origin}/?t=${p.token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiado(p.id);
      setTimeout(() => setCopiado(null), 2000);
    } catch {
      setAviso(url); /* fallback: mostra o link pro admin copiar na mão */
    }
  };

  const isAndroid = /android/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
  const mostrarBotaoInstalar = isAndroid && !isStandalone;

  const instalarPwa = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === "accepted") onInstalled();
  };

  const BotaoInstalar = mostrarBotaoInstalar ? (
    <div className="notif-bloco">
      {installPrompt
        ? <button className="botao notif-btn" onClick={instalarPwa}>📲 Instalar app na tela inicial</button>
        : <p className="notif-aviso">📲 Para instalar: toque nos <strong>⋮ três pontos</strong> do navegador → <strong>"Adicionar à tela inicial"</strong></p>
      }
    </div>
  ) : null;

  const pote = estado.participantes.length * VALOR_ENTRADA;
  const PremioCard = estado.participantes.length > 0 ? (
    <div className="premio-card">
      <div className="premio-eyebrow">🏆 EM JOGO</div>
      <div className="premio-valor">R$ {pote}</div>
      <div className="premio-sub">{estado.participantes.length} × R$ {VALOR_ENTRADA} · 1º lugar leva tudo</div>
    </div>
  ) : null;

  if (!ehAdmin) {
    return (
      <div>
        {PremioCard}
        <TimerPagamento />
        {BotaoInstalar}
        {estado.participantes.length === 0 && <Vazio texto="Ainda não há participantes." />}
        {estado.participantes.map((p, i) => (
          <div key={p.id} className="cartao palpite-linha entra-cartao" style={{ "--i": Math.min(i, 8) }}>
            <Avatar nome={p.nome} emoji={p.avatarEmoji} cor={p.avatarCor} size={30} />
            <span className="palpite-nome">{p.nome}{p.id === estado.eu.id ? " (você)" : ""}</span>
            <span className={p.pagou ? "badge-pago" : "badge-pendente"}>
              {p.pagou ? "✅ Pago" : "⏳ Pendente"}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      {PremioCard}
      <div className="cartao form-jogo">
        <div className="form-linha">
          <input value={nome} onChange={(e) => setNome(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && adicionar()} placeholder="Nome do amigo" />
          <button className="botao" onClick={adicionar}>Adicionar</button>
        </div>
        <label className="check-admin">
          <input type="checkbox" checked={novoAdmin} onChange={(e) => setNovoAdmin(e.target.checked)} />
          também é organizador (pode lançar jogos e resultados)
        </label>
      </div>

      <TimerPagamento />
      {BotaoInstalar}

      {aviso && <p className="dica toast" role="status">{aviso}</p>}

      {lista === null && <p className="dica">Carregando…</p>}
      {lista && lista.length === 0 && <Vazio texto="Adicione os 9 nomes do grupo — cada um ganha um link próprio." />}
      {lista && lista.length > 0 && (() => {
        const pagos = lista.filter((p) => p.pagou).length;
        const total = lista.length;
        const caixa = pagos * VALOR_ENTRADA;
        return (
          <div className="resumo-pagamento">
            <span className="resumo-pagamento-txt">
              💰 {pagos}/{total} pagaram · <strong>R$ {caixa} em caixa</strong>
            </span>
          </div>
        );
      })()}
      {lista &&
        lista.map((p, i) => (
          <div key={p.id} className="cartao palpite-linha entra-cartao" style={{ "--i": Math.min(i, 8) }}>
            <Avatar nome={p.nome} emoji={p.avatarEmoji} cor={p.avatarCor} size={30} />
            <span className="palpite-nome">{p.nome}{p.isAdmin ? " ⭐" : ""}</span>
            <button
              className={p.pagou ? "badge-pago badge-btn" : "badge-pendente badge-btn"}
              onClick={() => togglePagou(p)}
              disabled={toggling === p.id}
              title={p.pagou ? "Clique para desmarcar" : "Clique para marcar como pago"}
            >
              {p.pagou ? "✅ Pago" : "⏳ Pendente"}
            </button>
            <button className="botao-fantasma" onClick={() => copiarLink(p)}>
              {copiado === p.id ? "✓ Copiado" : "📋 Copiar link"}
            </button>
            {p.id !== estado.eu.id && (
              <button
                className="botao-fantasma"
                onClick={() => regenerarLink(p)}
                title="Gera um link novo e invalida o antigo (sem apagar os palpites)"
              >🔄 Novo link</button>
            )}
            <button className="apagar" onClick={() => remover(p.id)} aria-label={`Remover ${p.nome}`}>✕</button>
          </div>
        ))}
    </div>
  );
}

/* ================= CAMPEÃO ================= */

/* 46 classificados confirmados para a Copa 2026
   (faltam os 2 vencedores do playoff intercontinental — me diga quais são) */
const FLAG_CODES = {
  // CONMEBOL
  "Brasil":"br","Brazil":"br",
  "Argentina":"ar",
  "Uruguai":"uy","Uruguay":"uy",
  "Colômbia":"co","Colombia":"co",
  "Equador":"ec","Ecuador":"ec",
  "Paraguai":"py","Paraguay":"py",
  "Peru":"pe",
  "Venezuela":"ve",
  "Bolívia":"bo","Bolivia":"bo",
  "Chile":"cl",
  // CONCACAF
  "Estados Unidos":"us","United States":"us","USA":"us","EUA":"us",
  "México":"mx","Mexico":"mx",
  "Canadá":"ca","Canada":"ca",
  "Costa Rica":"cr",
  "Panamá":"pa","Panama":"pa",
  "Jamaica":"jm",
  "Honduras":"hn",
  "El Salvador":"sv",
  "Guatemala":"gt",
  "Trinidad e Tobago":"tt","Trinidad and Tobago":"tt",
  "Curaçao":"cw","Curacao":"cw",
  "Haiti":"ht",
  // UEFA
  "Alemanha":"de","Germany":"de",
  "França":"fr","France":"fr",
  "Espanha":"es","Spain":"es",
  "Inglaterra":"gb-eng","England":"gb-eng",
  "Portugal":"pt",
  "Itália":"it","Italy":"it",
  "Holanda":"nl","Netherlands":"nl","Países Baixos":"nl",
  "Bélgica":"be","Belgium":"be",
  "Croácia":"hr","Croatia":"hr",
  "Suíça":"ch","Switzerland":"ch",
  "Dinamarca":"dk","Denmark":"dk",
  "Polônia":"pl","Poland":"pl",
  "Áustria":"at","Austria":"at",
  "Suécia":"se","Sweden":"se",
  "Noruega":"no","Norway":"no",
  "República Tcheca":"cz","Czech Republic":"cz","Czechia":"cz",
  "Sérvia":"rs","Serbia":"rs",
  "Turquia":"tr","Turkey":"tr","Türkiye":"tr",
  "Ucrânia":"ua","Ukraine":"ua",
  "País de Gales":"gb-wls","Wales":"gb-wls",
  "Escócia":"gb-sct","Scotland":"gb-sct",
  "Irlanda":"ie","Republic of Ireland":"ie","Ireland":"ie",
  "Irlanda do Norte":"gb-nir","Northern Ireland":"gb-nir",
  "Hungria":"hu","Hungary":"hu",
  "Romênia":"ro","Romania":"ro",
  "Grécia":"gr","Greece":"gr",
  "Rússia":"ru","Russia":"ru",
  "Eslováquia":"sk","Slovakia":"sk",
  "Eslovênia":"si","Slovenia":"si",
  "Albânia":"al","Albania":"al",
  "Bósnia e Herzegovina":"ba","Bosnia and Herzegovina":"ba","Bosnia-Herzegovina":"ba",
  "Islândia":"is","Iceland":"is",
  "Finlândia":"fi","Finland":"fi",
  "Bulgária":"bg","Bulgaria":"bg",
  "Montenegro":"me",
  "Macedônia do Norte":"mk","North Macedonia":"mk",
  // CAF
  "Marrocos":"ma","Morocco":"ma",
  "Senegal":"sn",
  "Tunísia":"tn","Tunisia":"tn",
  "Argélia":"dz","Algeria":"dz",
  "Egito":"eg","Egypt":"eg",
  "Nigéria":"ng","Nigeria":"ng",
  "Gana":"gh","Ghana":"gh",
  "Camarões":"cm","Cameroon":"cm",
  "Costa do Marfim":"ci","Ivory Coast":"ci","Côte d'Ivoire":"ci",
  "África do Sul":"za","South Africa":"za",
  "Mali":"ml",
  "Burkina Faso":"bf",
  "Cabo Verde":"cv","Cape Verde":"cv","Cape Verde Islands":"cv",
  "República Democrática do Congo":"cd","DR Congo":"cd","Congo DR":"cd",
  // AFC
  "Japão":"jp","Japan":"jp",
  "Coreia do Sul":"kr","South Korea":"kr","Korea Republic":"kr",
  "Irã":"ir","Iran":"ir","IR Iran":"ir",
  "Arábia Saudita":"sa","Saudi Arabia":"sa",
  "Austrália":"au","Australia":"au",
  "Catar":"qa","Qatar":"qa",
  "Emirados Árabes Unidos":"ae","United Arab Emirates":"ae","UAE":"ae",
  "Iraque":"iq","Iraq":"iq",
  "Uzbequistão":"uz","Uzbekistan":"uz",
  "Jordânia":"jo","Jordan":"jo",
  "China":"cn","China PR":"cn",
  // OFC
  "Nova Zelândia":"nz","New Zealand":"nz",
};
const fl = (nome) => {
  const code = FLAG_CODES[nome];
  if (!code) return null;
  return <img src={`https://flagcdn.com/20x15/${code}.png`} alt={nome} className="flag-img" />;
};

const SELECOES = [
  // CONCACAF
  "Canadá", "Costa Rica", "Estados Unidos", "Honduras", "México", "Panamá",
  // CONMEBOL
  "Argentina", "Brasil", "Colômbia", "Equador", "Uruguai", "Venezuela",
  // UEFA
  "Alemanha", "Áustria", "Bélgica", "Croácia", "Dinamarca", "Escócia",
  "Espanha", "França", "Holanda", "Hungria", "Inglaterra", "Itália",
  "Portugal", "Sérvia", "Suíça", "Turquia",
  // CAF
  "África do Sul", "Argélia", "Camarões", "Costa do Marfim",
  "Egito", "Mali", "Marrocos", "Nigéria", "Senegal",
  // AFC
  "Arábia Saudita", "Austrália", "Catar", "Coreia do Sul",
  "Irã", "Iraque", "Japão", "Uzbequistão",
  // OFC
  "Nova Zelândia",
].sort((a, b) => a.localeCompare(b, "pt-BR"));

const normBusca = (s) =>
  s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

/* ================= BONUS ADMIN ================= */

function BonusAdmin({ token, estado, recarregar }) {
  const [resultado, setResultado] = useState(null);
  const [campeaoFiltro, setCampeaoFiltro] = useState("");
  const [campeaoSel, setCampeaoSel] = useState("");
  const [artilheiroVal, setArtilheiroVal] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [confirmando, setConfirmando] = useState(null);
  const [pedindoConfirm, setPedindoConfirm] = useState(null);
  const [aviso, setAviso] = useState("");
  const [toggling, setToggling] = useState(false);
  const [golsEdit, setGolsEdit] = useState(() => ({ ...(estado.artilheiroGols || {}) }));
  const [salvandoGols, setSalvandoGols] = useState(false);
  const [pedindoElim, setPedindoElim] = useState(null);
  const [salvandoElim, setSalvandoElim] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const r = await api(`/api/resultado-especial?t=${encodeURIComponent(token)}`);
      setResultado(r);
      if (r.campeao) setCampeaoSel(r.campeao.valor);
      if (r.artilheiro) setArtilheiroVal(r.artilheiro.valor);
    } catch (e) { setAviso(e.message); }
  }, [token]);

  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => {
    if (!aviso) return;
    const t = setTimeout(() => setAviso(""), 5000);
    return () => clearTimeout(t);
  }, [aviso]);

  const salvar = async (tipo, valor) => {
    setSalvando(true);
    try {
      await api("/api/resultado-especial", {
        method: "POST",
        body: JSON.stringify({ t: token, tipo, valor }),
      });
    } catch (e) { setAviso(e.message); }
    setSalvando(false);
  };

  const confirmar = async (tipo) => {
    setConfirmando(tipo);
    try {
      await api("/api/resultado-especial", {
        method: "PUT",
        body: JSON.stringify({ t: token, tipo }),
      });
      await carregar();
      await recarregar();
      setPedindoConfirm(null);
    } catch (e) { setAviso(e.message); }
    setConfirmando(null);
  };

  const togglePremiado = async (participanteId) => {
    setToggling(true);
    try {
      await api("/api/resultado-especial", {
        method: "PATCH",
        body: JSON.stringify({ t: token, participanteId }),
      });
      await recarregar();
    } catch (e) { setAviso(e.message); }
    setToggling(false);
  };

  const salvarGols = async (jogadores) => {
    setSalvandoGols(true);
    try {
      const gols = {};
      for (const [n] of jogadores) {
        const v = parseInt(golsEdit[n], 10);
        if (Number.isFinite(v) && v >= 0) gols[n] = v;
      }
      await api("/api/resultado-especial", { method: "POST", body: JSON.stringify({ t: token, tipo: "artilheiro-gols", gols }) });
      await recarregar();
      setAviso("Gols salvos ⚽");
    } catch (e) { setAviso(e.message); }
    setSalvandoGols(false);
  };

  const salvarEliminadas = async (codigos) => {
    setSalvandoElim(true);
    try {
      await api("/api/resultado-especial", { method: "POST", body: JSON.stringify({ t: token, tipo: "selecoes-eliminadas", codigos }) });
      await recarregar();
    } catch (e) { setAviso(e.message); }
    setSalvandoElim(false);
  };

  if (!resultado) return null;

  const nomeParticipante = (id) => estado.participantes.find((p) => p.id === id)?.nome || "?";

  const vencedoresCampeao = resultado.campeao?.confirmado
    ? (estado.palpitesCampeao || []).filter((pc) => pc.selecao === resultado.campeao.valor)
    : [];

  /* jogadores distintos escolhidos (agrupados por nome normalizado) p/ editar gols */
  const jogadoresArt = (() => {
    const m = new Map();
    for (const pk of estado.palpitesArtilheiro || []) {
      const n = normTexto(pk.jogador);
      if (n && !m.has(n)) m.set(n, pk.jogador);
    }
    return [...m.entries()];
  })();
  /* seleções distintas escolhidas como campeã, p/ marcar eliminadas (só confirmadas) */
  const selsCampeao = [...new Set((estado.palpitesCampeao || []).map((pc) => pc.selecao))]
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const eliminadaSel = (sel) => (estado.selecoesEliminadas || []).includes(FLAG_CODES[sel]);

  const filtradas = campeaoFiltro
    ? SELECOES.filter((s) => normBusca(s).includes(normBusca(campeaoFiltro)))
    : SELECOES;

  return (
    <div style={{ marginTop: "24px" }}>
      <div className="grupo-data-header">🏆 BÔNUS ESPECIAIS</div>

      {/* Campeão */}
      <div className="cartao form-jogo" style={{ marginBottom: "10px" }}>
        <div className="secao-titulo" style={{ margin: "0 0 8px" }}>SELEÇÃO CAMPEÃ · +{BONUS_CAMPEAO} pts para quem acertou</div>
        {resultado.campeao?.confirmado ? (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "20px", fontWeight: 800 }}>{fl(resultado.campeao.valor)}{resultado.campeao.valor}</span>
            <span className="tag tag-travado">🔒 confirmado</span>
          </div>
        ) : (
          <>
            <input
              type="text"
              placeholder="Buscar seleção campeã…"
              value={campeaoFiltro}
              onChange={(e) => { setCampeaoFiltro(e.target.value); setPedindoConfirm(null); }}
            />
            <div className="lista-campeao">
              {filtradas.map((s) => (
                <button
                  key={s}
                  className={"campeao-item" + (s === campeaoSel ? " campeao-item-ativo" : "")}
                  onClick={() => { setCampeaoSel(s); setCampeaoFiltro(""); salvar("campeao", s); }}
                  disabled={salvando}
                >
                  <span className="campeao-item-nome">{fl(s)}{s}</span>
                  {s === campeaoSel && <span className="palpite-status ok">✓</span>}
                </button>
              ))}
            </div>
            {campeaoSel && pedindoConfirm !== "campeao" && (
              <button
                className="botao botao-largo"
                style={{ marginTop: "8px" }}
                onClick={() => setPedindoConfirm("campeao")}
                disabled={salvando || !!confirmando}
              >
                🔒 Confirmar campeã e distribuir +{BONUS_CAMPEAO} pts
              </button>
            )}
            {pedindoConfirm === "campeao" && (
              <>
                <p style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "11px", color: "var(--erro)", marginTop: "8px" }}>
                  ⚠ Confirmar <strong>{campeaoSel}</strong> como campeã? Não poderá alterar.
                </p>
                <div className="form-linha">
                  <button className="botao" style={{ flex: 1 }} onClick={() => confirmar("campeao")} disabled={!!confirmando}>
                    {confirmando === "campeao" ? "Confirmando…" : "Sim, confirmar!"}
                  </button>
                  <button className="botao-fantasma" onClick={() => setPedindoConfirm(null)}>Cancelar</button>
                </div>
              </>
            )}
          </>
        )}
        {vencedoresCampeao.length > 0 && (
          <div style={{ marginTop: "10px" }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "10px", opacity: .7, marginBottom: "6px" }}>GANHARAM +{BONUS_CAMPEAO} PTS:</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {vencedoresCampeao.map((v) => (
                <span key={v.participante_id} className="pts pts-3">{nomeParticipante(v.participante_id)}</span>
              ))}
            </div>
          </div>
        )}
        {resultado.campeao?.confirmado && vencedoresCampeao.length === 0 && (
          <p className="dica" style={{ marginTop: "8px", opacity: .6 }}>Ninguém acertou o campeão.</p>
        )}
      </div>

      {/* Seleções eliminadas (manual, visual na aba Campeão) */}
      {selsCampeao.length > 0 && (
        <div className="cartao form-jogo" style={{ marginBottom: "10px" }}>
          <div className="secao-titulo" style={{ margin: "0 0 4px" }}>SELEÇÕES ELIMINADAS</div>
          <p className="dica" style={{ marginTop: 0, marginBottom: "8px", opacity: .7 }}>
            Marca a seleção eliminada → o card de quem a escolheu fica acinzentado na aba Campeão. Reversível.
          </p>
          {selsCampeao.map((sel) => {
            const elim = eliminadaSel(sel);
            const code = FLAG_CODES[sel];
            return (
              <div key={sel} className={"cartao palpite-linha" + (elim ? " card-eliminado" : "")} style={{ marginBottom: "6px" }}>
                <span className="palpite-nome">
                  {fl(sel)}{sel}
                  {elim && <span className="tag-eliminada" style={{ marginLeft: 8 }}>✗ eliminada</span>}
                </span>
                {elim ? (
                  <button className="botao-fantasma" style={{ padding: "4px 10px", fontSize: "13px" }}
                    onClick={() => salvarEliminadas((estado.selecoesEliminadas || []).filter((c) => c !== code))}
                    disabled={salvandoElim}>↩ desmarcar</button>
                ) : pedindoElim === sel ? (
                  <span style={{ display: "inline-flex", gap: "6px", flex: "none" }}>
                    <button className="botao" style={{ padding: "4px 10px", fontSize: "13px" }}
                      onClick={async () => { await salvarEliminadas([...new Set([...(estado.selecoesEliminadas || []), code])]); setPedindoElim(null); }}
                      disabled={salvandoElim || !code}>Sim, eliminar</button>
                    <button className="botao-fantasma" style={{ padding: "4px 10px", fontSize: "13px" }}
                      onClick={() => setPedindoElim(null)}>Não</button>
                  </span>
                ) : (
                  <button className="botao-fantasma" style={{ padding: "4px 10px", fontSize: "13px" }}
                    onClick={() => setPedindoElim(sel)} disabled={!code}
                    title={code ? "" : "Sem código de bandeira — não dá pra marcar"}>marcar eliminada</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Artilheiro */}
      <div className="cartao form-jogo">
        <div className="secao-titulo" style={{ margin: "0 0 8px" }}>ARTILHEIRO · +{BONUS_ARTILHEIRO} pts para quem acertou</div>
        {resultado.artilheiro?.confirmado ? (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            {resultado.artilheiro.valor && <span style={{ fontSize: "20px", fontWeight: 800 }}>{resultado.artilheiro.valor}</span>}
            <span className="tag tag-travado">🔒 confirmado</span>
          </div>
        ) : (
          <input
            type="text"
            placeholder="Nome do artilheiro (opcional, para exibição)…"
            value={artilheiroVal}
            onChange={(e) => { setArtilheiroVal(e.target.value); setPedindoConfirm(null); }}
            onBlur={() => artilheiroVal.trim().length >= 2 && salvar("artilheiro", artilheiroVal.trim())}
            maxLength={80}
          />
        )}

        {/* lista de picks dos participantes */}
        {(estado.palpitesArtilheiro?.length > 0) && (
          <div style={{ marginTop: "10px" }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "10px", opacity: .7, marginBottom: "6px", letterSpacing: ".1em" }}>
              {resultado.artilheiro?.confirmado
                ? "PICKS SUBMETIDOS:"
                : resultado.artilheiro?.valor
                ? "MARQUE QUEM ACERTOU:"
                : "PICKS DA GALERA:"}
            </div>
            {!resultado.artilheiro?.confirmado && !resultado.artilheiro?.valor && (
              <p className="dica" style={{ marginTop: 0, marginBottom: "6px", opacity: .6, fontSize: "11px" }}>
                Digite o artilheiro real acima pra liberar os botões de "marcar quem acertou" (evita clique errado enquanto você atualiza os gols).
              </p>
            )}
            {(() => {
              /* quando há artilheiro real digitado (fase de marcar, não confirmado),
                 destaca os picks que batem e joga eles pro topo — pra você não caçar
                 grafias variantes (Mbappé/MBAPPE/Kylian Mbappe) no meio da lista. */
              const realArt = !resultado.artilheiro?.confirmado ? resultado.artilheiro?.valor : null;
              const bate = (pick) => !!realArt && bateArtilheiro(realArt, pick.jogador);
              const lista = realArt
                ? [...estado.palpitesArtilheiro].sort((x, y) => (bate(y) ? 1 : 0) - (bate(x) ? 1 : 0))
                : estado.palpitesArtilheiro;
              return lista.map((pick) => {
              const isPremiado = (estado.premiadosArtilheiro || []).includes(pick.participante_id);
              const casaNome = bate(pick);
              return (
                <div
                  key={pick.participante_id}
                  className={"cartao palpite-linha" + (isPremiado ? " meu-palpite" : "")}
                  style={{ marginBottom: "6px", ...(casaNome && !isPremiado ? { borderColor: "var(--acerto, #2e7d32)" } : {}) }}
                >
                  <span className="palpite-nome">{nomeParticipante(pick.participante_id)}</span>
                  <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "13px", opacity: .85, flex: "none" }}>
                    {casaNome && <span title="Bate com o artilheiro real (confira e marque)" style={{ color: "var(--acerto, #2e7d32)", marginRight: 6 }}>●&nbsp;bate</span>}
                    {pick.jogador}
                  </span>
                  {resultado.artilheiro?.confirmado ? (
                    isPremiado && <span className="pts pts-3">+{BONUS_ARTILHEIRO}</span>
                  ) : resultado.artilheiro?.valor ? (
                    <button
                      className={isPremiado ? "botao" : "botao-fantasma"}
                      style={{ padding: "4px 10px", fontSize: "13px" }}
                      onClick={() => togglePremiado(pick.participante_id)}
                      disabled={toggling}
                    >
                      {isPremiado ? "✓ Acertou" : "Marcar"}
                    </button>
                  ) : (
                    /* sem artilheiro real digitado: não mostra botão de MARCAR
                       (evita clique acidental enquanto atualiza os gols), mas quem
                       JÁ está marcado sempre pode ser DESmarcado — senão marcações
                       antigas/de teste ficam presas sem como remover. */
                    isPremiado && (
                      <button
                        className="botao-fantasma"
                        style={{ padding: "4px 10px", fontSize: "13px" }}
                        onClick={() => togglePremiado(pick.participante_id)}
                        disabled={toggling}
                      >
                        ✓ desmarcar
                      </button>
                    )
                  )}
                </div>
              );
              });
            })()}
          </div>
        )}
        {(!estado.palpitesArtilheiro || estado.palpitesArtilheiro.length === 0) && (
          <p className="dica" style={{ marginTop: "8px", opacity: .6 }}>Ninguém escolheu artilheiro ainda.</p>
        )}

        {!resultado.artilheiro?.confirmado && (estado.premiadosArtilheiro || []).length > 0 && pedindoConfirm !== "artilheiro" && (
          <button
            className="botao botao-largo"
            style={{ marginTop: "10px" }}
            onClick={() => setPedindoConfirm("artilheiro")}
            disabled={salvando || !!confirmando}
          >
            🔒 Confirmar e distribuir +{BONUS_ARTILHEIRO} pts
          </button>
        )}
        {pedindoConfirm === "artilheiro" && (
          <>
            <p style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "11px", color: "var(--erro)", marginTop: "8px" }}>
              ⚠ Confirmar {(estado.premiadosArtilheiro || []).length} ganhador{(estado.premiadosArtilheiro || []).length === 1 ? "" : "es"} do artilheiro? Não poderá alterar.
            </p>
            <div className="form-linha">
              <button className="botao" style={{ flex: 1 }} onClick={() => confirmar("artilheiro")} disabled={!!confirmando}>
                {confirmando === "artilheiro" ? "Confirmando…" : "Sim, confirmar!"}
              </button>
              <button className="botao-fantasma" onClick={() => setPedindoConfirm(null)}>Cancelar</button>
            </div>
          </>
        )}

        {resultado.artilheiro?.confirmado && (estado.premiadosArtilheiro || []).length === 0 && (
          <p className="dica" style={{ marginTop: "8px", opacity: .6 }}>Ninguém acertou o artilheiro.</p>
        )}
      </div>

      {/* Gols atuais → ranking do artilheiro na aba Artilheiro */}
      {jogadoresArt.length > 0 && (
        <div className="cartao form-jogo">
          <div className="secao-titulo" style={{ margin: "0 0 4px" }}>GOLS ATUAIS — RANKING DO ARTILHEIRO</div>
          <p className="dica" style={{ marginTop: 0, marginBottom: "8px", opacity: .7 }}>
            Nº de gols de cada jogador que a galera escolheu. A aba Artilheiro mostra o ranking por isso.
          </p>
          {jogadoresArt.map(([n, display]) => (
            <div key={n} className="cartao palpite-linha" style={{ marginBottom: "6px" }}>
              <span className="palpite-nome">{display}</span>
              <input type="number" min="0" max="99" inputMode="numeric" placeholder="0"
                value={golsEdit[n] ?? ""}
                onChange={(e) => setGolsEdit((g) => ({ ...g, [n]: e.target.value }))}
                style={{ width: "70px", textAlign: "center", flex: "none" }} />
            </div>
          ))}
          <button className="botao botao-largo" style={{ marginTop: "8px" }}
            onClick={() => salvarGols(jogadoresArt)} disabled={salvandoGols}>
            {salvandoGols ? "Salvando…" : "💾 Salvar gols"}
          </button>
        </div>
      )}

      {aviso && <p className="dica toast" role="status">{aviso}</p>}
    </div>
  );
}

/* ================= AVATAR ================= */

const EMOJIS_REACAO = ["🔥", "😱", "💀", "🎯", "😂", "🤡", "🐐", "💪", "😭", "🫡", "⚽", "🏆"];

const PALETA_CORES = [
  "#e05c3a", "#e8a838", "#5cb85c", "#3a9de0",
  "#9b59b6", "#e91e8c", "#00bcd4", "#607d8b",
];

const EMOJIS_AVATAR = [
  "⚽", "🏆", "🎯", "🔥", "⚡", "💪", "🦁", "🐉",
  "👑", "🦊", "🐺", "🦅", "🚀", "🌟", "💎", "🎩",
  "🧠", "🐍", "🦈", "🎭", "🌙", "🎪", "🥇", "🏅",
];

function corDoNome(nome) {
  let h = 0;
  for (let i = 0; i < nome.length; i++) h = (h * 31 + nome.charCodeAt(i)) >>> 0;
  return PALETA_CORES[h % PALETA_CORES.length];
}

function Avatar({ nome, emoji, cor, size = 36 }) {
  const iniciais = nome.split(" ").filter(Boolean).slice(0, 2).map((n) => n[0].toUpperCase()).join("");
  const bg = cor || corDoNome(nome);
  const fontSize = emoji ? Math.round(size * 0.56) : Math.round(size * 0.4);
  return (
    <div className="avatar" style={{ width: size, height: size, background: bg, fontSize }}>
      {emoji || iniciais}
    </div>
  );
}

function ReacaoStrip({ jogoId, reacoes, euId, token, onUpdate }) {
  const [abrirPicker, setAbrirPicker] = useState(false);
  const [salvando, setSalvando] = useState(false);

  const contagem = {};
  for (const r of reacoes) contagem[r.emoji] = (contagem[r.emoji] || 0) + 1;
  const minhaReacao = reacoes.find((r) => r.participante_id === euId)?.emoji;
  const temReacoes = Object.keys(contagem).length > 0;

  const reagir = async (emoji) => {
    if (salvando) return;
    setSalvando(true);
    setAbrirPicker(false);
    try {
      await api("/api/reacao", { method: "POST", body: JSON.stringify({ t: token, jogoId, emoji }) });
      await onUpdate();
    } catch {}
    setSalvando(false);
  };

  return (
    <div className="reacao-strip">
      {EMOJIS_REACAO.filter((e) => contagem[e]).map((e) => (
        <button
          key={e}
          className={"reacao-chip" + (minhaReacao === e ? " reacao-chip-minha" : "")}
          onClick={() => reagir(e)}
          disabled={salvando}
          title={`${contagem[e]} reação${contagem[e] !== 1 ? "ões" : ""}`}
        >
          {e} <span className="reacao-count">{contagem[e]}</span>
        </button>
      ))}
      {abrirPicker ? (
        <div className="reacao-picker">
          {EMOJIS_REACAO.map((e) => (
            <button key={e} className="reacao-picker-btn" onClick={() => reagir(e)} disabled={salvando}>{e}</button>
          ))}
          <button className="reacao-picker-fechar" onClick={() => setAbrirPicker(false)}>✕</button>
        </div>
      ) : (
        <button
          className={"reacao-add" + (minhaReacao && !temReacoes ? " reacao-add-ativa" : "")}
          onClick={() => setAbrirPicker(true)}
          disabled={salvando}
          title="Reagir"
        >
          {minhaReacao && !contagem[minhaReacao] ? minhaReacao : "+"}
        </button>
      )}
    </div>
  );
}

/* Linhas de bônus de campeã/artilheiro — pontos que não vêm de nenhum jogo
   específico, então precisam aparecer explicados (senão parecem "sumir do
   nada" no histórico). Compartilhado entre Meu Perfil e Campeão do Bolão. */
function BonusEspeciais({ participante, style }) {
  if (!participante?.acertouCampeao && !participante?.acertouArtilheiro) return null;
  return (
    <div className="perfil-destaques" style={style}>
      {participante.acertouCampeao && (
        <div className="perfil-destaque">
          <span className="perfil-destaque-icon">🏆</span>
          <span className="perfil-destaque-txt">Acertou a campeã</span>
          <span className="perfil-destaque-pts perfil-bd-exato">+{BONUS_CAMPEAO} pts</span>
        </div>
      )}
      {participante.acertouArtilheiro && (
        <div className="perfil-destaque">
          <span className="perfil-destaque-icon">⚽</span>
          <span className="perfil-destaque-txt">Acertou o artilheiro</span>
          <span className="perfil-destaque-pts perfil-bd-exato">+{BONUS_ARTILHEIRO} pts</span>
        </div>
      )}
    </div>
  );
}

function PerfilPicker({ nome, emoji: emojiInicial, cor: corInicial, onSalvar, onFechar, euId, isAdmin, estado, palpitesMap, ranking }) {
  const [emojiSel, setEmojiSel] = useState(emojiInicial || "");
  const [corSel, setCorSel] = useState(corInicial || corDoNome(nome));
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    setEmojiSel(emojiInicial || "");
    setCorSel(corInicial || corDoNome(nome));
  }, [emojiInicial, corInicial, nome]);

  const pick = async (novoEmoji, novaCor) => {
    setEmojiSel(novoEmoji);
    setCorSel(novaCor);
    setSalvando(true);
    try { await onSalvar(novoEmoji || null, novaCor); } catch {}
    setSalvando(false);
  };

  const iniciais = nome.split(" ").filter(Boolean).slice(0, 2).map((n) => n[0].toUpperCase()).join("");

  /* ── stats ── (fonte única: mesmo cálculo usado no Campeão do Bolão) */
  const {
    jogosEncerrados, temAoVivo: perfilTemAoVivo, comPalpite,
    apostasFeitas, acertosExatos, acertosResult, erros,
    aproveitamento, melhor, pior,
  } = calcularDetalhamento(euId, estado || { jogos: [] }, palpitesMap || {});

  const euRanking   = ranking?.find((p) => p.id === euId);
  const posicao     = ranking ? ranking.findIndex((p) => p.id === euId) + 1 : 0;
  const totalPts    = euRanking?.pontos ?? 0;

  const temStats = jogosEncerrados.length > 0;

  return (
    <div className="perfil-picker entra-2">
      {/* topo */}
      <div className="perfil-picker-topo">
        <div className="perfil-picker-preview">
          <Avatar nome={nome} emoji={emojiSel} cor={corSel} size={48} />
          <div>
            <div className="perfil-picker-nome">{nome}</div>
            {isAdmin && <div className="perfil-badge-admin">Organizador</div>}
          </div>
        </div>
        <button className="apagar" onClick={onFechar} aria-label="Fechar perfil">✕</button>
      </div>

      {/* headline stats */}
      {temStats && (
        <>
          <div className="perfil-headline">
            <div className="perfil-hl-item">
              <span className="perfil-hl-num">{posicao}º</span>
              <span className="perfil-hl-label">lugar</span>
            </div>
            <div className="perfil-hl-sep" />
            <div className="perfil-hl-item">
              <span className="perfil-hl-num">{totalPts}</span>
              <span className="perfil-hl-label">pontos</span>
            </div>
            <div className="perfil-hl-sep" />
            <div className="perfil-hl-item">
              <span className="perfil-hl-num">{aproveitamento}%</span>
              <span className="perfil-hl-label">aproveito</span>
            </div>
          </div>

          {/* barra de aproveitamento */}
          <div className="perfil-barra-bg">
            <div className="perfil-barra-fill" style={{ width: `${aproveitamento}%` }} />
          </div>

          {/* breakdown */}
          <div className="perfil-breakdown">
            <span className="perfil-bd-item perfil-bd-exato">🎯 {acertosExatos} exato{acertosExatos !== 1 ? "s" : ""}</span>
            <span className="perfil-bd-item perfil-bd-result">✓ {acertosResult} certo{acertosResult !== 1 ? "s" : ""}</span>
            <span className="perfil-bd-item perfil-bd-erro">✗ {erros} erro{erros !== 1 ? "s" : ""}</span>
            <span className="perfil-bd-item perfil-bd-miss">{apostasFeitas}/{jogosEncerrados.length} apostas</span>
            {perfilTemAoVivo && <SeloParcial style={{ alignSelf: "center" }} />}
          </div>

          {/* mini gráfico */}
          {comPalpite.length > 0 && (
            <>
              <div className="secao-titulo" style={{ marginTop: "14px" }}>HISTÓRICO</div>
              <div className="perfil-chart">
                {comPalpite.map(({ jogo, pts, ptsPeso }, i) => (
                  <div
                    key={jogo.id}
                    className={"perfil-bar" + (pts === PTS_EXATO ? " perfil-bar-exato" : pts === PTS_RESULTADO ? " perfil-bar-result" : " perfil-bar-erro")}
                    style={{ "--h": pts === PTS_EXATO ? "100%" : pts === PTS_RESULTADO ? "40%" : "12%", "--i": i }}
                    title={`${jogo.casa} × ${jogo.fora}: ${ptsPeso} pt${ptsPeso !== 1 ? "s" : ""}${pesoDoJogo(jogo) > 1 ? ` (${pesoDoJogo(jogo)}×)` : ""}`}
                  />
                ))}
              </div>
            </>
          )}

          {/* melhor e pior */}
          {melhor && (
            <div className="perfil-destaques">
              <div className="perfil-destaque">
                <span className="perfil-destaque-icon">🏆</span>
                <span className="perfil-destaque-txt">{melhor.jogo.casa} × {melhor.jogo.fora}</span>
                <span className="perfil-destaque-pts perfil-bd-exato">{melhor.ptsPeso} pt{melhor.ptsPeso !== 1 ? "s" : ""}</span>
              </div>
              {pior && pior.jogo.id !== melhor.jogo.id && (
                <div className="perfil-destaque">
                  <span className="perfil-destaque-icon">💔</span>
                  <span className="perfil-destaque-txt">{pior.jogo.casa} × {pior.jogo.fora}</span>
                  <span className="perfil-destaque-pts perfil-bd-erro">{pior.ptsPeso} pt{pior.ptsPeso !== 1 ? "s" : ""}</span>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* bônus de campeã/artilheiro — pontos que já entram no total acima, mas
          não vêm de nenhum jogo, então precisam aparecer explicados aqui
          (senão parece que os pontos "somem do nada" no histórico). */}
      <BonusEspeciais participante={euRanking} style={{ marginTop: temStats ? 0 : "14px" }} />

      {/* personalizar */}
      <div className="secao-titulo" style={{ marginTop: "14px" }}>PERSONALIZAR</div>

      <div className="secao-titulo" style={{ marginTop: "8px", opacity: .55, fontSize: "9px" }}>COR</div>
      <div className="paleta">
        {PALETA_CORES.map((c) => (
          <button
            key={c}
            className={"paleta-cor" + (c === corSel ? " paleta-cor-ativa" : "")}
            style={{ background: c }}
            onClick={() => pick(emojiSel, c)}
            disabled={salvando}
            aria-label={"Cor " + c}
          />
        ))}
      </div>

      <div className="secao-titulo" style={{ marginTop: "12px", opacity: .55, fontSize: "9px" }}>EMOJI</div>
      <div className="emoji-grid">
        <button
          className={"emoji-item" + (!emojiSel ? " emoji-item-ativo" : "")}
          onClick={() => pick("", corSel)}
          disabled={salvando}
          title="Usar iniciais"
        >
          <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: "13px", fontWeight: 800 }}>
            {iniciais}
          </span>
        </button>
        {EMOJIS_AVATAR.map((e) => (
          <button
            key={e}
            className={"emoji-item" + (e === emojiSel ? " emoji-item-ativo" : "")}
            onClick={() => pick(e, corSel)}
            disabled={salvando}
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}

function Campeao({ token, euId, artilheiroGols = {}, selecoesEliminadas = [], resultadoEspecial = null, premiadosArtilheiro = [] }) {
  // — campeão —
  const [meu, setMeu] = useState(null);
  const [confirmados, setConfirmados] = useState([]);
  const [selecao, setSelecao] = useState("");
  const [filtro, setFiltro] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [pedindoConfirm, setPedindoConfirm] = useState(false);
  const [confirmando, setConfirmando] = useState(false);

  // — artilheiro —
  const [meuArt, setMeuArt] = useState(null);
  const [confirmadosArt, setConfirmadosArt] = useState([]);
  const [jogador, setJogador] = useState("");
  const [artSalvo, setArtSalvo] = useState(false);
  const [salvandoArt, setSalvandoArt] = useState(false);
  const [pedindoConfirmArt, setPedindoConfirmArt] = useState(false);
  const [confirmandoArt, setConfirmandoArt] = useState(false);
  const artTimerRef = useRef(null);

  const [carregando, setCarregando] = useState(true);
  const [aviso, setAviso] = useState("");
  const [sub, setSub] = useState("campeao"); // sub-aba: "campeao" | "artilheiro"

  const carregar = useCallback(async () => {
    try {
      const [rc, ra] = await Promise.all([
        api(`/api/campeao?t=${encodeURIComponent(token)}`),
        api(`/api/artilheiro?t=${encodeURIComponent(token)}`),
      ]);
      setMeu(rc.meu);
      setConfirmados(rc.confirmados);
      if (rc.meu) setSelecao(rc.meu.selecao);
      setMeuArt(ra.meu);
      setConfirmadosArt(ra.confirmados);
      if (ra.meu) { setJogador(ra.meu.jogador); setArtSalvo(true); }
    } catch (e) {
      setAviso(e.message);
    } finally {
      setCarregando(false);
    }
  }, [token]);

  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => {
    if (!aviso) return;
    const t = setTimeout(() => setAviso(""), 5000);
    return () => clearTimeout(t);
  }, [aviso]);

  const selecionarTime = async (time) => {
    setSelecao(time);
    setFiltro("");
    setPedindoConfirm(false);
    setSalvando(true);
    try {
      await api("/api/campeao", {
        method: "POST",
        body: JSON.stringify({ t: token, selecao: time }),
      });
      setMeu((prev) => ({ selecao: time, confirmado: prev?.confirmado ?? false }));
    } catch (e) {
      setAviso(e.message);
    }
    setSalvando(false);
  };

  const confirmar = async () => {
    setConfirmando(true);
    try {
      await api("/api/campeao", { method: "PUT", body: JSON.stringify({ t: token }) });
      await carregar();
      setPedindoConfirm(false);
    } catch (e) {
      setAviso(e.message);
      setPedindoConfirm(false);
    }
    setConfirmando(false);
  };

  const mudarJogador = (valor) => {
    setJogador(valor);
    setArtSalvo(false);
    setPedindoConfirmArt(false);
    clearTimeout(artTimerRef.current);
    if (valor.trim().length >= 2) {
      artTimerRef.current = setTimeout(async () => {
        setSalvandoArt(true);
        try {
          await api("/api/artilheiro", {
            method: "POST",
            body: JSON.stringify({ t: token, jogador: valor.trim() }),
          });
          setMeuArt((prev) => ({ jogador: valor.trim(), confirmado: prev?.confirmado ?? false }));
          setArtSalvo(true);
        } catch (e) {
          setAviso(e.message);
        }
        setSalvandoArt(false);
      }, 900);
    }
  };

  const confirmarArt = async () => {
    setConfirmandoArt(true);
    try {
      await api("/api/artilheiro", { method: "PUT", body: JSON.stringify({ t: token }) });
      await carregar();
      setPedindoConfirmArt(false);
    } catch (e) {
      setAviso(e.message);
      setPedindoConfirmArt(false);
    }
    setConfirmandoArt(false);
  };

  if (carregando) {
    return <div className="carregando"><span className="bola-quica">⚽</span> Carregando…</div>;
  }

  const isMaster = euId === null;
  const confirmado = meu?.confirmado;
  const confirmadoArt = meuArt?.confirmado;
  const filtradas = filtro
    ? SELECOES.filter((s) => normBusca(s).includes(normBusca(filtro)))
    : SELECOES;

  return (
    <div>
      <div className="segmento" role="tablist" aria-label="Campeão ou artilheiro">
        <button
          type="button" role="tab" aria-selected={sub === "campeao"}
          className={"segmento-btn" + (sub === "campeao" ? " segmento-btn-ativo" : "")}
          onClick={() => setSub("campeao")}
        >🏆 Campeão</button>
        <button
          type="button" role="tab" aria-selected={sub === "artilheiro"}
          className={"segmento-btn" + (sub === "artilheiro" ? " segmento-btn-ativo" : "")}
          onClick={() => setSub("artilheiro")}
        >⚽ Artilheiro</button>
      </div>

      {sub === "campeao" && (
        <>
          {!isMaster && (
            <>
              <div className="secao-titulo">SEU PALPITE</div>

          {confirmado ? (
            <div className="cartao meu-palpite" style={{ textAlign: "center", padding: "22px 16px" }}>
              <div style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: "11px", letterSpacing: ".14em",
                color: "var(--ambar)", marginBottom: "10px",
              }}>
                🔒 CONFIRMADO
              </div>
              <div style={{ fontSize: "28px", fontWeight: 800, letterSpacing: ".03em" }}>
                {fl(meu.selecao)}{meu.selecao}
              </div>
            </div>
          ) : (
            <div className="cartao form-jogo">
              <input
                type="text"
                placeholder="Buscar seleção…"
                value={filtro}
                onChange={(e) => { setFiltro(e.target.value); setPedindoConfirm(false); }}
              />
              <div className="lista-campeao">
                {filtradas.map((s) => (
                  <button
                    key={s}
                    className={"campeao-item" + (s === selecao ? " campeao-item-ativo" : "")}
                    onClick={() => selecionarTime(s)}
                    disabled={salvando || confirmando}
                  >
                    <span className="campeao-item-nome">{fl(s)}{s}</span>
                    {s === selecao && (
                      salvando
                        ? <span className="palpite-status">salvando…</span>
                        : <span className="palpite-status ok">✓ salvo</span>
                    )}
                  </button>
                ))}
                {filtradas.length === 0 && (
                  <p className="campeao-vazio">Nenhuma seleção encontrada.</p>
                )}
              </div>

              {selecao && !pedindoConfirm && (
                <button
                  className="botao botao-largo"
                  style={{ marginTop: "10px" }}
                  onClick={() => setPedindoConfirm(true)}
                  disabled={salvando || confirmando}
                >
                  🔒 Confirmar e travar
                </button>
              )}

              {pedindoConfirm && (
                <>
                  <p style={{
                    fontFamily: "'IBM Plex Mono', monospace", fontSize: "11px",
                    letterSpacing: ".06em", color: "var(--erro)",
                    marginTop: "10px", marginBottom: "8px",
                  }}>
                    ⚠ <strong>{selecao}</strong> será seu palpite definitivo — não poderá alterar.
                  </p>
                  <div className="form-linha">
                    <button className="botao" style={{ flex: 1 }} onClick={confirmar} disabled={confirmando}>
                      {confirmando ? "Travando…" : "Sim, travar!"}
                    </button>
                    <button className="botao-fantasma" onClick={() => setPedindoConfirm(false)} disabled={confirmando}>
                      Cancelar
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
            </>
          )}

          <div className="secao-titulo">QUEM JÁ CONFIRMOU</div>
          {confirmados.length === 0 ? (
            <Vazio texto="Nenhum palpite confirmado ainda — seja o primeiro!" />
          ) : (
            confirmados.map((c, i) => {
              const eliminada = selecoesEliminadas.includes(FLAG_CODES[c.selecao]);
              const acertou = resultadoEspecial?.campeao?.confirmado && c.selecao === resultadoEspecial.campeao.valor;
              return (
                <div
                  key={c.participante_id}
                  className={"cartao palpite-linha entra-cartao" + (c.participante_id === euId ? " meu-palpite" : "") + (eliminada ? " card-eliminado" : "")}
                  style={{ "--i": Math.min(i, 8) }}
                >
                  <span className="palpite-nome">
                    {c.nome}{c.participante_id === euId ? " (você)" : ""}
                  </span>
                  {eliminada && <span className="tag-eliminada">✗ eliminada</span>}
                  {acertou && <span className="pts pts-3" title={`Acertou a campeã! +${BONUS_CAMPEAO} pts`}>✓ +{BONUS_CAMPEAO}</span>}
                  <span className="pts pts-1">{fl(c.selecao)}{c.selecao}</span>
                </div>
              );
            })
          )}
        </>
      )}

      {sub === "artilheiro" && (
        <>
          {!isMaster && (
            <>
              <div className="secao-titulo">SEU PALPITE</div>

          {confirmadoArt ? (
            <div className="cartao meu-palpite" style={{ textAlign: "center", padding: "22px 16px" }}>
              <div style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: "11px", letterSpacing: ".14em",
                color: "var(--ambar)", marginBottom: "10px",
              }}>
                🔒 CONFIRMADO
              </div>
              <div style={{ fontSize: "28px", fontWeight: 800, letterSpacing: ".03em" }}>
                {meuArt.jogador}
              </div>
            </div>
          ) : (
            <div className="cartao form-jogo">
              <div className="form-linha">
                <input
                  type="text"
                  placeholder="Nome do jogador…"
                  value={jogador}
                  onChange={(e) => mudarJogador(e.target.value)}
                  disabled={salvandoArt || confirmandoArt}
                  maxLength={80}
                />
                {salvandoArt && (
                  <span className="palpite-status" style={{ whiteSpace: "nowrap" }}>salvando…</span>
                )}
                {artSalvo && !salvandoArt && (
                  <span className="palpite-status ok" style={{ whiteSpace: "nowrap" }}>✓ salvo</span>
                )}
              </div>

              {artSalvo && !pedindoConfirmArt && (
                <button
                  className="botao botao-largo"
                  style={{ marginTop: "10px" }}
                  onClick={() => setPedindoConfirmArt(true)}
                  disabled={salvandoArt || confirmandoArt}
                >
                  🔒 Confirmar e travar
                </button>
              )}

              {pedindoConfirmArt && (
                <>
                  <p style={{
                    fontFamily: "'IBM Plex Mono', monospace", fontSize: "11px",
                    letterSpacing: ".06em", color: "var(--erro)",
                    marginTop: "10px", marginBottom: "8px",
                  }}>
                    ⚠ <strong>{jogador.trim()}</strong> será seu palpite definitivo — não poderá alterar.
                  </p>
                  <div className="form-linha">
                    <button className="botao" style={{ flex: 1 }} onClick={confirmarArt} disabled={confirmandoArt}>
                      {confirmandoArt ? "Travando…" : "Sim, travar!"}
                    </button>
                    <button className="botao-fantasma" onClick={() => setPedindoConfirmArt(false)} disabled={confirmandoArt}>
                      Cancelar
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
            </>
          )}

          {(() => { const temGols = Object.keys(artilheiroGols).length > 0; return (<>
          <div className="secao-titulo">{temGols ? "RANKING DO ARTILHEIRO ⚽" : "QUEM JÁ CONFIRMOU"}</div>
          {confirmadosArt.length === 0 ? (
            <Vazio texto="Nenhum palpite confirmado ainda — seja o primeiro!" />
          ) : temGols ? (
            (() => {
              /* ranking por gols do jogador escolhido; posição DENSA: mesmo nº de
                 gols = mesma posição, e o próximo grupo é a posição seguinte, sem
                 pular (1,1,1,1,2,3…) — ex.: 4 no Mbappé (6 gols) em 1º, Kane (5) em 2º. */
              const rank = confirmadosArt
                .map((c) => ({ ...c, gols: Number(artilheiroGols[normTexto(c.jogador)]) || 0 }))
                .sort((a, b) => b.gols - a.gols || a.nome.localeCompare(b.nome));
              let pos = 0, prev = null;
              rank.forEach((c) => { if (c.gols !== prev) { pos += 1; prev = c.gols; } c.pos = pos; });
              return rank.map((c, i) => {
                const acertou = resultadoEspecial?.artilheiro?.confirmado && premiadosArtilheiro.includes(c.participante_id);
                return (
                <div
                  key={c.participante_id}
                  className={"cartao palpite-linha entra-cartao" + (c.participante_id === euId ? " meu-palpite" : "")}
                  style={{ "--i": Math.min(i, 8) }}
                >
                  <span className={"rank-pos" + (c.pos <= 3 ? " rank-pos-top" : "")}>{c.pos}º</span>
                  <span className="palpite-nome" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                    <span>{c.nome}{c.participante_id === euId ? " (você)" : ""}</span>
                    <span className="rank-jogador">{c.jogador}</span>
                  </span>
                  {acertou && <span className="pts pts-3" title={`Acertou o artilheiro! +${BONUS_ARTILHEIRO} pts`}>✓ +{BONUS_ARTILHEIRO}</span>}
                  <span className="pts pts-1">⚽ {c.gols}</span>
                </div>
                );
              });
            })()
          ) : (
            confirmadosArt.map((c, i) => {
              const acertou = resultadoEspecial?.artilheiro?.confirmado && premiadosArtilheiro.includes(c.participante_id);
              return (
              <div
                key={c.participante_id}
                className={"cartao palpite-linha entra-cartao" + (c.participante_id === euId ? " meu-palpite" : "")}
                style={{ "--i": Math.min(i, 8) }}
              >
                <span className="palpite-nome">
                  {c.nome}{c.participante_id === euId ? " (você)" : ""}
                </span>
                {acertou && <span className="pts pts-3" title={`Acertou o artilheiro! +${BONUS_ARTILHEIRO} pts`}>✓ +{BONUS_ARTILHEIRO}</span>}
                <span className="pts pts-1">{c.jogador}</span>
              </div>
              );
            })
          )}
          </>); })()}
        </>
      )}

      {aviso && <p className="dica toast" role="status">{aviso}</p>}
    </div>
  );
}

/* ================= MODAL REGRAS ================= */
/* ================= MODAL PAGAMENTO ================= */
function ModalPagamento({ onFechar }) {
  const DEADLINE = DEADLINE_PAGAMENTO;
  const [seg, setSeg] = useState(() => Math.max(0, Math.floor((DEADLINE - Date.now()) / 1000)));
  const [copiado, setCopiado] = useState(false);
  const PIX = "9a92ec8d-356e-43a7-a56a-de947add29dd"; // chave PIX aleatória (sem PII — item P5)

  useEffect(() => {
    if (seg <= 0) return;
    const id = setInterval(() => setSeg(Math.max(0, Math.floor((DEADLINE - Date.now()) / 1000))), 1000);
    return () => clearInterval(id);
  }, []);

  const copiarPix = async () => {
    try {
      await navigator.clipboard.writeText(PIX);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2500);
    } catch { /* silencioso */ }
  };

  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(seg / 3600);
  const m = Math.floor((seg % 3600) / 60);
  const s = seg % 60;

  return (
    <div className="modal-overlay" onClick={onFechar}>
      <div className="modal-painel modal-pagamento" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-nome">💸 Pagamento pendente</div>
          <button className="apagar" onClick={onFechar} aria-label="Fechar">✕</button>
        </div>

        <div className="pagamento-corpo">
          <p className="pagamento-aviso">Você ainda não confirmou seu pagamento.<br/>Garante sua vaga no bolão!</p>

          <div className="pagamento-valor">R$ {VALOR_ENTRADA},00</div>

          <div className="pagamento-pix-bloco">
            <span className="pagamento-pix-label">Chave PIX</span>
            <div className="pagamento-pix-linha">
              <span className="pagamento-pix-chave">{PIX}</span>
              <button className="botao pagamento-copiar" onClick={copiarPix}>
                {copiado ? "✓ Copiado!" : "📋 Copiar"}
              </button>
            </div>
          </div>

          {seg > 0 && (
            <div className="pagamento-timer">
              <span className="timer-label">⏰ Prazo encerra em</span>
              <div className="timer-display">
                <span className="timer-bloco"><span className="timer-num">{pad(h)}</span><span className="timer-unidade">h</span></span>
                <span className="timer-sep">:</span>
                <span className="timer-bloco"><span className="timer-num">{pad(m)}</span><span className="timer-unidade">m</span></span>
                <span className="timer-sep">:</span>
                <span className="timer-bloco"><span className="timer-num">{pad(s)}</span><span className="timer-unidade">s</span></span>
              </div>
              <span className="timer-data">{DEADLINE_PAGAMENTO_LABEL}</span>
            </div>
          )}

          <button className="botao-fantasma pagamento-fechar" onClick={onFechar}>
            Já paguei / fechar
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================= MODAL LEMBRETE DE PALPITES ================= */
function ModalLembretePalpites({ pendentes, nearest, offsetMs, onPalpitar, onFechar }) {
  const calc = () => Math.max(0, Math.floor((new Date(nearest.kickoff).getTime() - (Date.now() + offsetMs)) / 1000));
  const [seg, setSeg] = useState(calc);
  useEffect(() => {
    const id = setInterval(() => setSeg(calc()), 1000);
    return () => clearInterval(id);
  }, [nearest.kickoff, offsetMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(seg / 3600);
  const m = Math.floor((seg % 3600) / 60);
  const s = seg % 60;
  const n = pendentes.length;

  return (
    <div className="modal-overlay" onClick={onFechar}>
      <div className="modal-painel modal-pagamento" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-nome">⚽ Faltam seus palpites!</div>
          <button className="apagar" onClick={onFechar} aria-label="Fechar">✕</button>
        </div>

        <div className="pagamento-corpo">
          <p className="pagamento-aviso">
            Você ainda não palpitou em <strong>{n} jogo{n === 1 ? "" : "s"}</strong> {n === 1 ? "que começa" : "que começam"} em breve.<br/>
            Palpitar antes ainda vale no desempate! ⏱
          </p>

          {seg > 0 && (
            <div className="pagamento-timer">
              <span className="timer-label">⏰ Próximo jogo em</span>
              <div className="timer-display">
                <span className="timer-bloco"><span className="timer-num">{pad(h)}</span><span className="timer-unidade">h</span></span>
                <span className="timer-sep">:</span>
                <span className="timer-bloco"><span className="timer-num">{pad(m)}</span><span className="timer-unidade">m</span></span>
                <span className="timer-sep">:</span>
                <span className="timer-bloco"><span className="timer-num">{pad(s)}</span><span className="timer-unidade">s</span></span>
              </div>
              <span className="timer-data">{nearest.casa} × {nearest.fora}</span>
            </div>
          )}

          <div className="lembrete-lista">
            {pendentes.map((j) => (
              <div key={j.id} className="lembrete-jogo">
                <span className="lembrete-jogo-times">{fl(j.casa)}{j.casa} <span className="vs">×</span> {fl(j.fora)}{j.fora}</span>
                <span className="lembrete-jogo-hora">{fmtQuando(j)}</span>
              </div>
            ))}
          </div>

          <button className="botao botao-largo" onClick={onPalpitar}>✍️ Palpitar agora</button>
          <button className="botao-fantasma pagamento-fechar" onClick={onFechar}>Agora não</button>
        </div>
      </div>
    </div>
  );
}

function ModalRegras({ onFechar }) {
  return (
    <div className="modal-overlay" onClick={onFechar}>
      <div className="modal-painel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-nome">📋 Regras do Bolão</div>
          <button className="apagar" onClick={onFechar} aria-label="Fechar">✕</button>
        </div>

        <div className="regras-corpo">
          <div className="regras-secao">Pontuação por jogo</div>
          <div className="regras-item">
            <span className="pts pts-3">3 pts</span>
            <span>Placar exato — acertou os dois gols</span>
          </div>
          <div className="regras-item">
            <span className="pts pts-1">1 pt</span>
            <span>Resultado certo — acertou quem ganhou ou que empatou</span>
          </div>
          <div className="regras-item">
            <span className="pts pts-0">0 pts</span>
            <span>Resultado errado</span>
          </div>

          <div className="regras-secao">Peso por fase 🔥</div>
          <p className="regras-p">
            Os pontos de cada jogo são <strong>multiplicados</strong> pela fase — erros no começo pesam menos,
            acertos no fim valem mais:
          </p>
          <div className="regras-pesos">
            <div className="regras-peso"><span className="regras-peso-x">1×</span><span>Fase de grupos</span></div>
            <div className="regras-peso"><span className="regras-peso-x">2×</span><span>16-avos e oitavas</span></div>
            <div className="regras-peso"><span className="regras-peso-x">3×</span><span>Quartas de final</span></div>
            <div className="regras-peso regras-peso-final"><span className="regras-peso-x">4×</span><span>Semifinal e 3º lugar</span></div>
            <div className="regras-peso regras-peso-final"><span className="regras-peso-x">5×</span><span>Final</span></div>
          </div>
          <p className="regras-p">
            Exemplo: placar exato na <strong>final</strong> vale <strong>{PTS_EXATO * 5} pts</strong> (3 × 5);
            nas <strong>quartas</strong> vale <strong>{PTS_EXATO * 3} pts</strong> (3 × 3);
            resultado certo nas <strong>oitavas</strong> vale <strong>{PTS_RESULTADO * 2} pts</strong> (1 × 2).
            Os bônus de campeã e artilheiro <strong>não</strong> têm peso.
          </p>

          <div className="regras-secao">Bônus especiais</div>
          <div className="regras-item">
            <span className="pts pts-3">+{BONUS_CAMPEAO} pts</span>
            <span>Acertar a seleção campeã (palpite travado antes da Copa)</span>
          </div>
          <div className="regras-item">
            <span className="pts pts-1">+{BONUS_ARTILHEIRO} pts</span>
            <span>Acertar o artilheiro da Copa (palpite travado antes da Copa)</span>
          </div>

          <div className="regras-secao">Mata-mata ⚔</div>
          <p className="regras-p">
            Nos jogos eliminatórios, o palpite vale pelo placar dos <strong>90 minutos + a prorrogação inteira</strong>.
            Os <strong>pênaltis ficam de fora</strong>.
          </p>
          <p className="regras-p">
            Exemplo: jogo está <strong>1×1</strong> nos 90min, sai um gol na prorrogação e termina <strong>2×1</strong>
            (sem pênaltis) → vale o <strong>2×1</strong>. Se ficar <strong>1×1</strong> na prorrogação e for decidido
            nos <strong>pênaltis</strong>, vale o <strong>1×1</strong> — o resultado dos pênaltis não conta.
          </p>

          <div className="regras-secao">Desempate (em caso de pontuação igual)</div>
          <div className="regras-item"><span className="pts pts-3">1º</span><span>Mais placares exatos</span></div>
          <div className="regras-item"><span className="pts pts-3">2º</span><span>Acertou a seleção campeã</span></div>
          <div className="regras-item"><span className="pts pts-3">3º</span><span>Acertou o artilheiro da Copa</span></div>
          <div className="regras-item"><span className="pts pts-1">4º</span><span>Mais resultados certos</span></div>
          <div className="regras-item"><span className="pts pts-0">5º</span><span>Quem palpita com mais antecedência (média antes do apito)</span></div>

          <div className="regras-secao">Prêmio 🏆</div>
          <p className="regras-p">
            O <strong>1º lugar</strong> no ranking final leva o valor total em caixa (R$ {VALOR_ENTRADA} × número de participantes).
            Em caso de empate técnico após todos os critérios de desempate, o prêmio é dividido igualmente entre os empatados.
          </p>

          <div className="regras-secao">Travamento de palpites</div>
          <p className="regras-p">
            Palpites são bloqueados automaticamente no minuto do apito inicial.
            Nenhum palpite dos outros participantes é visível antes disso — ninguém copia ninguém.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ================= PRÓXIMO JOGO ================= */
function ProximoCountdown({ kickoff, offsetMs }) {
  const calc = useCallback(
    () => new Date(kickoff).getTime() - (Date.now() + offsetMs),
    [kickoff, offsetMs]
  );
  const [restante, setRestante] = useState(calc);
  useEffect(() => {
    const id = setInterval(() => setRestante(calc()), 1000);
    return () => clearInterval(id);
  }, [calc]);

  if (restante <= 0) return <span className="prox-tempo">em breve</span>;
  const h = Math.floor(restante / 3600000);
  const min = Math.floor((restante % 3600000) / 60000);
  const seg = Math.floor((restante % 60000) / 1000);
  const tempo = h > 0
    ? `${h}h ${String(min).padStart(2, "0")}min`
    : min > 0
    ? `${min}m ${String(seg).padStart(2, "0")}s`
    : `${seg}s`;
  return <span className="prox-tempo">⏱ {tempo}</span>;
}

function ProximoJogo({ jogos, offsetMs = 0, onFechar, onNavegar }) {
  const agora = () => new Date(Date.now() + offsetMs);

  const aoVivo = jogos
    .filter((m) => !temResultado(m) && m.kickoff && new Date(m.kickoff) <= agora())
    .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))[0];

  const proximo = jogos
    .filter((m) => !temResultado(m) && m.kickoff && new Date(m.kickoff) > agora())
    .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))[0];

  const jogo = aoVivo || proximo;
  if (!jogo) return null;

  return (
    <div
      className={"prox-jogo entra-2" + (aoVivo ? " prox-jogo-vivo" : "")}
      onClick={() => onNavegar(jogo.id)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onNavegar(jogo.id); } }}
      role="button"
      tabIndex={0}
      style={{ cursor: "pointer" }}
      title="Abrir palpites deste jogo"
    >
      {aoVivo ? (
        <><span className="prox-vivo-dot" aria-hidden="true" /><span className="prox-label">AO VIVO</span></>
      ) : (
        <span className="prox-label">PRÓXIMO</span>
      )}
      <span className="prox-times">
        {fl(jogo.casa)}{jogo.casa} <span className="vs">×</span> {fl(jogo.fora)}{jogo.fora}
      </span>
      {proximo && !aoVivo && <ProximoCountdown kickoff={proximo.kickoff} offsetMs={offsetMs} />}
      <button
        className="prox-fechar"
        onClick={(e) => { e.stopPropagation(); onFechar(); }}
        aria-label="Fechar banner"
      >✕</button>
    </div>
  );
}

/* ================= MODAL PALPITES ================= */
function ModalPalpites({ participante, jogos, palpitesMap, euId, onFechar }) {
  /* inclui jogo ao vivo (temPlacar) p/ o total bater com o ranking — M4 */
  const encerrados = [...jogos]
    .filter(temPlacar)
    .sort((a, b) => {
      if (!a.kickoff && !b.kickoff) return 0;
      if (!a.kickoff) return 1;
      if (!b.kickoff) return -1;
      return new Date(b.kickoff) - new Date(a.kickoff);
    });
  const modalTemAoVivo = encerrados.some((m) => m.live);
  /* total/exatos/result vêm direto da linha do ranking (participante): assim o
     modal mostra o MESMO total do ranking, incluindo o bônus de campeã/artilheiro.
     Durante a Copa o bônus é 0, então nada muda; no fim, a conta fecha com as
     linhas de bônus abaixo (item M4 — alinhamento do total). */
  const { pontos: totalPts, exatos: totalExatos, resultados: totalResultados } = participante;

  return (
    <div className="modal-overlay" onClick={onFechar}>
      <div className="modal-painel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <Avatar nome={participante.nome} emoji={participante.avatarEmoji} cor={participante.avatarCor} size={44} />
            <div>
              <div className="modal-nome">
                {participante.nome}{participante.id === euId ? " (você)" : ""}
              </div>
              <div className="modal-stats">
                {totalPts} pts · {totalExatos} exato{totalExatos !== 1 ? "s" : ""} · {totalResultados} resultado{totalResultados !== 1 ? "s" : ""}
                {modalTemAoVivo && <> · <SeloParcial /></>}
              </div>
            </div>
          </div>
          <button className="apagar" onClick={onFechar} aria-label="Fechar">✕</button>
        </div>

        {encerrados.length === 0 && <Vazio texto="Nenhum jogo com placar ainda." />}

        {participante.acertouCampeao && (
          <div className="modal-jogo modal-jogo-exato">
            <div className="modal-jogo-times">🏆 Acertou a campeã</div>
            <div className="modal-jogo-direita"><span className="pts pts-3">+{BONUS_CAMPEAO}</span></div>
          </div>
        )}
        {participante.acertouArtilheiro && (
          <div className="modal-jogo modal-jogo-exato">
            <div className="modal-jogo-times">⚽ Acertou o artilheiro</div>
            <div className="modal-jogo-direita"><span className="pts pts-3">+{BONUS_ARTILHEIRO}</span></div>
          </div>
        )}

        {encerrados.map((m, i) => {
          const palpite = palpitesMap[m.id]?.[participante.id];
          const pts = pontosDoPalpite(palpite, m);
          const peso = pesoDoJogo(m);
          const cls = "modal-jogo"
            + (pts === PTS_EXATO ? " modal-jogo-exato" : "")
            + (pts === PTS_RESULTADO ? " modal-jogo-ok" : "")
            + (pts === 0 ? " modal-jogo-miss" : "");
          return (
            <div key={m.id} className={cls} style={{ "--i": Math.min(i, 14) }}>
              <div className="modal-jogo-times">
                {fl(m.casa)}{m.casa}
                <span className="modal-placar-final">{m.gh}–{m.ga}</span>
                {fl(m.fora)}{m.fora}
                {peso > 1 && (
                  <span className={"modal-jogo-peso" + (rotuloDoPeso(peso)?.destaque ? " modal-jogo-peso-final" : "")}>{peso}×</span>
                )}
              </div>
              <div className="modal-jogo-direita">
                {palpite
                  ? <span className="modal-palpite">{palpite.h}–{palpite.a}</span>
                  : <span className="modal-sem-palpite">sem palpite</span>
                }
                {pts === PTS_EXATO    && <span className="pts pts-3">🎯</span>}
                {pts === PTS_RESULTADO && <span className="pts pts-1">✓</span>}
                {pts === 0            && <span className="pts pts-0">✕</span>}
                {pts === null         && <span className="pts pts-0">—</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ================= CAMPEÃO DO BOLÃO ================= */
/* Destaque no topo do Ranking quando o bolão termina (campeã + artilheiro
   confirmados) — abre o modal de celebração. Some sozinho antes disso. */
function BannerCampeaoBolao({ campeoes, onAbrir }) {
  if (!campeoes || campeoes.length === 0) return null;
  return (
    <button className="banner-campeao-bolao entra-2" onClick={onAbrir}>
      <span className="banner-campeao-emoji" aria-hidden="true">🏆</span>
      <span className="banner-campeao-txt">
        {campeoes.length > 1
          ? `${campeoes.length} campeões empatados no bolão!`
          : `${campeoes[0].nome} é o campeão do bolão!`}
      </span>
      <span className="banner-campeao-cta">Ver celebração →</span>
    </button>
  );
}

/* Gráfico de linha de UM participante só (SVG feito na mão) — não confundir
   com GraficoEvolucao (comparação de todo mundo, no fim do Ranking). Este é
   focado: a trajetória individual do campeão até o topo. Pontos dourados
   marcam placar exato; a linha nunca cai (acumulado é não-decrescente —
   ver calcularEvolucao). */
function GraficoTrajetoria({ evolucao }) {
  if (evolucao.length < 2) return null;
  const w = 300, h = 90, pad = 6;
  const max = Math.max(1, evolucao[evolucao.length - 1].acumulado);
  const pontos = evolucao.map((e, i) => ({
    ...e,
    x: (i / (evolucao.length - 1)) * (w - pad * 2) + pad,
    y: h - pad - (e.acumulado / max) * (h - pad * 2),
  }));
  const linha = pontos.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area = `${pad},${h - pad} ${linha} ${w - pad},${h - pad}`;
  return (
    <svg className="grafico-trajetoria" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"
      role="img" aria-label="Evolução de pontos ao longo da Copa">
      <defs>
        <linearGradient id="gradEvolucao" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--ambar)" stopOpacity=".35" />
          <stop offset="100%" stopColor="var(--ambar)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#gradEvolucao)" />
      <polyline points={linha} fill="none" stroke="var(--ambar)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {pontos.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={p.pts === PTS_EXATO ? 3 : 1.5}
          fill={p.pts === PTS_EXATO ? "var(--ambar)" : "rgba(255,255,255,.45)"} />
      ))}
    </svg>
  );
}

/* Modal de celebração — abre pelo banner do Ranking. Um cartão por campeão
   (normalmente 1; empate real no topo vira uma lista, sem tratamento
   especial: cada um ganha seu próprio cartão com stats e gráfico). */
/* Confete PRÓPRIO do cartão do campeão — diferente do <Confete/> (que cai na
   tela inteira, feito pro Ranking). Esse fica CONTIDO no cartão (top/left em
   %, não em vh) e usa uma paleta dourada/creme — combina com a "placa de
   troféu", em vez do arco-íris genérico da comemoração de gol. */
function ConfeteCampeao() {
  const [pecas] = useState(() =>
    Array.from({ length: 26 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 1.1,
      dur: 2.4 + Math.random() * 1.6,
      cor: ["#ffc53d", "#fff3cf", "#ffe08a", "#4ade80", "#ffffff"][i % 5],
      w: 5 + Math.floor(Math.random() * 6),
    }))
  );
  return (
    <div className="campeao-bolao-confete" aria-hidden="true">
      {pecas.map((p) => (
        <div
          key={p.id}
          className="campeao-bolao-confete-peca"
          style={{
            left: `${p.left}%`,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
            background: p.cor,
            width: `${p.w}px`,
            height: `${Math.round(p.w * 0.45)}px`,
          }}
        />
      ))}
    </div>
  );
}

/* Um cartão por campeão — "placa de troféu": holofote + coroa + avatar em
   destaque no topo (cerimônia, centralizado), e uma placa única com os dados
   embaixo (fatos, alinhado à esquerda, linhas com divisória — nada de
   cartões soltos espalhados). */
function ModalCampeaoBolao({ campeoes, estado, palpitesMap, euId, onFechar }) {
  return (
    <div className="modal-overlay" onClick={onFechar}>
      <div className="modal-painel modal-campeao-bolao" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-nome">Campeão do Bolão</div>
          <button className="apagar" onClick={onFechar} aria-label="Fechar">✕</button>
        </div>

        {campeoes.map((c) => {
          const d = calcularDetalhamento(c.id, estado, palpitesMap);
          const evolucao = calcularEvolucao(c.id, estado, palpitesMap);
          return (
            <div key={c.id} className="campeao-bolao-cartao">
              <ConfeteCampeao />
              <div className="campeao-bolao-topo">
                <span className="campeao-bolao-coroa" aria-hidden="true">👑</span>
                <span className="campeao-bolao-anel">
                  <Avatar nome={c.nome} emoji={c.avatarEmoji} cor={c.avatarCor} size={72} />
                </span>
                <span className="campeao-bolao-eyebrow">CAMPEÃO DO BOLÃO</span>
                <div className="campeao-bolao-nome">{c.nome}{c.id === euId ? " (você)" : ""}</div>
                <div className="campeao-bolao-pts">1º lugar · {c.pontos} pts</div>
              </div>

              <div className="campeao-bolao-placa">
                {c.acertouCampeao && (
                  <div className="campeao-bolao-linha">
                    <span>🏆 Acertou a campeã</span>
                    <span className="campeao-bolao-linha-pts">+{BONUS_CAMPEAO} pts</span>
                  </div>
                )}
                {c.acertouArtilheiro && (
                  <div className="campeao-bolao-linha">
                    <span>⚽ Acertou o artilheiro</span>
                    <span className="campeao-bolao-linha-pts">+{BONUS_ARTILHEIRO} pts</span>
                  </div>
                )}

                <div className="campeao-bolao-linha campeao-bolao-linha-breakdown">
                  <span className="perfil-bd-item perfil-bd-exato">🎯 {d.acertosExatos} exato{d.acertosExatos !== 1 ? "s" : ""}</span>
                  <span className="perfil-bd-item perfil-bd-result">✓ {d.acertosResult} certo{d.acertosResult !== 1 ? "s" : ""}</span>
                  <span className="perfil-bd-item perfil-bd-erro">✗ {d.erros} erro{d.erros !== 1 ? "s" : ""}</span>
                  <span className="perfil-bd-item perfil-bd-miss">{d.aproveitamento}% aproveito</span>
                </div>

                {evolucao.length > 1 && (
                  <div className="campeao-bolao-linha campeao-bolao-linha-grafico">
                    <div className="campeao-bolao-secao-titulo">EVOLUÇÃO NA COPA</div>
                    <GraficoTrajetoria evolucao={evolucao} />
                  </div>
                )}

                {d.melhor && (
                  <div className="campeao-bolao-linha">
                    <span>🎯 Melhor jogo: {d.melhor.jogo.casa} × {d.melhor.jogo.fora}</span>
                    <span className="campeao-bolao-linha-pts">{d.melhor.ptsPeso} pt{d.melhor.ptsPeso !== 1 ? "s" : ""}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Vazio({ texto }) {
  return (
    <div className="vazio">
      <span className="bola-quica" aria-hidden="true">⚽</span>
      <span>{texto}</span>
    </div>
  );
}

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
  // spec §8: quem nunca palpitou vê só capa + final (sem card "0 vezes")
  if (m.apostasFeitas > 0) slides.push({ tipo: "cravadas" });
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

/* ================= ESTILO ================= */
function Estilo() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;800&family=IBM+Plex+Mono:wght@500;700&display=swap');

      /* variáveis no :root também — modais via portal (document.body) ficam fora
         do .bolao-root e precisam resolver as cores igual. */
      :root {
        --grama: #071a0e;
        --grama2: #0b2a17;
        --linha: rgba(255,255,255,.28);
        --giz: #f2f6ef;
        --ambar: #ffc53d;
        --ambar-escuro: #1a1408;
        --erro: #ff7b6b;
        --t: .22s cubic-bezier(.2,.7,.3,1);
        --r: 6px;
      }

      .bolao-root {
        --grama: #071a0e;
        --grama2: #0b2a17;
        --linha: rgba(255,255,255,.28);
        --giz: #f2f6ef;
        --ambar: #ffc53d;
        --ambar-escuro: #1a1408;
        --erro: #ff7b6b;
        --t: .22s cubic-bezier(.2,.7,.3,1);
        --r: 6px;
        min-height: 100vh;
        background-color: #071a0e;
        background-image:
          radial-gradient(ellipse 110% 55% at 50% 48%, rgba(18,72,38,0.7) 0%, transparent 68%),
          url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 68 105'%3E%3Cg stroke='white' stroke-width='0.6' fill='none' opacity='0.13'%3E%3Crect x='1' y='1' width='66' height='103'/%3E%3Cline x1='1' y1='52.5' x2='67' y2='52.5'/%3E%3Ccircle cx='34' cy='52.5' r='9.15'/%3E%3Ccircle cx='34' cy='52.5' r='0.8' fill='white'/%3E%3Crect x='13.84' y='1' width='40.32' height='16.5'/%3E%3Crect x='13.84' y='87.5' width='40.32' height='16.5'/%3E%3Crect x='24.84' y='1' width='18.32' height='5.5'/%3E%3Crect x='24.84' y='98' width='18.32' height='5.5'/%3E%3Ccircle cx='34' cy='12' r='0.8' fill='white'/%3E%3Ccircle cx='34' cy='93' r='0.8' fill='white'/%3E%3Cpath d='M27 17.5 A9.15 9.15 0 0 1 41 17.5'/%3E%3Cpath d='M27 87.5 A9.15 9.15 0 0 0 41 87.5'/%3E%3Cpath d='M1 4 A3 3 0 0 1 4 1'/%3E%3Cpath d='M64 1 A3 3 0 0 1 67 4'/%3E%3Cpath d='M67 101 A3 3 0 0 1 64 104'/%3E%3Cpath d='M4 104 A3 3 0 0 1 1 101'/%3E%3C/g%3E%3C/svg%3E");
        background-size: auto, 100%;
        background-position: center, center top;
        background-repeat: no-repeat, no-repeat;
        color: var(--giz);
        font-family: 'Barlow Condensed', 'Arial Narrow', system-ui, sans-serif;
        padding: 28px 16px 64px;
        max-width: 680px;
        margin: 0 auto;
        box-sizing: border-box;
        color-scheme: dark;
        position: relative;
      }
      .bolao-root *, .bolao-root *::before, .bolao-root *::after { box-sizing: border-box; }

      .bolao-root::before {
        content: '';
        position: fixed; inset: 0; pointer-events: none;
        background: radial-gradient(ellipse 120% 60% at 50% -12%, rgba(255,255,255,.12), transparent 60%);
      }

      @keyframes sobe { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
      .entra-1 { animation: sobe .55s var(--t) both; }
      .entra-2 { animation: sobe .55s var(--t) .12s both; }
      .conteudo-aba { animation: sobe .4s var(--t) both; }
      .entra-3 { animation: sobe .55s var(--t) .3s both; }
      .entra-cartao { animation: sobe .45s var(--t) both; animation-delay: calc(var(--i, 0) * 50ms); }

      .topo {
        text-align: center; margin-bottom: 28px;
        padding: 8px 0 0;
      }
      .topo-acoes {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 28px;
      }
      .topo-eyebrow {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; letter-spacing: .22em; text-transform: uppercase;
        color: rgba(255,255,255,.38); margin-bottom: 4px;
      }
      .topo-encerrada { color: var(--ambar, #ffc53d); font-weight: 700; }
      .topo-titulo {
        margin: 0; font-weight: 800;
        font-size: clamp(36px, 10vw, 72px);
        letter-spacing: .04em; line-height: 1;
        text-shadow: 0 4px 0 rgba(0,0,0,.45), 0 0 40px rgba(255,197,61,.12);
      }
      .topo-divider {
        width: 48px; height: 2px;
        background: var(--ambar);
        margin: 14px auto 12px;
        opacity: .7;
      }
      .topo-stats {
        display: flex; align-items: center; justify-content: center; gap: 8px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px; letter-spacing: .12em; text-transform: uppercase;
        color: var(--ambar);
      }
      .topo-stats-sep { opacity: .35; }
      .prox-jogo {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        padding: 9px 14px; margin-bottom: 10px;
        background: rgba(0,0,0,.28); border: 1px solid rgba(255,255,255,.18);
        animation: sobe .4s var(--t) .15s both;
      }
      .prox-jogo-vivo { border-color: var(--erro); background: rgba(255,123,107,.07); }
      .prox-vivo-dot {
        width: 8px; height: 8px; border-radius: 50%; background: var(--erro); flex: none;
        animation: pulsa-cd .85s ease-in-out infinite;
      }
      .prox-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 700;
        letter-spacing: .14em; color: var(--ambar); flex: none;
      }
      .prox-jogo-vivo .prox-label { color: var(--erro); }
      .prox-times { font-size: 17px; font-weight: 800; letter-spacing: .03em; flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
      .prox-tempo {
        font-family: 'IBM Plex Mono', monospace; font-size: 12px; font-weight: 700;
        color: var(--ambar); flex: none; margin-left: auto;
      }
      .prox-fechar {
        flex: none; background: transparent; border: none; cursor: pointer;
        color: var(--giz); opacity: .45; font-size: 13px; padding: 0 2px; line-height: 1;
        transition: opacity var(--t);
      }
      .prox-fechar:hover { opacity: 1; }

      .abas { display: flex; gap: 0; border: 2px solid var(--linha); border-radius: var(--r); overflow: hidden; margin-bottom: 18px; background: rgba(0,0,0,.18); }

      /* sub-abas internas (ex.: Campeão | Artilheiro): controle segmentado em pílula */
      .segmento {
        display: flex; gap: 4px; margin-bottom: 16px;
        background: rgba(0,0,0,.3); border: 1px solid rgba(255,255,255,.1);
        border-radius: 999px; padding: 4px;
      }
      .segmento-btn {
        flex: 1; padding: 9px 12px; border: none; cursor: pointer;
        background: transparent; color: var(--giz); border-radius: 999px;
        font: 700 13px 'Barlow Condensed', sans-serif; letter-spacing: .06em; text-transform: uppercase;
        transition: background-color var(--t), color var(--t), box-shadow var(--t);
      }
      .segmento-btn:hover:not(.segmento-btn-ativo) { background: rgba(255,255,255,.06); }
      .segmento-btn-ativo {
        background: var(--ambar); color: var(--ambar-escuro); font-weight: 800;
        box-shadow: 0 1px 6px rgba(255,197,61,.25);
      }
      .segmento-btn:focus-visible { outline: 3px solid var(--ambar); outline-offset: 2px; }

      /* card "o que está em jogo" (aba Galera) */
      .premio-card {
        text-align: center; margin-bottom: 16px;
        border: 2px solid rgba(255,197,61,.45); border-radius: var(--r);
        background: linear-gradient(180deg, rgba(255,197,61,.12), rgba(255,197,61,.03));
        padding: 18px 16px;
      }
      .premio-eyebrow {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px;
        letter-spacing: .18em; color: var(--ambar); margin-bottom: 6px;
      }
      .premio-valor {
        font-family: 'IBM Plex Mono', monospace; font-weight: 700; font-size: 44px;
        color: var(--ambar); text-shadow: 0 0 16px rgba(255,197,61,.45); line-height: 1;
      }
      .premio-sub {
        font-size: 14px; color: var(--giz); opacity: .9;
        margin-top: 8px; letter-spacing: .02em;
      }
      .aba {
        flex: 1; padding: 10px 4px; background: transparent; color: var(--giz);
        border: none; border-right: 2px solid var(--linha);
        font: 600 16px 'Barlow Condensed', sans-serif; letter-spacing: .08em;
        text-transform: uppercase; cursor: pointer;
        transition: background-color var(--t), color var(--t), box-shadow var(--t);
      }
      .aba:last-child { border-right: none; }
      .aba:hover:not(.ativa) { background: rgba(255,255,255,.07); }
      .aba.ativa {
        background: var(--ambar); color: var(--ambar-escuro); font-weight: 800;
        box-shadow: inset 0 -3px 0 rgba(0,0,0,.22);
      }
      .aba:focus-visible { outline: 3px solid var(--ambar); outline-offset: -3px; }

      .cartao {
        border: 2px solid var(--linha);
        border-radius: var(--r);
        background: rgba(0,0,0,.22);
        padding: 12px 14px; margin-bottom: 10px;
        transition: border-color var(--t), transform var(--t), background-color var(--t), box-shadow var(--t);
      }
      .cartao:hover { border-color: rgba(255,255,255,.5); box-shadow: 0 4px 16px rgba(0,0,0,.28); }
      @media (prefers-reduced-motion: reduce) { .cartao:hover { box-shadow: none; } }
      .meu-palpite { border-color: var(--ambar); background: rgba(255,197,61,.07); }

      .secao-titulo {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px;
        letter-spacing: .14em; color: var(--ambar);
        margin: 16px 0 8px;
      }

      .form-linha { display: flex; gap: 8px; align-items: center; }
      .form-jogo .form-linha + .form-linha { margin-top: 8px; }
      .check-admin {
        display: flex; align-items: center; gap: 8px; margin-top: 8px;
        font-size: 14px; letter-spacing: .03em; opacity: .85; cursor: pointer;
      }
      .check-admin input { width: auto; }

      input, .seletor {
        width: 100%; min-width: 0;
        background: rgba(0,0,0,.35); color: var(--giz);
        border: 2px solid var(--linha); border-radius: calc(var(--r) - 2px); padding: 9px 10px;
        font: 600 16px 'Barlow Condensed', sans-serif; letter-spacing: .03em;
        transition: border-color var(--t), box-shadow var(--t), opacity var(--t);
      }
      /* input que serve de "busca" colado numa lista de resultados: arredonda só o topo */
      input:has(+ .lista-campeao) { border-radius: calc(var(--r) - 2px) calc(var(--r) - 2px) 0 0; }
      input::placeholder { color: rgba(242,246,239,.45); }
      input:hover:not(:disabled), .seletor:hover { border-color: rgba(255,255,255,.45); }
      input:focus, .seletor:focus { border-color: var(--ambar); box-shadow: 0 0 0 3px rgba(255,197,61,.22); outline: none; }
      input:disabled { opacity: .45; cursor: not-allowed; }
      input:focus-visible, .seletor:focus-visible, .botao:focus-visible,
      .apagar:focus-visible, .botao-fantasma:focus-visible, .aba:focus-visible {
        outline: 3px solid var(--ambar); outline-offset: 1px;
      }
      input[type="number"] {
        width: 58px; text-align: center;
        font-family: 'IBM Plex Mono', monospace; font-weight: 700; font-size: 17px;
        -moz-appearance: textfield;
      }
      input[type="number"]::-webkit-outer-spin-button,
      input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      input[type="datetime-local"] {
        font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 500;
      }

      .seletor { margin-bottom: 12px; cursor: pointer; }

      .lista-campeao {
        max-height: 230px; overflow-y: auto;
        border: 2px solid var(--linha); border-top: none;
        border-radius: 0 0 var(--r) var(--r);
        background: rgba(0,0,0,.28);
        scrollbar-width: thin; scrollbar-color: var(--linha) transparent;
        margin-bottom: 0;
      }
      .lista-campeao::-webkit-scrollbar { width: 5px; }
      .lista-campeao::-webkit-scrollbar-track { background: transparent; }
      .lista-campeao::-webkit-scrollbar-thumb { background: var(--linha); border-radius: 3px; }

      .campeao-item {
        display: flex; align-items: center; gap: 8px;
        width: 100%; padding: 10px 14px;
        border: none; border-bottom: 1px solid rgba(255,255,255,.06);
        background: transparent; color: var(--giz); text-align: left;
        cursor: pointer; font: 600 16px 'Barlow Condensed', sans-serif;
        letter-spacing: .04em; transition: background-color var(--t);
      }
      .campeao-item:last-child { border-bottom: none; }
      .campeao-item:hover:not(:disabled):not(.campeao-item-ativo) { background: rgba(255,255,255,.06); }
      .campeao-item:disabled { cursor: wait; }
      .campeao-item-ativo {
        background: rgba(255,197,61,.13);
        border-left: 3px solid var(--ambar);
        color: var(--ambar); font-weight: 800;
      }
      .campeao-item-nome { flex: 1; }
      .campeao-vazio {
        padding: 12px 14px; margin: 0;
        font-family: 'IBM Plex Mono', monospace; font-size: 12px; opacity: .5;
      }

      .seletor-jogos {
        overflow: hidden; /* sem rolagem própria: a página rola normal (mobile) */
        border: 2px solid var(--linha);
        border-radius: var(--r);
        margin-bottom: 14px;
        background: rgba(0,0,0,.22);
      }
      .seletor-jogos::-webkit-scrollbar { width: 6px; }
      .seletor-jogos::-webkit-scrollbar-track { background: transparent; }
      .seletor-jogos::-webkit-scrollbar-thumb { background: var(--linha); border-radius: 3px; }

      .seletor-jogo {
        display: flex; align-items: center; gap: 9px;
        width: 100%; padding: 9px 12px;
        border: none; border-bottom: 1px solid rgba(255,255,255,.07);
        background: transparent; color: var(--giz); text-align: left;
        cursor: pointer; font: 600 15px 'Barlow Condensed', sans-serif;
        letter-spacing: .03em; transition: background-color var(--t);
      }
      .seletor-jogo:last-child { border-bottom: none; }
      .seletor-jogo:hover:not(.sj-ativo) { background: rgba(255,255,255,.05); }
      .seletor-jogo:focus-visible { outline: 2px solid var(--ambar); outline-offset: -2px; }

      .sj-ativo { background: rgba(255,197,61,.1); border-left: 3px solid var(--ambar) !important; }

      .sj-dot {
        width: 8px; height: 8px; border-radius: 50%; flex: none;
        transition: background-color var(--t);
      }
      .sj-aberto .sj-dot { background: #7ee2a0; box-shadow: 0 0 6px rgba(126,226,160,.5); }
      .sj-trav   .sj-dot { background: var(--ambar); box-shadow: 0 0 6px rgba(255,197,61,.4); }
      .sj-enc    .sj-dot { background: rgba(255,255,255,.25); }
      .sj-enc { opacity: .65; }

      .sj-nome { flex: 1; }
      .sj-quando {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px; opacity: .6; white-space: nowrap; flex-shrink: 0;
      }
      .sj-placar {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 13px; font-weight: 700;
        color: var(--ambar); white-space: nowrap; flex-shrink: 0;
      }

      .botao {
        background: var(--ambar); color: var(--ambar-escuro);
        border: none; border-radius: var(--r); padding: 10px 18px; cursor: pointer;
        font: 800 15px 'Barlow Condensed', sans-serif;
        letter-spacing: .08em; text-transform: uppercase; white-space: nowrap;
        transition: transform var(--t), box-shadow var(--t), filter var(--t), opacity var(--t);
        box-shadow: 0 2px 0 rgba(0,0,0,.3);
      }
      .botao:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); box-shadow: 0 3px 0 rgba(0,0,0,.3); }
      .botao:active:not(:disabled) { transform: translateY(1px) scale(.99); box-shadow: 0 0 0 rgba(0,0,0,.3); }
      .botao:disabled { opacity: .55; cursor: wait; }
      .botao-largo { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 12px; font-size: 16px; }
      .linha-botoes { display: flex; gap: 8px; margin-bottom: 10px; }

      .spinner {
        width: 14px; height: 14px; border-radius: 50%;
        border: 2.5px solid rgba(26,20,8,.3); border-top-color: var(--ambar-escuro);
        animation: gira .7s linear infinite; flex: none;
      }
      @keyframes gira { to { transform: rotate(360deg); } }

      .botao-fantasma {
        background: transparent; color: var(--ambar);
        border: 2px solid var(--ambar); border-radius: var(--r); padding: 6px 12px; cursor: pointer;
        font: 700 13px 'Barlow Condensed', sans-serif;
        letter-spacing: .06em; text-transform: uppercase; white-space: nowrap;
        transition: background-color var(--t), transform var(--t);
      }
      .botao-fantasma:hover { background: rgba(255,197,61,.12); transform: translateY(-1px); }
      .botao-fantasma:active { transform: none; }

      .seletor-jogo:active:not(.sj-ativo) { background: rgba(255,255,255,.09); }

      /* ===== Linha de jogo estilo SofaScore (aba Palpites) =====
         3 colunas: status (hora + estado) | times empilhados | placar empilhado.
         Estados de ao vivo / aguardando / encerrado reusam as MESMAS cores e o
         pontinho pulsante (--erro / --ambar / pulsa-cd) da aba Jogos. */
      .sj-sofa {
        display: grid; grid-template-columns: 52px 1fr auto;
        align-items: center; gap: 10px; padding: 9px 12px;
      }
      .sj-status {
        display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
        font-family: 'IBM Plex Mono', monospace; line-height: 1.15;
      }
      .sj-hora { font-size: 12px; color: rgba(242,246,239,.55); }
      .sj-estado {
        display: inline-flex; align-items: center; gap: 4px;
        font-size: 9px; letter-spacing: .07em; text-transform: uppercase;
      }
      .sj-st-vivo .sj-estado { color: var(--erro); }
      .sj-st-aguard .sj-estado { color: var(--ambar); opacity: .9; }
      .sj-st-fim .sj-estado { color: rgba(242,246,239,.4); }
      .sj-st-aguard .placar-vivo-dot { background: var(--ambar); }

      .sj-times {
        display: flex; flex-direction: column; gap: 5px; min-width: 0;
      }
      .sj-time {
        font: 700 15px 'Barlow Condensed', sans-serif; letter-spacing: .02em;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .sj-perdeu { opacity: .5; font-weight: 600; }

      .sj-gols {
        display: flex; flex-direction: column; gap: 5px; align-items: center;
        min-width: 16px; text-align: center;
        font-family: 'IBM Plex Mono', monospace; font-weight: 700; font-size: 16px;
        color: rgba(242,246,239,.28);
      }
      .sj-gols .sj-g { line-height: 1; }
      .sj-st-fim .sj-gols { color: var(--ambar); text-shadow: 0 0 8px rgba(255,197,61,.4); }
      .sj-st-vivo .sj-gols { color: var(--erro); }
      .sj-st-aguard .sj-gols { color: var(--ambar); opacity: .85; }
      .sj-gols .sj-g.sj-perdeu { color: rgba(242,246,239,.45); text-shadow: none; opacity: 1; }

      .apagar {
        background: transparent; color: var(--erro);
        border: 2px solid transparent; border-radius: var(--r); cursor: pointer;
        font-size: 15px; padding: 4px 8px;
        transition: border-color var(--t), transform var(--t); opacity: .75;
      }
      .apagar:hover { border-color: var(--erro); opacity: 1; transform: scale(1.06); }

      .encerrar-jogo {
        background: transparent; color: #ffc53d;
        border: 1px solid rgba(255,197,61,.45); border-radius: 6px; cursor: pointer;
        font-family: 'IBM Plex Mono', monospace; font-size: 11px; font-weight: 700;
        padding: 4px 8px; white-space: nowrap;
        transition: background var(--t), border-color var(--t);
      }
      .encerrar-jogo:hover:not(:disabled) { background: rgba(255,197,61,.12); border-color: #ffc53d; }
      .encerrar-jogo:disabled { opacity: .4; cursor: not-allowed; }

      .badge-pago, .badge-pendente {
        font-family: 'IBM Plex Mono', monospace; font-size: 11px; font-weight: 700;
        padding: 3px 8px; border-radius: 4px; white-space: nowrap;
      }
      .badge-pago { background: #14532d; color: #86efac; }
      .badge-pendente { background: #451a03; color: #fcd34d; }
      .badge-btn {
        border: none; cursor: pointer;
        transition: opacity var(--t), transform var(--t);
      }
      .badge-btn:hover { opacity: .8; transform: scale(1.05); }
      .badge-btn:disabled { opacity: .5; cursor: default; transform: none; }

      .resumo-pagamento {
        background: #1a1a1a; border: 1px solid #333; border-radius: 8px;
        padding: 10px 14px; margin-bottom: 8px;
      }
      .resumo-pagamento-txt { font-size: 13px; color: #ccc; }

      .timer-pagamento {
        background: linear-gradient(135deg, #1a0a00, #2a1200);
        border: 1px solid #92400e; border-radius: 10px;
        padding: 12px 16px; margin-bottom: 12px;
        display: flex; flex-direction: column; align-items: center; gap: 6px;
      }
      .timer-label { font-size: 11px; font-weight: 700; letter-spacing: .08em; color: #fbbf24; text-transform: uppercase; }
      .timer-display { display: flex; align-items: center; gap: 4px; }
      .timer-bloco { display: flex; align-items: baseline; gap: 1px; }
      .timer-num {
        font-family: 'IBM Plex Mono', monospace; font-size: 28px; font-weight: 700;
        color: #fcd34d; line-height: 1;
      }
      .timer-unidade { font-size: 11px; color: #d97706; font-weight: 600; }
      .timer-sep { font-family: 'IBM Plex Mono', monospace; font-size: 22px; color: #92400e; font-weight: 700; padding: 0 2px; }
      .timer-data { font-size: 11px; color: #78350f; }

      .modal-pagamento { max-width: 340px; }
      .pagamento-corpo {
        display: flex; flex-direction: column; align-items: center;
        gap: 18px; padding: 4px 0 8px;
      }
      .pagamento-aviso { text-align: center; font-size: 14px; color: #ccc; line-height: 1.5; margin: 0; }

      /* lista de jogos sem palpite (modal lembrete) */
      .lembrete-lista { display: flex; flex-direction: column; gap: 8px; width: 100%; }
      .lembrete-jogo {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 10px 12px; border: 1px solid var(--linha); border-radius: var(--r);
        background: rgba(0,0,0,.25);
      }
      .lembrete-jogo-times { font-weight: 700; font-size: 15px; letter-spacing: .02em; }
      .lembrete-jogo-hora {
        font-family: 'IBM Plex Mono', monospace; font-size: 11px;
        color: rgba(242,246,239,.55); white-space: nowrap; flex-shrink: 0;
      }
      .pagamento-valor {
        font-family: 'IBM Plex Mono', monospace; font-size: 42px; font-weight: 700;
        color: #4ade80; letter-spacing: -.02em;
      }
      .pagamento-pix-bloco {
        width: 100%; background: #111; border: 1px solid #333;
        border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
      }
      .pagamento-pix-label { font-size: 10px; font-weight: 700; letter-spacing: .08em; color: #888; text-transform: uppercase; }
      .pagamento-pix-linha { display: flex; align-items: center; gap: 10px; }
      .pagamento-pix-chave {
        font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: #e2e8f0; flex: 1;
        letter-spacing: .02em; min-width: 0; word-break: break-all; line-height: 1.4;
      }
      .pagamento-copiar { padding: 6px 12px; font-size: 13px; white-space: nowrap; }
      .pagamento-timer {
        width: 100%; background: linear-gradient(135deg, #1a0a00, #2a1200);
        border: 1px solid #92400e; border-radius: 10px;
        padding: 12px 16px; display: flex; flex-direction: column; align-items: center; gap: 6px;
      }
      .pagamento-fechar { width: 100%; justify-content: center; opacity: .6; font-size: 13px; }

      .vs { opacity: .6; font-weight: 800; }

      .grupo-data-header {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; letter-spacing: .16em; text-transform: uppercase;
        color: var(--ambar); padding: 16px 2px 6px;
        border-bottom: 1px solid rgba(255,197,61,.25);
        margin-bottom: 8px;
      }
      .grupo-data-header:first-child { padding-top: 4px; }

      .nav-data {
        display: flex; align-items: center;
        gap: 10px; margin-bottom: 14px;
      }
      /* navegador de datas: uma pílula única com setas dentro e label central */
      .nav-data-nav {
        flex: 1; min-width: 0;
        display: flex; align-items: center; gap: 4px;
        background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.1);
        border-radius: 999px; padding: 4px 6px;
      }
      .nav-data-seta {
        flex: none; width: 30px; height: 30px; border-radius: 50%;
        background: transparent; border: none;
        color: var(--ambar); cursor: pointer; font-size: 20px; line-height: 1;
        display: flex; align-items: center; justify-content: center;
        transition: background-color var(--t), opacity var(--t);
      }
      .nav-data-seta:hover:not(:disabled) { background: rgba(255,197,61,.14); }
      .nav-data-seta:disabled { opacity: .25; cursor: default; }
      .nav-data-label {
        flex: 1; text-align: center; min-width: 0;
        font-family: 'IBM Plex Mono', monospace; font-size: 12px; font-weight: 700;
        letter-spacing: .1em; text-transform: uppercase; color: var(--ambar);
        transition: opacity var(--t); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .nav-data-label-dim { opacity: .35; }
      /* "Ao vivo": pílula com contorno e texto vermelhos + aro */
      .nav-ao-vivo {
        flex: none; display: flex; align-items: center; gap: 7px;
        padding: 7px 14px; border-radius: 999px;
        background: rgba(0,0,0,.3); border: 1.5px solid rgba(255,123,107,.45);
        color: rgba(255,123,107,.9); cursor: pointer; white-space: nowrap;
        font: 700 12px 'IBM Plex Mono', monospace; letter-spacing: .06em; text-transform: uppercase;
        transition: border-color var(--t), background-color var(--t), color var(--t), box-shadow var(--t);
      }
      .nav-ao-vivo:hover { border-color: var(--erro); color: var(--erro); background: rgba(255,123,107,.08); }
      .nav-ao-vivo-ativo {
        background: rgba(255,123,107,.15); border-color: var(--erro);
        color: var(--erro); box-shadow: 0 0 12px rgba(255,123,107,.25);
      }
      .nav-vivo-anel {
        width: 13px; height: 13px; border-radius: 50%; flex: none;
        border: 2px solid currentColor; background: transparent;
        animation: pulsa-cd 1.1s ease-in-out infinite;
      }
      @media (prefers-reduced-motion: reduce) { .nav-vivo-anel { animation: none; } }
      .nav-sem-jogos {
        font-family: 'IBM Plex Mono', monospace; font-size: 12px; letter-spacing: .06em;
        color: rgba(255,255,255,.45); text-align: center;
        padding: 32px 16px; border: 2px dashed rgba(255,255,255,.12);
        margin-top: 4px;
      }

      .seletor-data-header {
        width: 100%; display: flex; align-items: center; justify-content: space-between;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
        color: var(--ambar); padding: 6px 12px 5px;
        background: rgba(0,0,0,.4);
        border: none; border-bottom: 1px solid rgba(255,197,61,.2);
        cursor: pointer;
      }
      .seletor-data-header:hover { background: rgba(255,197,61,.08); }
      .seletor-data-info { display: flex; align-items: center; gap: 7px; }
      .seletor-data-cnt {
        font-size: 9px; opacity: .65;
        background: rgba(255,197,61,.15); border-radius: 3px; padding: 1px 5px;
      }
      .seletor-data-chevron { font-size: 11px; opacity: .8; }
      .seletor-data-mae {
        color: var(--cinza, #9aa0a6);
        background: rgba(0,0,0,.55);
        border-top: 1px solid rgba(255,197,61,.12);
        border-bottom-color: rgba(255,255,255,.06);
      }
      .seletor-data-mae:hover { background: rgba(255,255,255,.05); }
      .seletor-data-mae .seletor-data-cnt {
        background: rgba(255,255,255,.1); opacity: .8;
      }

      .flag-img { display: inline-block; vertical-align: middle; border-radius: 2px; margin-right: 4px; box-shadow: 0 1px 3px rgba(0,0,0,.4); }

      .jogo { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      .jogo.encerrado { border-color: var(--ambar); }
      .jogo-info { flex: 1; min-width: 160px; }
      .jogo-times { font-size: 19px; font-weight: 800; letter-spacing: .03em; }
      .jogo-meta { display: flex; align-items: center; gap: 8px; margin-top: 3px; flex-wrap: wrap; }
      .jogo-quando { font-family: 'IBM Plex Mono', monospace; font-size: 11px; opacity: .7; }
      .jogo-resultado { display: flex; align-items: center; gap: 6px; }

      /* botão de estatísticas no card de jogo */
      .stat-btn {
        margin-top: 8px; align-self: flex-start;
        display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 11px; border-radius: 999px; cursor: pointer;
        background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.16);
        color: rgba(242,246,239,.8);
        font: 700 11px 'Barlow Condensed', sans-serif; letter-spacing: .06em; text-transform: uppercase;
        transition: border-color var(--t), background-color var(--t), color var(--t);
      }
      .stat-btn:hover { border-color: var(--ambar); color: var(--ambar); background: rgba(255,197,61,.08); }

      /* linha de ações do card de jogo (Palpitar + Estatísticas lado a lado) */
      .jogo-acoes { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      /* "Palpitar" é a ação principal → destaque âmbar preenchido */
      .stat-btn-palpitar { border-color: rgba(255,197,61,.5); color: var(--ambar); background: rgba(255,197,61,.12); }
      .stat-btn-palpitar:hover { border-color: var(--ambar); background: rgba(255,197,61,.2); }

      /* atalho da aba Palpites -> abre as estatísticas do jogo na aba Jogos */
      .stat-link {
        width: 100%; margin: 12px 0 4px;
        display: inline-flex; align-items: center; justify-content: center; gap: 7px;
        padding: 9px 14px; border-radius: var(--r); cursor: pointer;
        background: rgba(255,197,61,.07); border: 1px dashed rgba(255,197,61,.4);
        color: var(--ambar);
        font: 700 12px 'Barlow Condensed', sans-serif; letter-spacing: .05em; text-transform: uppercase;
        transition: border-color var(--t), background-color var(--t);
      }
      .stat-link:hover { border-color: var(--ambar); background: rgba(255,197,61,.13); }

      /* link externo de escalação no modal: mesmo visual do .stat-btn, só some o
         sublinhado do <a> e desencosta da data acima */
      .stat-btn-link { text-decoration: none; margin: 2px 0 14px; }

      /* modal de estatísticas: chances de ganhar */
      .stat-estimativa { font-size: 9px; color: rgba(242,246,239,.4); letter-spacing: .04em; text-transform: none; }
      .stat-equilibrio {
        margin: 2px 0 6px; padding: 7px 10px; border-radius: var(--r);
        background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.1);
        color: rgba(242,246,239,.72); font-size: 12px; text-align: center;
      }
      .stat-chances { display: flex; flex-direction: column; gap: 12px; margin-bottom: 6px; }
      .stat-chance-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 5px; }
      .stat-chance-nome { display: inline-flex; align-items: center; gap: 7px; font-weight: 700; font-size: 15px; }
      .stat-chance-pct { font-family: 'IBM Plex Mono', monospace; font-weight: 700; font-size: 15px; }
      .stat-pct-casa { color: var(--ambar); }
      .stat-pct-empate { color: rgba(242,246,239,.7); }
      .stat-pct-fora { color: #fb923c; }
      .stat-fav {
        font: 700 9px 'IBM Plex Mono', monospace; letter-spacing: .06em; text-transform: uppercase;
        background: rgba(126,226,160,.16); color: #7ee2a0; border-radius: 999px; padding: 2px 7px;
      }
      .stat-barra { height: 7px; border-radius: 999px; background: rgba(255,255,255,.08); overflow: hidden; }
      .stat-barra-fill { height: 100%; border-radius: 999px; transition: width var(--t); }
      .stat-fill-casa { background: var(--ambar); }
      .stat-fill-empate { background: rgba(242,246,239,.45); }
      .stat-fill-fora { background: #fb923c; }

      /* modal de estatísticas: tabela do grupo */
      .stat-data { text-align: center; font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: rgba(242,246,239,.55); margin: -4px 0 14px; }
      .stat-tabela-wrap { overflow-x: auto; margin-bottom: 4px; }
      .stat-tabela { width: 100%; border-collapse: collapse; font-family: 'IBM Plex Mono', monospace; font-size: 12px; }
      .stat-tabela th { font-size: 9px; letter-spacing: .06em; color: rgba(255,255,255,.4); font-weight: 700; padding: 6px 3px; text-align: center; text-transform: uppercase; }
      .stat-tabela th.stat-th-time { text-align: left; padding-left: 4px; }
      .stat-tabela td { padding: 9px 3px; text-align: center; border-top: 1px solid rgba(255,255,255,.07); color: var(--giz); }
      .stat-td-time { text-align: left !important; white-space: nowrap; padding-left: 4px !important; }
      .stat-pts { font-weight: 800; color: var(--ambar); }
      .stat-row-on { background: rgba(255,197,61,.08); }
      .stat-sg-pos { color: #7ee2a0; }
      .stat-sg-neg { color: var(--erro); }

      /* modal de estatísticas: forma / últimos jogos */
      .stat-forma-bloco {
        background: rgba(0,0,0,.25); border: 1px solid var(--linha); border-radius: var(--r);
        padding: 10px 12px; margin-bottom: 10px;
      }
      .stat-forma-time { display: flex; align-items: center; gap: 8px; font-weight: 800; font-size: 16px; margin-bottom: 8px; }
      .stat-forma-nome { display: inline-flex; align-items: center; min-width: 0; }
      .stat-forma-badges { display: inline-flex; gap: 4px; margin-left: auto; flex-shrink: 0; }
      .stat-badge {
        width: 19px; height: 19px; border-radius: 50%;
        display: inline-flex; align-items: center; justify-content: center;
        font: 700 10px 'IBM Plex Mono', monospace; color: #fff;
      }
      .stat-badge-V { background: #2f9e5e; }
      .stat-badge-E { background: #6b7280; }
      .stat-badge-D { background: #b54a3f; }
      .stat-forma-vazio { font-size: 12px; color: rgba(242,246,239,.45); font-weight: 400; }
      .stat-forma-linha { display: flex; align-items: center; gap: 12px; padding: 5px 0; font-size: 14px; }
      .stat-res { font-family: 'IBM Plex Mono', monospace; font-size: 11px; font-weight: 700; width: 60px; flex-shrink: 0; }
      .stat-res-V { color: #7ee2a0; }
      .stat-res-E { color: rgba(242,246,239,.6); }
      .stat-res-D { color: var(--erro); }
      .stat-forma-placar { display: inline-flex; align-items: center; gap: 6px; }

      .placar-final {
        font-family: 'IBM Plex Mono', monospace; font-weight: 700; font-size: 20px;
        color: var(--ambar); text-shadow: 0 0 10px rgba(255,197,61,.5);
        white-space: nowrap;
      }
      .placar-vivo {
        display: flex; align-items: center; gap: 6px;
        font-family: 'IBM Plex Mono', monospace; font-weight: 700; font-size: 20px;
        color: var(--erro); white-space: nowrap;
      }
      .placar-vivo-dot {
        width: 8px; height: 8px; border-radius: 50%; flex: none;
        background: var(--erro); animation: pulsa-cd .85s ease-in-out infinite;
      }
      /* jogo começou mas a API ainda não confirmou o placar: mostra "ao vivo"
         com placar a confirmar, em vez de o card parecer que não começou. */
      .placar-vivo-aguardando { color: var(--ambar); opacity: .85; letter-spacing: .08em; }
      .placar-vivo-aguardando .placar-vivo-dot { background: var(--ambar); }

      .reacao-strip { width: 100%; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.07); }
      .reacao-chip {
        display: flex; align-items: center; gap: 4px; padding: 3px 8px;
        background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12);
        border-radius: 20px; font-size: 14px; cursor: pointer; transition: background var(--t);
      }
      .reacao-chip:hover { background: rgba(255,255,255,.13); }
      .reacao-chip-minha { background: rgba(255,197,61,.15); border-color: rgba(255,197,61,.5); }
      .reacao-count { font-family: 'IBM Plex Mono', monospace; font-size: 11px; opacity: .8; }
      .reacao-add {
        width: 26px; height: 26px; border-radius: 50%; font-size: 14px; line-height: 1;
        background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12);
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        transition: background var(--t); color: rgba(255,255,255,.5);
      }
      .reacao-add:hover { background: rgba(255,255,255,.12); color: #fff; }
      .reacao-picker { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; max-width: 260px; }
      .reacao-picker-btn { font-size: 20px; background: none; border: none; cursor: pointer; padding: 2px 4px; border-radius: 6px; transition: transform .15s; }
      .reacao-picker-btn:hover { transform: scale(1.3); }
      .reacao-picker-fechar { font-size: 11px; color: rgba(255,255,255,.35); background: none; border: none; cursor: pointer; padding: 2px 6px; }

      .tag {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 700;
        letter-spacing: .06em; padding: 2px 6px; white-space: nowrap;
        border-radius: 4px;
        animation: pop .3s var(--t) both;
      }
      @keyframes pop { from { opacity: 0; transform: scale(.85); } to { opacity: 1; transform: none; } }
      .tag-pendente { border: 1.5px solid var(--erro); color: var(--erro); }
      .tag-ok { border: 1.5px solid rgba(255,255,255,.35); opacity: .8; }
      .tag-meu-palpite { border: 1.5px solid rgba(255,197,61,.4); color: var(--ambar); opacity: .9; }
      .tag-travado { background: var(--ambar); color: var(--ambar-escuro); }
      .tag-aguardando { border: 1.5px solid var(--ambar); color: var(--ambar); animation: piscaAguard 1.6s ease-in-out infinite; }
      @keyframes piscaAguard { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }

      .countdown {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 5px 8px; margin-top: 6px;
        font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: .05em;
        border-left: 3px solid; animation: sobe .3s var(--t) both;
      }
      .cd-ok      { border-color: rgba(255,255,255,.25); opacity: .7; }
      .cd-atencao { border-color: var(--ambar); color: var(--ambar); }
      .cd-alerta  { border-color: var(--ambar); color: var(--ambar); background: rgba(255,197,61,.07); padding: 6px 8px; }
      .cd-critico {
        border-color: var(--erro); color: var(--erro); background: rgba(255,123,107,.1); padding: 6px 8px;
        animation: pulsa-cd .85s ease-in-out infinite;
      }
      @keyframes pulsa-cd {
        0%, 100% { opacity: 1; }
        50%       { opacity: .55; }
      }
      .cd-msg   { flex: 1; }
      .cd-tempo { font-weight: 700; white-space: nowrap; }

      .trava-aviso {
        display: flex; align-items: center; justify-content: space-between;
        gap: 10px; flex-wrap: wrap;
        border: 2px solid var(--ambar); background: rgba(255,197,61,.1);
        padding: 10px 12px; margin-bottom: 12px;
        font-size: 15px; letter-spacing: .03em;
        animation: sobe .35s var(--t) both;
      }

      .palpite-linha { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
      .palpite-quando {
        flex-basis: 100%; width: 100%;
        font-family: 'IBM Plex Mono', monospace; font-size: 10px;
        letter-spacing: .04em; color: rgba(242,246,239,.42);
      }
      .palpite-nome { flex: 1; font-size: 18px; font-weight: 600; letter-spacing: .03em; display: flex; align-items: center; gap: 8px; overflow: hidden; min-width: 0; }
      /* ranking do artilheiro + seleção eliminada */
      .rank-pos { flex: none; min-width: 30px; text-align: center; font-family: 'IBM Plex Mono', monospace; font-weight: 800; font-size: 15px; color: rgba(242,246,239,.55); }
      .rank-pos-top { color: var(--ambar); }
      .rank-jogador { font-size: 12px; font-weight: 500; opacity: .6; font-family: 'IBM Plex Mono', monospace; }
      .card-eliminado { filter: grayscale(1); opacity: .5; }
      .tag-eliminada { flex: none; font: 700 10px 'Barlow Condensed', sans-serif; letter-spacing: .06em; text-transform: uppercase; color: var(--erro); border: 1px solid var(--erro); border-radius: 999px; padding: 2px 7px; white-space: nowrap; }
      .palpite-inputs { display: flex; align-items: center; gap: 6px; }
      .palpite-time-flag { display: flex; align-items: center; opacity: .75; line-height: 1; }
      .palpite-status {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px;
        letter-spacing: .06em; opacity: .7; white-space: nowrap;
      }
      .palpite-status.ok { color: #7ee2a0; opacity: 1; }
      .palpite-status.erro { color: var(--erro); opacity: 1; }

      .pts {
        font-family: 'IBM Plex Mono', monospace; font-size: 12px; font-weight: 700;
        padding: 3px 7px; margin-left: 6px; white-space: nowrap;
        animation: pop .35s var(--t) both;
      }
      .pts-3 { background: var(--ambar); color: var(--ambar-escuro); box-shadow: 0 0 14px rgba(255,197,61,.45); }
      .pts-1 { border: 1.5px solid var(--ambar); color: var(--ambar); }
      .pts-0 { border: 1.5px solid var(--linha); opacity: .6; }

      .placar {
        border: 3px solid var(--giz); background: rgba(0,0,0,.45);
        box-shadow: 0 10px 30px rgba(0,0,0,.35), inset 0 0 40px rgba(0,0,0,.4);
      }
      .placar-cab, .placar-linha {
        display: grid;
        grid-template-columns: 34px 1fr 64px 64px 72px;
        align-items: center; gap: 4px;
        padding: 10px 12px;
      }
      .placar-cab {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px;
        letter-spacing: .12em; color: var(--ambar);
        border-bottom: 2px solid var(--linha);
      }
      .placar-linha {
        border-bottom: 1px solid rgba(255,255,255,.12);
        font-size: 18px; font-weight: 600;
        animation: sobe .45s var(--t) both; animation-delay: calc(var(--i, 0) * 60ms);
        transition: background-color var(--t);
      }
      .placar-linha:hover { background: rgba(255,255,255,.05); }
      .placar-linha:last-child { border-bottom: none; }
      @keyframes respira-lider {
        0%, 100% { box-shadow: 0 0 10px rgba(255,197,61,.18), inset 0 0 12px rgba(255,197,61,.04); }
        50%       { box-shadow: 0 0 28px rgba(255,197,61,.45), inset 0 0 20px rgba(255,197,61,.09); }
      }
      .podio-ouro  {
        background: rgba(255,197,61,.18);
        border: 2px solid #ffc53d;
        box-shadow: 0 0 18px rgba(255,197,61,.28), inset 0 0 14px rgba(255,197,61,.06);
        animation: respira-lider 3s ease-in-out infinite;
      }
      .podio-prata { background: rgba(200,200,210,.08); border-left: 3px solid #b8b8cc; }
      .podio-bronze{ background: rgba(180,100,40,.08);  border-left: 3px solid #b87040; }
      .podio-ouro:hover  { background: rgba(255,197,61,.26) !important; }
      .podio-prata:hover { background: rgba(200,200,210,.14) !important; }
      .podio-bronze:hover{ background: rgba(180,100,40,.14) !important; }
      .col-pos-medal { font-size: 18px; opacity: 1; }

      /* banner "campeão do bolão" — só aparece quando o bolão termina */
      .banner-campeao-bolao {
        display: flex; align-items: center; gap: 10px;
        width: 100%; text-align: left; font-family: inherit; color: var(--giz);
        padding: 14px 16px; margin-bottom: 14px; cursor: pointer;
        background: linear-gradient(135deg, rgba(255,197,61,.2), rgba(255,197,61,.05));
        border: 1.5px solid var(--ambar); border-radius: var(--r);
        transition: background var(--t);
      }
      .banner-campeao-bolao:hover { background: linear-gradient(135deg, rgba(255,197,61,.3), rgba(255,197,61,.08)); }
      .banner-campeao-emoji { font-size: 26px; flex: none; }
      .banner-campeao-txt { flex: 1; min-width: 0; font-weight: 800; font-size: 15px; letter-spacing: .01em; }
      .banner-campeao-cta {
        flex: none; font-family: 'IBM Plex Mono', monospace; font-size: 10px;
        letter-spacing: .08em; text-transform: uppercase; color: var(--ambar); white-space: nowrap;
      }

      /* modal de celebração do campeão do bolão — "placa de troféu": topo de
         cerimônia (holofote, coroa, avatar — centralizado) + uma placa única
         de fatos embaixo (linhas com divisória, alinhada à esquerda). Nada de
         cartões soltos: é isso que fazia parecer disperso antes. */
      .campeao-bolao-cartao {
        position: relative; overflow: hidden; text-align: center;
        padding: 30px 18px 20px; margin-bottom: 14px;
        border-radius: calc(var(--r) + 6px);
        border: 1px solid rgba(255,197,61,.32);
        background:
          radial-gradient(ellipse 130% 65% at 50% -8%, rgba(255,197,61,.32), transparent 58%),
          radial-gradient(ellipse 90% 50% at 50% 12%, rgba(255,197,61,.1), transparent 70%),
          linear-gradient(180deg, #0d2415 0%, #071a0e 50%, #04100a 100%);
        box-shadow: 0 14px 46px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.05);
      }
      .campeao-bolao-confete { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; }
      @keyframes confete-campeao-cai {
        0%   { top: -6%;  transform: rotate(0deg)   scaleX(1);  opacity: 1; }
        55%  {            transform: rotate(280deg) scaleX(-1); opacity: 1; }
        100% { top: 104%; transform: rotate(560deg) scaleX(1);  opacity: 0; }
      }
      .campeao-bolao-confete-peca {
        position: absolute; top: -6%; border-radius: 1px;
        animation: confete-campeao-cai ease-in forwards;
      }
      .campeao-bolao-topo { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; }
      .campeao-bolao-topo::before {
        content: ""; position: absolute; top: -22px; left: 50%; width: 220px; height: 220px;
        transform: translate(-50%, 0);
        background: conic-gradient(from 0deg, rgba(255,197,61,.18) 0deg 10deg, transparent 10deg 30deg);
        border-radius: 50%; z-index: -1; opacity: .9;
        animation: campeao-holofote-girar 22s linear infinite;
      }
      @keyframes campeao-holofote-girar { to { transform: translate(-50%, 0) rotate(360deg); } }
      .campeao-bolao-coroa {
        font-size: 32px; display: block;
        animation: campeao-coroa-cai .6s cubic-bezier(.34,1.56,.64,1) both;
      }
      @keyframes campeao-coroa-cai {
        0%   { transform: translateY(-22px) scale(.4) rotate(-15deg); opacity: 0; }
        60%  { transform: translateY(3px) scale(1.15) rotate(6deg); opacity: 1; }
        100% { transform: translateY(0) scale(1) rotate(0deg); opacity: 1; }
      }
      .campeao-bolao-anel {
        display: inline-flex; padding: 5px; margin: 4px 0 8px; border-radius: 50%;
        background: radial-gradient(circle, rgba(255,197,61,.9), rgba(255,197,61,.18) 68%, transparent 72%);
        box-shadow: 0 0 30px 6px rgba(255,197,61,.35);
        animation: campeao-anel-surge .5s var(--t) .12s both;
      }
      @keyframes campeao-anel-surge { from { opacity: 0; transform: scale(.7); } to { opacity: 1; transform: scale(1); } }
      .campeao-bolao-eyebrow {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .3em;
        text-transform: uppercase; color: rgba(255,197,61,.8);
      }
      .campeao-bolao-nome {
        font-size: clamp(28px, 8vw, 40px); font-weight: 800; letter-spacing: .02em;
        line-height: 1.05; margin-top: 2px;
        text-shadow: 0 3px 0 rgba(0,0,0,.5), 0 0 30px rgba(255,197,61,.25);
      }
      .campeao-bolao-pts {
        font-family: 'IBM Plex Mono', monospace; font-size: 12px;
        color: var(--ambar); letter-spacing: .06em; margin-top: 2px;
      }

      .campeao-bolao-placa {
        position: relative; z-index: 1; text-align: left; margin-top: 20px;
        background: rgba(0,0,0,.24); border: 1px solid rgba(255,197,61,.2);
        border-radius: calc(var(--r) + 2px); overflow: hidden;
      }
      .campeao-bolao-linha {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 12px 16px; font-size: 13px; font-weight: 600;
        border-bottom: 1px solid rgba(255,255,255,.07);
      }
      .campeao-bolao-linha:last-child { border-bottom: none; }
      .campeao-bolao-linha-pts { font-family: 'IBM Plex Mono', monospace; font-weight: 700; color: var(--ambar); flex: none; }
      .campeao-bolao-linha-breakdown { flex-wrap: wrap; row-gap: 8px; }
      .campeao-bolao-linha-grafico { flex-direction: column; align-items: stretch; }
      .campeao-bolao-secao-titulo {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: .16em;
        color: rgba(255,197,61,.75); margin-bottom: 4px;
      }
      .grafico-trajetoria { width: 100%; height: 90px; display: block; }

      @media (prefers-reduced-motion: reduce) {
        .campeao-bolao-topo::before { animation: none; }
        .campeao-bolao-coroa, .campeao-bolao-anel { animation: none; }
        .campeao-bolao-confete-peca { animation: none; opacity: 0; }
      }

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

      /* painel "sua posição" — placar do próprio usuário */
      .meu-status {
        width: 100%; display: flex; align-items: center; justify-content: space-between;
        gap: 10px; margin: 0 0 16px; padding: 12px 14px; cursor: pointer; text-align: left;
        border: 1px solid var(--linha); border-radius: var(--r);
        background: linear-gradient(180deg, rgba(255,197,61,.08), rgba(255,197,61,.02));
        transition: border-color var(--t), background-color var(--t);
      }
      .meu-status:hover { border-color: rgba(255,197,61,.5); }
      .meu-status-l { display: flex; flex-direction: column; gap: 2px; }
      .meu-status-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: .18em;
        text-transform: uppercase; color: rgba(255,255,255,.45);
      }
      .meu-status-pos { font-weight: 800; font-size: 30px; line-height: 1; color: var(--ambar); }
      .meu-status-pos small { font-size: 14px; color: var(--giz); font-weight: 700; }
      .meu-status-r { text-align: right; }
      .meu-status-pts { font-family: 'IBM Plex Mono', monospace; font-size: 24px; font-weight: 700; color: var(--giz); line-height: 1; }
      .meu-status-pts b { color: var(--ambar); }
      .meu-status-sub { display: block; font-size: 11px; color: rgba(255,255,255,.5); margin-top: 4px; }

      /* pódio visual do top 3 */
      .podio-wrap { display: flex; align-items: flex-end; justify-content: center; gap: 8px; margin: 6px 0 20px; }
      .podio-col {
        flex: 1 1 0; max-width: 130px; min-width: 0; cursor: pointer;
        display: flex; flex-direction: column; align-items: center;
        background: none; border: none; padding: 0; color: var(--giz);
        animation: sobe .5s var(--t) both;
      }
      .podio2 { animation-delay: .05s; }
      .podio1 { animation-delay: 0s; }
      .podio3 { animation-delay: .1s; }
      .podio-crown { font-size: 22px; line-height: 1; margin-bottom: -6px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.5)); position: relative; z-index: 2; }
      .podio-av { margin-bottom: 7px; border-radius: 50%; }
      .podio1 .podio-av { box-shadow: 0 0 0 3px rgba(255,197,61,.4), 0 6px 18px rgba(0,0,0,.4); border-radius: 50%; }
      .podio-nome {
        font-weight: 700; font-size: 15px; line-height: 1.1; text-align: center;
        max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .podio-pts { font-family: 'IBM Plex Mono', monospace; font-weight: 700; font-size: 15px; color: var(--ambar); margin-top: 2px; }
      .podio-exatos { font-size: 11px; color: rgba(255,255,255,.5); margin-top: 1px; text-align: center; line-height: 1.3; }
      .podio-ped {
        width: 100%; margin-top: 9px; border-radius: 6px 6px 0 0;
        display: flex; align-items: center; justify-content: center;
        font-family: 'Barlow Condensed', sans-serif; font-weight: 800; font-size: 28px;
        color: rgba(0,0,0,.38); border: 1px solid rgba(255,255,255,.08); border-bottom: none;
      }
      .podio-ped-1 { height: 74px; background: linear-gradient(180deg, #ffd75e, #cd9636); box-shadow: 0 0 18px rgba(255,197,61,.3); }
      .podio-ped-2 { height: 54px; background: linear-gradient(180deg, #dfe7ee, #9aa6b0); }
      .podio-ped-3 { height: 40px; background: linear-gradient(180deg, #e29a5e, #b0703c); }
      /* legenda de desempate, abaixo do pódio (substitui o selo no pedestal) */
      .podio-legenda {
        margin: -8px 0 18px; padding: 9px 12px; border: 1px solid var(--linha);
        border-radius: var(--r); background: rgba(255,197,61,.05);
        display: flex; flex-direction: column; gap: 5px;
      }
      .podio-legenda-tit {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: .18em;
        text-transform: uppercase; color: rgba(255,197,61,.75);
      }
      .podio-legenda-item { font-size: 13px; line-height: 1.35; color: rgba(255,255,255,.78); }
      .podio-legenda-item b { color: var(--giz); font-weight: 700; }
      .podio-legenda-ico { margin-right: 5px; }
      .bonus-badge {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 700;
        color: #7ee2a0; border: 1.5px solid #7ee2a0; padding: 1px 5px;
        white-space: nowrap; flex: none;
      }
      .trend-up   { font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 700; color: #7ee2a0; white-space: nowrap; flex: none; }
      .trend-down { font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 700; color: var(--erro); white-space: nowrap; flex: none; }

      .modal-overlay {
        position: fixed; inset: 0; z-index: 100;
        background: rgba(0,0,0,.7); backdrop-filter: blur(3px);
        display: flex; align-items: flex-end; justify-content: center;
        animation: fade-modal .2s ease both;
      }
      @keyframes fade-modal { from { opacity: 0; } to { opacity: 1; } }
      .modal-painel {
        width: 100%; max-width: 680px; max-height: 84vh; overflow-y: auto; overflow-x: hidden;
        color: var(--giz); /* cor base do texto (modais via portal ficam fora do .bolao-root) */
        background: var(--grama); border: 2px solid var(--linha); border-bottom: none;
        border-radius: calc(var(--r) + 4px) calc(var(--r) + 4px) 0 0;
        padding: 18px 16px 48px;
        animation: sobe .28s var(--t) both;
        scrollbar-width: thin; scrollbar-color: var(--linha) transparent;
      }
      .modal-painel::-webkit-scrollbar { width: 5px; }
      .modal-painel::-webkit-scrollbar-thumb { background: var(--linha); border-radius: 3px; }
      .modal-header {
        display: flex; align-items: center; justify-content: space-between;
        gap: 12px; margin-bottom: 16px; padding-bottom: 14px;
        border-bottom: 1px solid var(--linha);
      }
      .modal-nome { font-size: 22px; font-weight: 800; letter-spacing: .03em; }
      .modal-stats { font-family: 'IBM Plex Mono', monospace; font-size: 10px; opacity: .7; letter-spacing: .1em; margin-top: 3px; }
      .modal-jogo {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 9px 10px; border-bottom: 1px solid rgba(255,255,255,.07);
        font-size: 14px; font-weight: 600;
        animation: sobe .35s var(--t) both; animation-delay: calc(var(--i, 0) * 22ms);
      }
      .modal-jogo:last-child { border-bottom: none; }
      .modal-jogo-exato { background: rgba(255,197,61,.08); border-left: 3px solid var(--ambar); }
      .modal-jogo-ok    { border-left: 3px solid rgba(255,255,255,.2); }
      .modal-jogo-miss  { opacity: .45; }
      .modal-jogo-times { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
      .modal-placar-final { font-family: 'IBM Plex Mono', monospace; font-size: 12px; opacity: .55; margin: 0 4px; }
      .modal-jogo-peso {
        font: 700 10px 'Barlow Condensed', sans-serif; letter-spacing: .03em;
        color: #7ec8e3; border: 1px solid rgba(58,157,224,.4); border-radius: 4px;
        padding: 0 4px; line-height: 1.5; flex: none;
      }
      .modal-jogo-peso-final { color: var(--ambar); border-color: rgba(255,197,61,.5); }
      .modal-jogo-direita { display: flex; align-items: center; gap: 8px; flex: none; }
      .modal-palpite { font-family: 'IBM Plex Mono', monospace; font-size: 14px; font-weight: 700; color: var(--ambar); }
      .modal-sem-palpite { font-family: 'IBM Plex Mono', monospace; font-size: 11px; opacity: .3; }

      .confete-wrap {
        position: fixed; inset: 0; pointer-events: none; z-index: 999; overflow: hidden;
      }
      @keyframes confete-cai {
        0%   { transform: translateY(-12px) rotate(0deg) scaleX(1);    opacity: 1; }
        50%  { transform: translateY(52vh)  rotate(320deg) scaleX(-1); opacity: 1; }
        100% { transform: translateY(110vh) rotate(640deg) scaleX(1);  opacity: 0; }
      }
      .confete-peca {
        position: absolute; top: 0;
        border-radius: 2px;
        animation: confete-cai ease-in forwards;
      }

      @keyframes gol {
        0%   { opacity: 0; transform: translate(-50%, 4px) scale(.6); }
        18%  { opacity: 1; transform: translate(-50%, -8px) scale(1.25); }
        55%  { opacity: 1; transform: translate(-50%, -6px) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -20px) scale(.85); }
      }
      .gol-burst {
        position: absolute; left: 50%; top: 50%;
        transform: translate(-50%, 0);
        font-family: 'Barlow Condensed', sans-serif;
        font-weight: 800; font-size: 20px; letter-spacing: .12em;
        color: var(--ambar); text-shadow: 0 2px 10px rgba(0,0,0,.6);
        pointer-events: none; white-space: nowrap; z-index: 4;
        animation: gol 1.8s ease-out forwards;
      }
      .col-pos { font-family: 'IBM Plex Mono', monospace; font-size: 13px; opacity: .7; }
      .col-nome { display: flex; flex-direction: column; justify-content: center; overflow: hidden; min-width: 0; gap: 2px; }
      .col-nome-inner { display: flex; align-items: center; gap: 7px; overflow: hidden; min-width: 0; }
      .col-detalhe-mobile { display: none; }
      .col-num {
        text-align: center; font-family: 'IBM Plex Mono', monospace; font-size: 16px; font-weight: 700;
        border-left: 1px solid rgba(255,255,255,.08); padding-left: 4px;
      }
      .col-num-hd { font-size: 9px; font-weight: 400; line-height: 1.6; letter-spacing: .1em; }
      .col-pts { text-align: right; border-left: 1px solid rgba(255,255,255,.12); padding-left: 6px; }

      .avatar {
        border-radius: 50%; display: flex; align-items: center; justify-content: center;
        font-weight: 800; font-family: 'Barlow Condensed', sans-serif; letter-spacing: .02em;
        flex: none; user-select: none; color: rgba(0,0,0,.72);
        box-shadow: 0 1px 5px rgba(0,0,0,.35); overflow: hidden;
      }

      .avatar-header-btn {
        background: transparent; border: none; cursor: pointer; padding: 0;
        transition: transform var(--t), opacity var(--t);
      }
      .avatar-header-btn:hover { transform: scale(1.08); opacity: .85; }

      .regras-btn {
        width: 34px; height: 34px; border-radius: 50%;
        background: transparent; border: 2px solid rgba(255,255,255,.18);
        cursor: pointer; color: var(--giz); opacity: .5;
        font-family: 'IBM Plex Mono', monospace; font-size: 15px; font-weight: 700;
        display: flex; align-items: center; justify-content: center;
        transition: opacity var(--t), border-color var(--t);
      }
      .regras-btn:hover { opacity: 1; border-color: rgba(255,255,255,.5); }

      .regras-corpo { padding: 4px 16px 20px; overflow-y: auto; }
      .regras-secao {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
        color: var(--ambar); margin: 20px 0 10px;
      }
      .regras-secao:first-child { margin-top: 8px; }
      .regras-item { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 14px; }
      .regras-p { font-size: 13px; line-height: 1.55; margin: 0 0 8px; opacity: .85; }

      .tag-elim {
        background: rgba(58,157,224,.15); color: #7ec8e3;
        border: 1px solid rgba(58,157,224,.35);
      }
      .tag-elim.tag-final {
        background: rgba(255,197,61,.16); color: var(--ambar);
        border-color: rgba(255,197,61,.5);
      }

      /* peso por fase — selos e banner */
      .pts-peso-mini { font-size: 9px; opacity: .6; font-weight: 600; }
      .sj-peso {
        font: 700 10px 'Barlow Condensed', sans-serif; letter-spacing: .04em;
        color: #7ec8e3; border: 1px solid rgba(58,157,224,.4); border-radius: 4px;
        padding: 0 4px; line-height: 1.5;
      }
      .sj-peso-final { color: var(--ambar); border-color: rgba(255,197,61,.5); }
      .peso-banner {
        display: flex; align-items: center; gap: 10px; margin: 10px 0 6px;
        padding: 9px 12px; border-radius: var(--r);
        background: rgba(58,157,224,.1); border: 1px solid rgba(58,157,224,.3);
        color: var(--giz); font-size: 12.5px; line-height: 1.35;
      }
      .peso-banner strong { color: #7ec8e3; }
      .peso-banner-x {
        flex-shrink: 0; font: 800 16px 'IBM Plex Mono', monospace; color: #7ec8e3;
      }
      .peso-banner-final {
        background: rgba(255,197,61,.12); border-color: rgba(255,197,61,.4);
      }
      .peso-banner-final strong, .peso-banner-final .peso-banner-x { color: var(--ambar); }
      /* tabela de pesos no modal de regras */
      .regras-pesos { display: flex; flex-direction: column; gap: 6px; margin: 0 0 10px; }
      .regras-peso {
        display: flex; align-items: center; gap: 10px;
        font-size: 13px; color: var(--giz);
      }
      .regras-peso-x {
        flex-shrink: 0; width: 34px; text-align: center;
        font: 800 14px 'IBM Plex Mono', monospace; color: #7ec8e3;
        background: rgba(58,157,224,.12); border: 1px solid rgba(58,157,224,.3);
        border-radius: 5px; padding: 2px 0;
      }
      .regras-peso-final .regras-peso-x { color: var(--ambar); background: rgba(255,197,61,.14); border-color: rgba(255,197,61,.4); }
      .aviso-90min {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 700;
        color: var(--ambar); opacity: .75; white-space: nowrap; flex: none;
        border: 1px solid rgba(255,197,61,.3); border-radius: 4px; padding: 2px 5px;
      }
      .select-fase {
        background: var(--fundo); border: 2px solid var(--linha); color: var(--giz);
        font-family: 'IBM Plex Mono', monospace; font-size: 11px;
        padding: 6px 8px; border-radius: 0; flex: none;
      }
      .botao-zap { border-color: rgba(37,211,102,.45); color: #5ddb85; }
      .botao-zap:hover:not(:disabled) { background: rgba(37,211,102,.12); border-color: rgba(37,211,102,.8); }
      .botao-zap:disabled { border-color: var(--linha); color: var(--giz); opacity: .35; }

      .desempate-badge {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px; font-weight: 700;
        background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.15);
        color: rgba(255,255,255,0.45); padding: 1px 5px; border-radius: 3px;
        white-space: nowrap; letter-spacing: .03em;
      }

      .notif-bloco { margin: 8px 0 12px; }
      .notif-btn { width: 100%; justify-content: center; }
      .notif-aviso {
        font-size: 12px; color: rgba(255,255,255,.5); background: rgba(0,0,0,.2);
        border: 1px solid var(--linha); border-radius: 6px; padding: 10px 12px;
        margin: 8px 0 12px; line-height: 1.5;
      }

      .grafico-bloco { margin-top: 12px; margin-bottom: 4px; }
      .grafico-toggle {
        width: 100%; display: flex; align-items: center; justify-content: space-between;
        background: rgba(0,0,0,.3); border: 2px solid var(--linha);
        color: var(--ambar); font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
        padding: 10px 14px; cursor: pointer; transition: background var(--t);
      }
      .grafico-toggle:hover { background: rgba(255,197,61,.08); }
      .grafico-chevron { font-size: 9px; opacity: .7; }

      /* chips de comparação do gráfico de evolução */
      .grafico-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
      .grafico-chip {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 4px 10px; border-radius: 999px; cursor: pointer;
        background: rgba(0,0,0,.25); border: 1px solid rgba(255,255,255,.14);
        color: rgba(242,246,239,.6);
        font: 700 11px 'Barlow Condensed', sans-serif; letter-spacing: .04em;
        transition: border-color var(--t), color var(--t), background-color var(--t);
      }
      .grafico-chip:hover { background: rgba(255,255,255,.06); }
      .grafico-chip-on { background: rgba(255,255,255,.07); }
      .grafico-chip-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
      .grafico-dica {
        margin: 8px 0 0; font-size: 11px; letter-spacing: .02em;
        color: rgba(242,246,239,.4);
      }

      .stats-toggle {
        width: 100%; display: flex; align-items: center; justify-content: space-between;
        background: rgba(0,0,0,.3); border: 2px solid var(--linha);
        color: var(--ambar); font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
        padding: 10px 14px; cursor: pointer; transition: background var(--t);
      }
      .stats-toggle:hover { background: rgba(255,197,61,.08); }
      .stats-grid {
        display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px;
      }
      @media (max-width: 480px) { .stats-grid { grid-template-columns: 1fr; } }
      .stats-card {
        background: rgba(0,0,0,.25); border: 2px solid var(--linha);
        padding: 12px 14px; display: flex; gap: 12px; align-items: flex-start;
      }
      .stats-emoji { font-size: 26px; flex: none; line-height: 1; padding-top: 2px; }
      .stats-info { flex: 1; min-width: 0; }
      .stats-titulo {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: .12em;
        text-transform: uppercase; color: var(--ambar); margin-bottom: 5px;
      }
      .stats-nome {
        display: flex; align-items: center; gap: 6px;
        font-size: 14px; font-weight: 700; margin-bottom: 3px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .stats-detalhe { font-size: 11px; opacity: .55; font-family: 'IBM Plex Mono', monospace; margin-top: 2px; }
      .stats-empate { opacity: .6; }

      .perfil-picker {
        background: rgba(0,0,0,.32); border: 2px solid var(--linha);
        padding: 14px; margin-bottom: 16px;
      }
      .perfil-picker-topo {
        display: flex; align-items: center; justify-content: space-between;
      }
      .perfil-picker-preview { display: flex; align-items: center; gap: 12px; }
      .perfil-picker-nome { font-size: 20px; font-weight: 800; letter-spacing: .03em; }
      .perfil-badge-admin { font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: .1em; color: var(--ambar); opacity: .8; margin-top: 2px; }

      .perfil-headline { display: flex; align-items: center; gap: 0; margin-top: 14px; background: rgba(0,0,0,.2); border: 1px solid var(--linha); border-radius: 6px; overflow: hidden; }
      .perfil-hl-item { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 10px 4px; }
      .perfil-hl-num { font-family: 'IBM Plex Mono', monospace; font-size: 22px; font-weight: 700; color: var(--ambar); }
      .perfil-hl-label { font-size: 9px; letter-spacing: .1em; opacity: .5; margin-top: 2px; }
      .perfil-hl-sep { width: 1px; height: 36px; background: var(--linha); flex: none; }

      .perfil-barra-bg { height: 4px; background: rgba(255,255,255,.08); border-radius: 2px; margin-top: 10px; overflow: hidden; }
      .perfil-barra-fill { height: 100%; background: var(--ambar); border-radius: 2px; transition: width .6s ease; }

      .perfil-breakdown { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
      .perfil-bd-item { font-family: 'IBM Plex Mono', monospace; font-size: 11px; padding: 3px 8px; border-radius: 4px; background: rgba(255,255,255,.06); }
      .perfil-bd-exato { color: var(--ambar); }
      .perfil-bd-result { color: rgba(255,255,255,.7); }
      .perfil-bd-erro { color: var(--erro); }
      .perfil-bd-miss { color: rgba(255,255,255,.35); }

      /* rolável e contido na largura do modal: com 70+ jogos a tira de barras
         passava da tela e arrastava o app inteiro pra direita no mobile. */
      .perfil-chart {
        display: flex; align-items: flex-end; gap: 2px; height: 36px; margin-top: 8px;
        max-width: 100%; overflow-x: auto; overflow-y: hidden; padding-bottom: 4px;
        scrollbar-width: thin; scrollbar-color: var(--linha) transparent;
      }
      .perfil-chart::-webkit-scrollbar { height: 4px; }
      .perfil-chart::-webkit-scrollbar-thumb { background: var(--linha); border-radius: 2px; }
      .perfil-bar { flex: 1 0 3px; min-width: 3px; max-width: 18px; height: var(--h); border-radius: 2px 2px 0 0; transition: opacity .2s; }
      .perfil-bar:hover { opacity: .75; }
      .perfil-bar-exato  { background: var(--ambar); }
      .perfil-bar-result { background: rgba(255,255,255,.4); }
      .perfil-bar-erro   { background: var(--erro); opacity: .6; }

      .perfil-destaques { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
      .perfil-destaque { display: flex; align-items: center; gap: 8px; font-size: 12px; }
      .perfil-destaque-icon { flex: none; font-size: 14px; }
      .perfil-destaque-txt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .8; }
      .perfil-destaque-pts { font-family: 'IBM Plex Mono', monospace; font-weight: 700; font-size: 12px; flex: none; }

      .paleta { display: flex; gap: 8px; flex-wrap: wrap; }
      .paleta-cor {
        width: 28px; height: 28px; border-radius: 50%;
        border: 2.5px solid transparent; cursor: pointer; flex: none;
        transition: transform var(--t), border-color var(--t);
      }
      .paleta-cor:hover:not(:disabled) { transform: scale(1.18); }
      .paleta-cor-ativa { border-color: var(--giz) !important; transform: scale(1.12); }

      .emoji-grid {
        display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px;
      }
      .emoji-item {
        aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
        font-size: 18px; background: transparent; border: 2px solid transparent;
        cursor: pointer; border-radius: 4px; transition: background-color var(--t), border-color var(--t);
      }
      .emoji-item:hover:not(:disabled) { background: rgba(255,255,255,.08); }
      .emoji-item-ativo { border-color: var(--ambar); background: rgba(255,197,61,.1); }
      .emoji-item:disabled { opacity: .5; cursor: wait; }

      .led {
        font-family: 'IBM Plex Mono', monospace; font-weight: 700; font-size: 22px;
        color: var(--ambar); text-shadow: 0 0 12px rgba(255,197,61,.55);
        animation: acende 1s ease-out both; animation-delay: calc(var(--i, 0) * 60ms + .2s);
      }
      .led-mini { font-size: 20px; }
      @keyframes acende {
        0% { opacity: 0; text-shadow: none; }
        35% { opacity: .4; }
        45% { opacity: .15; }
        60% { opacity: .9; text-shadow: 0 0 18px rgba(255,197,61,.8); }
        100% { opacity: 1; text-shadow: 0 0 12px rgba(255,197,61,.55); }
      }

      .dica { font-size: 15px; opacity: .85; margin: 0 0 12px; letter-spacing: .02em; word-break: break-all; }
      .toast {
        border-left: 3px solid var(--ambar); padding: 8px 12px;
        background: rgba(0,0,0,.3); animation: sobe .3s var(--t) both;
      }
      .vazio {
        border: 2px dashed var(--linha); padding: 26px 18px; text-align: center;
        font-size: 17px; opacity: .85; letter-spacing: .03em;
        display: flex; flex-direction: column; align-items: center; gap: 8px;
        margin-bottom: 10px;
      }
      .bola-quica { display: inline-block; font-size: 22px; animation: quica 1.6s cubic-bezier(.3,0,.4,1) infinite; }
      @keyframes quica {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-9px); }
      }
      .carregando {
        text-align: center; padding: 80px 0; font-size: 20px; letter-spacing: .05em;
        display: flex; align-items: center; justify-content: center; gap: 10px;
      }

      .rodape {
        margin-top: 26px; text-align: center;
        font-family: 'IBM Plex Mono', monospace; font-size: 11px;
        letter-spacing: .12em; opacity: .6; text-transform: uppercase;
        display: flex; align-items: center; justify-content: center; gap: 7px;
      }
      .ponto-salvo {
        width: 7px; height: 7px; border-radius: 50%; flex: none;
        background: #7ee2a0;
      }

      @media (max-width: 460px) {
        .placar-cab, .placar-linha { grid-template-columns: 26px 1fr 56px; padding: 9px 8px; }
        .col-num { display: none; }
        .col-pts { border-left: none; padding-left: 0; }
        .col-detalhe-mobile { display: block; font-family: 'IBM Plex Mono', monospace; font-size: 10px; opacity: .6; letter-spacing: .04em; }
        .jogo { flex-direction: column; align-items: stretch; }
        .jogo-resultado { justify-content: flex-end; }
        .linha-botoes { flex-direction: column; }
        .topo::before { width: 180px; height: 180px; }
      }

      @media (prefers-reduced-motion: reduce) {
        .bolao-root *, .bolao-root *::before, .bolao-root *::after {
          animation: none !important; transition: none !important;
        }
      }
    `}</style>
  );
}
