/* =========================================================================
   SORASAKI — script compartilhado por todas as páginas
   Organização:
     1. Utilidades (formatação, mensagens, botões ocupados)
     2. Estatísticas do bot (ponte) — onStats / onConnection / onFetchError
     3. Cabeçalho, menu lateral e navegação
     4. Conta: login, cadastro, recuperação de senha, perfil
     5. Manutenção, visitas e preferências
     6. Assistente (perguntas frequentes)
     7. Inicialização
   Páginas usam window.Sora (utilidades) e window.SorasakiAuth (conta).
   ========================================================================= */

/* ===== 0. Analytics e proteção contra robôs ===== */
(function () {
  try {
    if (!sessionStorage.getItem("sora_entry_page")) {
      sessionStorage.setItem("sora_entry_page", location.pathname + location.search);
      sessionStorage.setItem("sora_entry_ref", document.referrer || "");
    }
  } catch {}
})();

// O Analytics só liga se houver um ID configurado e a pessoa não tiver
// desativado em Configurações (preferência guardada neste aparelho).
function analyticsPermitido() {
  try { return localStorage.getItem("sorasaki_pref_analytics") !== "off"; } catch { return true; }
}
function iniciarConfigPublica() {
  if (window.SORASAKI_GA_ID && analyticsPermitido()) ligarGoogleAnalytics(window.SORASAKI_GA_ID);
}

function ligarGoogleAnalytics(id) {
  if (!id || window.__soraGaLigado) return;
  window.__soraGaLigado = true;
  // gtag.js não recebe "integrity" (SRI): o Google altera esse arquivo sem
  // aviso, então um hash fixo quebraria o carregamento. A proteção aqui é o
  // CSP, que só permite scripts deste domínio exato.
  const s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(id);
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag("js", new Date());
  window.gtag("config", id, { anonymize_ip: true });
}

let turnstileScriptPromise = null;
function garantirScriptTurnstile() {
  if (!turnstileScriptPromise) {
    turnstileScriptPromise = new Promise((resolve) => {
      if (window.turnstile) return resolve(true);
      // Também sem SRI: a Cloudflare atualiza o api.js continuamente e
      // recomenda não fixar hash. O CSP limita a origem a challenges.cloudflare.com.
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.defer = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }
  return turnstileScriptPromise;
}

// Verificação anti-robô (Cloudflare Turnstile) reutilizável. Cada formulário
// monta um widget; o token é de uso único e é renovado depois de cada envio.
// Quem decide se o token é obrigatório é o Supabase Auth (servidor): aqui o
// site só entrega o token quando existe, sem travar a tela se o Turnstile
// não carregar — a regra de verdade fica no servidor.
const SoraCaptcha = (function () {
  const siteKey = () => String(window.SORASAKI_TURNSTILE_SITE_KEY || "");
  function mount(container) {
    const state = { id: null, token: "", waiters: [] };
    const off = { enabled: false, token: async () => undefined, reset() {} };
    if (!siteKey() || !container) return off;
    const entregar = (tok) => { state.token = tok || ""; const w = state.waiters.splice(0); w.forEach((fn) => fn(state.token)); };
    garantirScriptTurnstile().then((ok) => {
      if (!ok || !window.turnstile) { entregar(""); return; }
      try {
        state.id = window.turnstile.render(container, {
          sitekey: siteKey(),
          theme: "dark",
          appearance: "interaction-only",
          language: "pt-br",
          callback: (t) => entregar(t),
          "expired-callback": () => { state.token = ""; },
          "error-callback": () => entregar("")
        });
      } catch (e) { console.warn("[SORASAKI] Verificação anti-robô:", e); entregar(""); }
    });
    return {
      enabled: true,
      async token(timeoutMs = 9000) {
        if (state.token) return state.token;
        return new Promise((resolve) => {
          const t = setTimeout(() => resolve(undefined), timeoutMs);
          state.waiters.push((tok) => { clearTimeout(t); resolve(tok || undefined); });
        });
      },
      reset() {
        state.token = "";
        if (state.id !== null && window.turnstile) { try { window.turnstile.reset(state.id); } catch {} }
      }
    };
  }
  return { mount, enabled: () => Boolean(siteKey()) };
})();

/* ===== 1. Utilidades ===== */
const MAPA_ESCAPE_HTML = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(valor) {
  if (valor === null || valor === undefined) return "";
  return String(valor).replace(/[&<>"']/g, (c) => MAPA_ESCAPE_HTML[c]);
}
function fmtNumero(n) {
  return new Intl.NumberFormat("pt-BR").format(Number(n) || 0);
}
function fmtUptime(ms) {
  if (!ms || ms < 1000) return "0m";
  const s = Math.floor(ms / 1000);
  const dias = Math.floor(s / 86400);
  const horas = Math.floor((s % 86400) / 3600);
  const minutos = Math.floor((s % 3600) / 60);
  if (!dias && !horas && !minutos) return `${s}s`;
  const partes = [];
  if (dias) partes.push(`${dias}d`);
  if (horas || dias) partes.push(`${horas}h`);
  partes.push(`${minutos}m`);
  return partes.join(" ");
}
function fmtHora(ts) {
  if (!ts) return "—";
  const data = new Date(ts);
  if (Number.isNaN(data.getTime())) return "—";
  return data.toLocaleString("pt-BR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}
function fmtData(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).replace(/\./g, "");
}
function fmtPing(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return "—";
  return Number(ms) < 1 ? "< 1 ms" : `${Math.round(Number(ms))} ms`;
}
function fmtMoeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

window.Sora = (function () {
  const ICONS = {
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.1 7.4 7.4 2.1-7.4 2.1L12 21.5l-2.1-7.4L2.5 12l7.4-2.1z" fill="currentColor"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v5M12 8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    users: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5M16 4.8a3.3 3.3 0 010 6.4M18.5 14.8c1.7.8 2.8 2.6 3 5.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l9.5 16.5h-19z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.5h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  };

  function safeUrl(v) {
    if (!v || !String(v).trim()) return "";
    try {
      const u = new URL(String(v || ""), location.origin);
      return /^https?:$/.test(u.protocol) ? u.href : "";
    } catch { return ""; }
  }

  // Mensagens para o visitante: nunca mostrar detalhes técnicos.
  function friendlyError(error, fallback = "Não foi possível concluir esta ação. Tente novamente.") {
    const m = String(error?.message || error || "").toLowerCase();
    if (!navigator.onLine || m.includes("failed to fetch") || m.includes("networkerror") || m.includes("network request failed") || m.includes("load failed")) {
      return "Sem conexão com a internet. Verifique sua rede e tente novamente.";
    }
    if (m.includes("jwt") || m.includes("not authenticated") || error?.status === 401) return "Sua sessão expirou. Entre novamente para continuar.";
    if (m.includes("row-level security") || m.includes("permission denied") || error?.code === "42501") return "Você não tem permissão para esta ação.";
    if (m.includes("rate limit") || m.includes("too many")) return "Muitas tentativas em pouco tempo. Aguarde um instante e tente novamente.";
    return fallback;
  }

  let toastRegion = null;
  function toast(message, type = "info", ms = 4200) {
    if (!toastRegion) {
      toastRegion = document.createElement("div");
      toastRegion.className = "toast-region";
      toastRegion.setAttribute("role", "status");
      toastRegion.setAttribute("aria-live", "polite");
      document.body.appendChild(toastRegion);
    }
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    toastRegion.appendChild(el);
    setTimeout(() => { el.classList.add("leaving"); setTimeout(() => el.remove(), 300); }, ms);
  }

  // Botão em estado de carregamento: desativa, troca o texto e restaura depois.
  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      if (btn.dataset.idleHtml === undefined) btn.dataset.idleHtml = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add("is-loading");
      btn.setAttribute("aria-busy", "true");
      if (label) btn.textContent = label;
    } else {
      btn.disabled = false;
      btn.classList.remove("is-loading");
      btn.removeAttribute("aria-busy");
      if (btn.dataset.idleHtml !== undefined) { btn.innerHTML = btn.dataset.idleHtml; delete btn.dataset.idleHtml; }
    }
  }

  // Ação destrutiva em dois toques: o primeiro pede confirmação no próprio botão.
  function confirmTap(btn, confirmLabel = "Toque para confirmar") {
    if (btn.dataset.confirming === "1") {
      clearTimeout(Number(btn.dataset.confirmTimer));
      delete btn.dataset.confirming;
      if (btn.dataset.confirmIdle !== undefined) { btn.innerHTML = btn.dataset.confirmIdle; delete btn.dataset.confirmIdle; }
      return true;
    }
    btn.dataset.confirming = "1";
    btn.dataset.confirmIdle = btn.innerHTML;
    btn.textContent = confirmLabel;
    btn.dataset.confirmTimer = String(setTimeout(() => {
      delete btn.dataset.confirming;
      if (btn.dataset.confirmIdle !== undefined) { btn.innerHTML = btn.dataset.confirmIdle; delete btn.dataset.confirmIdle; }
    }, 4000));
    return false;
  }

  function showResult(el, type, message) {
    if (!el) return;
    el.className = `${el.classList.contains("form-result") ? "form-result" : "auth-result"} ${type || ""}`.trim();
    el.textContent = message || "";
  }

  async function fetchJson(url, options = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { cache: "no-store", ...options, headers: { Accept: "application/json", ...(options.headers || {}) }, signal: controller.signal });
      let body = null;
      try { body = await resp.json(); } catch {}
      if (body && body.error_id && typeof body.message === "string" && !body.message.includes(body.error_id)) body.message = `${body.message} (código ${body.error_id})`;
      return { ok: resp.ok, status: resp.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  function emptyState(title, text = "", { icon = "info", retry = false } = {}) {
    return `<div class="empty-state"><span class="empty-state-icon">${ICONS[icon] || ICONS.info}</span><strong>${escapeHtml(title)}</strong>${text ? `<span>${escapeHtml(text)}</span>` : ""}${retry ? '<button class="btn btn-sm" type="button" data-retry>Tentar novamente</button>' : ""}</div>`;
  }

  function initials(name) {
    const clean = String(name || "").replace(/[^\p{L}\p{N} ]/gu, " ").trim();
    return (clean.split(/\s+/).slice(0, 2).map((p) => p[0]).join("") || "S").toUpperCase();
  }

  // Estado público do site (manutenção, envio de divulgações). Uma chamada por página.
  let siteStatePromise = null;
  function siteState() {
    if (!siteStatePromise) {
      siteStatePromise = fetchJson("/api/site-state", {}, 8000)
        .then((r) => (r.ok && r.body ? r.body : { maintenance: false, submissions_enabled: true, max_submissions_24h: 5 }))
        .catch(() => ({ maintenance: false, submissions_enabled: true, max_submissions_24h: 5 }));
    }
    return siteStatePromise;
  }

  // Cores dos gráficos em sintonia com o tema.
  function chartTheme() {
    return {
      accent: "#b9a1ff", accentSoft: "rgba(185,161,255,.16)", second: "#8fb8ff", secondSoft: "rgba(143,184,255,.12)",
      grid: "rgba(255,255,255,.06)", text: "#8d899b", font: "Geist, system-ui, sans-serif"
    };
  }
  function applyChartDefaults() {
    if (!window.Chart) return false;
    const t = chartTheme();
    Chart.defaults.color = t.text;
    Chart.defaults.font.family = t.font;
    Chart.defaults.font.size = 12;
    Chart.defaults.borderColor = t.grid;
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.plugins.legend.labels.boxWidth = 10;
    Chart.defaults.plugins.legend.labels.boxHeight = 10;
    Chart.defaults.plugins.tooltip.backgroundColor = "#24222d";
    Chart.defaults.plugins.tooltip.borderColor = "rgba(255,255,255,.12)";
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.padding = 10;
    Chart.defaults.plugins.tooltip.titleColor = "#f2f0f6";
    Chart.defaults.plugins.tooltip.bodyColor = "#bdb9c8";
    return true;
  }

  return { ICONS, safeUrl, friendlyError, toast, setBusy, confirmTap, showResult, fetchJson, emptyState, initials, siteState, chartTheme, applyChartDefaults };
})();

/* ===== 2. Estatísticas do bot (ponte) ===== */
const listeners = [];
const errorListeners = [];
const connectionListeners = [];
const INTERVALO_ATUALIZACAO_MS = 8000;
const TIMEOUT_FETCH_MS = 12000;
let ultimoSnapshot = null;

function onStats(callback) { listeners.push(callback); if (ultimoSnapshot) { try { callback(ultimoSnapshot); } catch (e) { console.error(e); } } }
function onFetchError(callback) { errorListeners.push(callback); }
function onConnection(callback) { connectionListeners.push(callback); }

function emitStats(snapshot) {
  ultimoSnapshot = snapshot;
  for (const cb of listeners) { try { cb(snapshot); } catch (e) { console.error("[SORASAKI]", e); } }
}
function emitError(mensagem) {
  for (const cb of errorListeners) { try { cb(mensagem); } catch (e) { console.error("[SORASAKI]", e); } }
}
function emitConnection(info) {
  for (const cb of connectionListeners) { try { cb(info); } catch (e) { console.error("[SORASAKI]", e); } }
}
function urlBase() {
  return String(window.SORASAKI_BRIDGE_URL || "").trim().replace(/\/+$/, "");
}

async function buscarStats() {
  const base = urlBase();
  const indisponivel = "Os dados do bot estão indisponíveis no momento. Tentaremos de novo em instantes.";
  if (!base) {
    emitConnection({ bridgeOnline: false, botDataReceived: false });
    emitError(indisponivel);
    return;
  }
  try {
    const stats = await Sora.fetchJson(`${base}/api/stats`, {}, TIMEOUT_FETCH_MS);
    if (!stats.ok || !stats.body || typeof stats.body !== "object") {
      emitConnection({ bridgeOnline: stats.status > 0 && stats.status < 500, botDataReceived: false });
      emitError(stats.status === 503 ? "Os dados do bot ainda estão chegando. Tente novamente em alguns instantes." : indisponivel);
      return;
    }
    const snapshot = stats.body.data && typeof stats.body.data === "object" ? stats.body.data : stats.body;
    emitStats(snapshot);
    emitConnection({ bridgeOnline: true, botDataReceived: true, lastUpdate: stats.body.timestamp || null });
  } catch (e) {
    console.warn("[SORASAKI] Estatísticas do bot:", e?.name === "AbortError" ? "tempo esgotado" : e);
    emitConnection({ bridgeOnline: false, botDataReceived: false });
    emitError(indisponivel);
  }
}

function bootstrapDashboard() {
  let falhasSeguidas = 0;
  let cronometro = null;
  function proximoAtraso(falhas) {
    if (falhas === 0) return INTERVALO_ATUALIZACAO_MS;
    const base = Math.min(INTERVALO_ATUALIZACAO_MS * 2 ** Math.min(falhas, 4), 120000);
    return Math.round(base + base * 0.2 * Math.random());
  }
  async function ciclo() {
    clearTimeout(cronometro);
    await buscarStats();
    if (document.visibilityState === "visible") cronometro = setTimeout(ciclo, proximoAtraso(falhasSeguidas));
  }
  onFetchError(() => { falhasSeguidas += 1; });
  onStats(() => { falhasSeguidas = 0; });
  ciclo();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { falhasSeguidas = 0; ciclo(); }
    else clearTimeout(cronometro);
  });
  window.SoraRefreshStats = ciclo;
}

function statusEfetivo(snapshot) {
  if (!snapshot || snapshot.status !== "online") return snapshot?.status || "offline";
  const quedas = snapshot.historico?.quedas || [];
  const agora = Date.now();
  const recentes = quedas.filter((q) => q.inicio && agora - new Date(q.inicio).getTime() < 15 * 60 * 1000).length;
  return recentes >= 2 ? "instavel" : "online";
}
function statusInfo(status) {
  const mapa = {
    online: { texto: "Bot online", classe: "online", curto: "Online" },
    instavel: { texto: "Bot instável", classe: "instavel", curto: "Instável" },
    reconectando: { texto: "Reconectando", classe: "reconectando", curto: "Reconectando" },
    conectando: { texto: "Conectando", classe: "conectando", curto: "Conectando" },
    offline: { texto: "Bot offline", classe: "offline", curto: "Offline" }
  };
  return mapa[status] || mapa.offline;
}

// Indicador de status do bot no cabeçalho — desativado publicamente junto
// com o resto das estatísticas do bot principal (ver comentário mais abaixo,
// perto de bootstrapDashboard). Só esconde os elementos, sem remover do HTML
// de cada página (evita editar dezenas de arquivos por um indicador que já
// não é alimentado por nada).
function ligarIndicadorDoBot() {
  document.querySelectorAll("[data-bot-status]").forEach((el) => { el.style.display = "none"; });
}

/* ===== 3. Cabeçalho, menu lateral e navegação ===== */
const SORA_NAV = [
  { grupo: "Explorar", itens: [
    ["/", "Início", "Visão geral do Sorasaki"],
    ["/grupos", "Grupos", "Comunidades revisadas pela equipe"],
    ["/catalogo", "Catálogo", "Produtos e serviços"],
    ["/noticias", "Notícias", "Novidades e avisos"],
    ["/recursos", "Recursos", "O que o bot faz no grupo"]
  ] },
  { grupo: "Sorasaki", itens: [
    ["/sobre", "Sobre", "O projeto e a proposta"],
    ["/suporte", "Suporte", "Fale com a equipe"],
    ["/feedback", "Avaliações e bugs", "Avalie, sugira ou relate um problema"],
    ["/configuracoes", "Configurações", "Preferências deste aparelho"]
  ] }
];

function caminhoAtual() {
  let p = location.pathname.replace(/\/+$/, "").replace(/\.html$/, "") || "/";
  if (p === "/index") p = "/";
  return p;
}

function marcarNavAtiva() {
  const atual = caminhoAtual();
  document.querySelectorAll(".site-nav a, .sora-menu-link, .footer-col a").forEach((a) => {
    const href = (a.getAttribute("href") || "").split("#")[0].replace(/\.html$/, "") || "/";
    const ativo = href === atual;
    a.classList.toggle("active", ativo);
    if (ativo && !a.closest(".footer-col")) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
}

function criarMenuSorasaki() {
  if (document.querySelector(".sora-drawer")) return;
  const trigger = document.querySelector(".menu-trigger");
  if (!trigger) return;

  const overlay = document.createElement("div");
  overlay.className = "sora-overlay";
  const drawer = document.createElement("aside");
  drawer.className = "sora-drawer";
  drawer.id = "soraDrawer";
  drawer.setAttribute("aria-label", "Menu do Sorasaki");
  drawer.setAttribute("aria-hidden", "true");
  drawer.innerHTML = `
    <div class="drawer-head">
      <a class="brand" href="/"><span class="brand-mark">${Sora.ICONS.star}</span><span class="brand-name">SORASAKI</span></a>
      <button class="icon-btn" type="button" data-close-drawer aria-label="Fechar menu">×</button>
    </div>
    <div class="drawer-body">
      <div class="drawer-account" data-drawer-account></div>
      <a class="btn btn-primary btn-block" href="/grupos#divulgar" style="margin-top:12px">Divulgar meu grupo</a>
      ${SORA_NAV.map((sec) => `
        <div class="drawer-label">${sec.grupo}</div>
        <div class="sora-menu-items">${sec.itens.map(([href, titulo, desc]) => `
          <a class="sora-menu-link" href="${href}"><span><strong>${titulo}</strong><small>${desc}</small></span><span class="menu-arrow" aria-hidden="true">›</span></a>`).join("")}
        </div>`).join("")}
    </div>`;
  trigger.setAttribute("aria-controls", "soraDrawer");
  document.body.append(overlay, drawer);

  function renderConta() {
    const box = drawer.querySelector("[data-drawer-account]");
    const user = window.SorasakiAuth?.getUser?.();
    if (user) {
      const nome = user.user_metadata?.username || user.email?.split("@")[0] || "sua conta";
      box.innerHTML = `<span class="profile-avatar" style="width:40px;height:40px;font-size:16px">${escapeHtml(Sora.initials(nome))}</span><div><strong>@${escapeHtml(nome)}</strong><small>${escapeHtml(user.email || "")}</small></div><button class="btn btn-sm" type="button" data-drawer-profile>Perfil</button>`;
      box.querySelector("[data-drawer-profile]").onclick = () => { fechar(); window.SorasakiAuth.openProfile(); };
    } else {
      box.innerHTML = `<div><strong>Você não está conectado</strong><small>Entre para divulgar, avaliar e comprar.</small></div><button class="btn btn-sm" type="button" data-drawer-login>Entrar</button>`;
      box.querySelector("[data-drawer-login]").onclick = () => { fechar(); window.SorasakiAuth.open("login"); };
    }
  }

  function abrir() {
    renderConta();
    drawer.classList.add("is-open");
    overlay.classList.add("is-open");
    drawer.setAttribute("aria-hidden", "false");
    trigger.setAttribute("aria-expanded", "true");
    document.body.classList.add("menu-open");
    setTimeout(() => drawer.querySelector("[data-close-drawer]")?.focus(), 60);
  }
  function fechar() {
    if (!drawer.classList.contains("is-open")) return;
    drawer.classList.remove("is-open");
    overlay.classList.remove("is-open");
    drawer.setAttribute("aria-hidden", "true");
    trigger.setAttribute("aria-expanded", "false");
    document.body.classList.remove("menu-open");
    trigger.focus({ preventScroll: true });
  }
  trigger.addEventListener("click", () => (drawer.classList.contains("is-open") ? fechar() : abrir()));
  overlay.addEventListener("click", fechar);
  drawer.querySelector("[data-close-drawer]").addEventListener("click", fechar);
  drawer.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (!link) return;
    const [pagina, hash] = (link.getAttribute("href") || "").split("#");
    const mesmaPagina = (pagina.replace(/\.html$/, "") || "/") === caminhoAtual();
    fechar();
    if (hash && mesmaPagina) {
      event.preventDefault();
      history.replaceState(null, "", `#${hash}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") fechar(); });
  window.SorasakiAuth?.onAuthChange?.(() => { if (drawer.classList.contains("is-open")) renderConta(); });
  window.SoraMenu = { abrir, fechar };
}

/* ===== 4. Conta: login, cadastro, Google, recuperação, verificação em duas etapas, perfil ===== */
const ICONE_GOOGLE = '<svg viewBox="0 0 18 18" aria-hidden="true" width="18" height="18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.85 2.09-1.8 2.73v2.27h2.92c1.71-1.57 2.68-3.88 2.68-6.64z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.17l-2.92-2.27c-.81.54-1.85.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.98v2.34C2.46 15.98 5.48 18 9 18z"/><path fill="#FBBC05" d="M3.97 10.71A5.4 5.4 0 0 1 3.68 9c0-.59.1-1.17.29-1.71V4.95H.98A9 9 0 0 0 0 9c0 1.45.35 2.83.98 4.05z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0 5.48 0 2.46 2.02.98 4.95l2.99 2.34C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';
(function () {
  const SUPA_URL = window.SORASAKI_SUPABASE_URL || "";
  const SUPA_KEY = window.SORASAKI_SUPABASE_KEY || "";
  let client = null;
  let currentUser = null;
  let afterAuthAction = null;
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  const authListeners = [];
  // Lidos antes do Supabase limpar o endereço (volta de e-mail ou do Google).
  const urlInicial = new URL(location.href);
  const hashInicial = location.hash || "";

  // flowType "pkce": o login com Google e os links de e-mail passam por um
  // código de uso único amarrado a este navegador (proteção de "state"/CSRF).
  // Links com token solto no endereço (fluxo antigo "implícito") são recusados.
  function ensureClient() {
    if (client) return client;
    if (!SUPA_URL || !SUPA_KEY || !window.supabase?.createClient) return null;
    try {
      client = window.supabase.createClient(SUPA_URL, SUPA_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" }
      });
    } catch (e) {
      console.error("[SORASAKI] Cliente de contas:", e);
      client = null;
    }
    return client;
  }

  function notify(event) {
    updateAuthUI();
    authListeners.slice().forEach((fn) => { try { fn(currentUser, event); } catch (e) { console.error("[SORASAKI]", e); } });
  }

  function intencao(valor) {
    try {
      if (valor === undefined) return sessionStorage.getItem("sora_auth_intent") || "";
      if (valor) sessionStorage.setItem("sora_auth_intent", valor); else sessionStorage.removeItem("sora_auth_intent");
    } catch {}
    return "";
  }

  async function syncSession() {
    const c = ensureClient();
    if (!c) { resolveReady(); notify("INITIAL"); return; }
    c.auth.onAuthStateChange((event, session) => {
      // A sessão inicial é tratada logo abaixo por getSession().
      if (event === "INITIAL_SESSION") return;
      const antes = currentUser?.id;
      currentUser = session?.user || null;
      // Não chamar o Supabase aqui dentro (recomendação da biblioteca): adia.
      if (event === "PASSWORD_RECOVERY") setTimeout(() => openLogin("reset"), 0);
      if (event === "SIGNED_IN") registrarContextoCadastro(session);
      if (antes !== currentUser?.id || event !== "TOKEN_REFRESHED") notify(event);
    });
    try {
      const { data } = await c.auth.getSession();
      currentUser = data?.session?.user || null;
    } catch (e) {
      console.warn("[SORASAKI] Sessão:", e);
      currentUser = null;
    }
    await tratarRetornoDeLink();
    resolveReady();
    notify("INITIAL");
    verificarMfaPendente();
  }

  // Manda pro servidor o contexto de quando a conta foi criada (IP e
  // localização vêm do servidor, não do navegador). Idempotente: pode
  // rodar em todo login que o backend só grava na primeira vez.
  function registrarContextoCadastro(session) {
    try {
      if (!session?.access_token) return;
      if (sessionStorage.getItem("sora_signup_tracked")) return;
      sessionStorage.setItem("sora_signup_tracked", "1");
      fetch("/api/account-actions?type=track-signup", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          entry_page: sessionStorage.getItem("sora_entry_page") || location.pathname,
          referrer: sessionStorage.getItem("sora_entry_ref") || document.referrer || ""
        })
      }).catch(() => {});
    } catch {}
  }

  function limparEndereco(chaves) {
    const u = new URL(location.href);
    chaves.forEach((k) => u.searchParams.delete(k));
    history.replaceState(history.state, "", u.pathname + u.search);
  }

  // Volta de links de e-mail e do Google: confirma, mostra mensagem e limpa o endereço.
  async function tratarRetornoDeLink() {
    const q = urlInicial.searchParams;
    const h = new URLSearchParams(hashInicial.slice(1));
    const intent = intencao();
    const erro = q.get("error") || h.get("error") || q.get("error_code") || h.get("error_code");
    if (erro) {
      const detalhe = `${erro} ${q.get("error_code") || h.get("error_code") || ""} ${q.get("error_description") || h.get("error_description") || ""}`.toLowerCase();
      const msg = detalhe.includes("access_denied") && intent === "oauth" ? "O login com Google foi cancelado."
        : /expired|otp|invalid|flow_state/.test(detalhe) ? "Este link expirou ou já foi usado. Peça um novo e-mail."
        : "Não foi possível concluir pelo link. Tente novamente.";
      console.warn("[SORASAKI] Retorno de autenticação:", detalhe.trim());
      Sora.toast(msg, "error", 7500);
      intencao(null);
      limparEndereco(["error", "error_code", "error_description", "code", "state", "sb"]);
      if (hashInicial) history.replaceState(history.state, "", location.pathname + location.search);
      return;
    }

    // Modelo de e-mail recomendado (token_hash): funciona em qualquer aparelho
    // e navegador, sem depender do código guardado neste navegador.
    const tokenHash = q.get("token_hash");
    const tipo = q.get("type");
    if (tokenHash && tipo) {
      limparEndereco(["token_hash", "type", "next"]);
      const c = ensureClient();
      try {
        const { data, error } = await c.auth.verifyOtp({ token_hash: tokenHash, type: tipo });
        if (error) { Sora.toast(traduzAuthError(error), "error", 7500); return; }
        currentUser = data?.user || data?.session?.user || currentUser;
        if (tipo === "recovery") setTimeout(() => openLogin("reset"), 60);
        else if (tipo === "email_change") Sora.toast("E-mail confirmado. A troca vale assim que os dois endereços forem confirmados.", "ok", 7000);
        else Sora.toast("E-mail confirmado. Você já está conectado.", "ok");
      } catch (e) { console.warn("[SORASAKI] Link de e-mail:", e); Sora.toast("Não foi possível confirmar pelo link. Peça um novo e-mail.", "error", 7500); }
      intencao(null);
      return;
    }

    if (q.get("code")) {
      limparEndereco(["code", "state"]);
      if (currentUser) {
        if (intent === "oauth") Sora.toast("Você entrou com o Google.", "ok");
        else if (intent === "signup") Sora.toast("E-mail confirmado. Você já está conectado.", "ok");
        else if (intent === "recovery") setTimeout(() => openLogin("reset"), 60);
        else if (intent === "email_change") Sora.toast("Troca de e-mail confirmada.", "ok");
      } else {
        // O código chegou num navegador diferente do que pediu o link.
        Sora.toast("Link confirmado. Se era um cadastro, agora é só entrar. Se era para trocar a senha, abra o link no mesmo navegador em que fez o pedido.", "info", 9000);
      }
      intencao(null);
      return;
    }

    // Links gerados antes desta atualização trazem o token no "#" e são recusados.
    if (h.get("access_token") || h.get("refresh_token")) {
      history.replaceState(history.state, "", location.pathname + location.search);
      if (!currentUser) Sora.toast("Este link é de uma versão anterior do site. Peça um novo e-mail.", "error", 7500);
    }
  }

  function getUser() { return currentUser; }
  function onAuthChange(callback) {
    if (typeof callback !== "function") return () => {};
    authListeners.push(callback);
    return () => { const i = authListeners.indexOf(callback); if (i >= 0) authListeners.splice(i, 1); };
  }
  async function getToken() {
    const c = ensureClient();
    if (!c) return "";
    try { const { data } = await c.auth.getSession(); return data?.session?.access_token || ""; } catch { return ""; }
  }
  async function logout(scope = "local") {
    const c = ensureClient();
    try { if (c) await c.auth.signOut({ scope }); } catch (e) { console.warn("[SORASAKI] Sair:", e); }
    currentUser = null;
    notify("SIGNED_OUT");
  }
  function setAfterAuth(fn) { afterAuthAction = typeof fn === "function" ? fn : null; }
  function runAfterAuth() {
    const fn = afterAuthAction;
    afterAuthAction = null;
    if (fn) setTimeout(() => { try { fn(); } catch (e) { console.warn("[SORASAKI] Pós-login:", e); } }, 120);
  }

  /* ----- Verificação em duas etapas (TOTP) ----- */
  async function nivelMfa() {
    const c = ensureClient();
    if (!c || !currentUser) return null;
    try { const { data } = await c.auth.mfa.getAuthenticatorAssuranceLevel(); return data || null; } catch { return null; }
  }
  async function mfaPendente() {
    const n = await nivelMfa();
    return Boolean(n && n.nextLevel === "aal2" && n.currentLevel !== "aal2");
  }
  async function verificarMfaPendente() {
    if (currentUser && (await mfaPendente())) openLogin("mfa");
  }
  async function fatorTotpVerificado() {
    const c = ensureClient();
    const { data, error } = await c.auth.mfa.listFactors();
    if (error) throw error;
    return (data?.totp || []).find((f) => f.status === "verified") || null;
  }
  async function confirmarCodigoMfa(codigo) {
    const c = ensureClient();
    const fator = await fatorTotpVerificado();
    if (!fator) return { error: new Error("sem fator") };
    return c.auth.mfa.challengeAndVerify({ factorId: fator.id, code: codigo });
  }

  /* ----- Proteção contra tentativas repetidas (complementa os limites do Supabase) ----- */
  const TRAVA = "sora_login_trava";
  function lerTrava() { try { return JSON.parse(localStorage.getItem(TRAVA) || "{}"); } catch { return {}; } }
  function registrarFalha() {
    const t = lerTrava();
    const falhas = (t.falhas || 0) + 1;
    const ate = falhas >= 5 ? Date.now() + Math.min(30000 * 2 ** (falhas - 5), 15 * 60000) : 0;
    try { localStorage.setItem(TRAVA, JSON.stringify({ falhas, ate })); } catch {}
    return ate;
  }
  function limparFalhas() { try { localStorage.removeItem(TRAVA); } catch {} }
  function travadoAte() { const t = lerTrava(); return t.ate && t.ate > Date.now() ? t.ate : 0; }

  // Espera obrigatória entre reenvios de e-mail (evita spam de códigos/links).
  function esperaRestante(chave) {
    try { const ate = Number(sessionStorage.getItem("sora_espera_" + chave) || 0); return Math.max(0, Math.ceil((ate - Date.now()) / 1000)); } catch { return 0; }
  }
  function iniciarEspera(btn, chave, segundos, rotulo) {
    try { sessionStorage.setItem("sora_espera_" + chave, String(Date.now() + segundos * 1000)); } catch {}
    const tick = () => {
      const s = esperaRestante(chave);
      if (!s) { btn.disabled = false; btn.textContent = rotulo; return; }
      btn.disabled = true;
      btn.textContent = `${rotulo} (${s}s)`;
      setTimeout(tick, 1000);
    };
    tick();
  }

  function traduzAuthError(error) {
    const m = String(error?.message || "").toLowerCase();
    const code = String(error?.code || "").toLowerCase();
    if (m.includes("captcha") || code.includes("captcha")) return "Não conseguimos confirmar que você não é um robô. Aguarde a verificação terminar e tente de novo.";
    if (m.includes("invalid login credentials") || code === "invalid_credentials") return "E-mail ou senha incorretos.";
    if (m.includes("email not confirmed") || code === "email_not_confirmed") return "Confirme seu e-mail antes de entrar. Procure a mensagem do Sorasaki na sua caixa de entrada.";
    if (m.includes("user already registered") || code === "user_already_exists" || code === "email_exists") return "Não foi possível criar a conta com este e-mail. Se ele já é seu, tente entrar ou recuperar a senha.";
    if (m.includes("database error saving new user")) return "Esse nome de usuário já está em uso. Escolha outro.";
    if (m.includes("banned") || code === "user_banned") return "Esta conta está suspensa. Fale com o suporte.";
    if (m.includes("signups not allowed") || code === "signup_disabled") return "Novos cadastros estão pausados no momento.";
    if (m.includes("should be different") || code === "same_password") return "A nova senha precisa ser diferente da atual.";
    if (code === "weak_password" || (m.includes("password") && (m.includes("at least") || m.includes("weak") || m.includes("short") || m.includes("pwned") || m.includes("leaked")))) return "Essa senha é fraca ou já apareceu em vazamentos. Escolha outra, com pelo menos 8 caracteres.";
    if (code === "reauthentication_needed" || m.includes("reauthentication")) return "Por segurança, confirme o código que enviamos para o seu e-mail.";
    if (code === "mfa_verification_failed" || m.includes("invalid totp") || (m.includes("code") && m.includes("invalid"))) return "Código incorreto. Confira no app autenticador e tente de novo.";
    if (m.includes("invalid") && m.includes("email")) return "Confira o e-mail digitado.";
    if (m.includes("expired") || code === "otp_expired") return "Código inválido ou expirado. Peça um novo.";
    if (m.includes("rate limit") || m.includes("too many") || code.includes("rate") || code === "over_request_rate_limit" || code === "over_email_send_rate_limit") return "Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente novamente.";
    return Sora.friendlyError(error, "Não foi possível concluir agora. Tente novamente em alguns instantes.");
  }

  const senhaForte = (p) => p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p) && !/^(.)\1+$/.test(p);
  const MSG_SENHA = "Use pelo menos 8 caracteres, com letras e números.";
  const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

  let loginDrawer = null;
  let loginOverlay = null;
  let lastFocus = null;
  let captchaLogin = null;

  function createLoginUI() {
    if (loginDrawer) return;
    loginOverlay = document.createElement("div");
    loginOverlay.className = "sora-login-overlay";
    loginDrawer = document.createElement("aside");
    loginDrawer.className = "sora-login-drawer";
    loginDrawer.id = "sorasaki-login";
    loginDrawer.setAttribute("role", "dialog");
    loginDrawer.setAttribute("aria-modal", "true");
    loginDrawer.setAttribute("aria-label", "Conta Sorasaki");
    loginDrawer.setAttribute("aria-hidden", "true");
    loginDrawer.innerHTML = `
      <div class="drawer-head">
        <strong>Conta Sorasaki</strong>
        <button class="icon-btn login-close" type="button" aria-label="Fechar">×</button>
      </div>
      <div class="drawer-body">
        <div class="login-tabs" role="tablist">
          <button type="button" class="login-tab active" data-auth-tab="login" role="tab" aria-selected="true">Entrar</button>
          <button type="button" class="login-tab" data-auth-tab="register" role="tab" aria-selected="false">Criar conta</button>
        </div>

        <section class="auth-panel" data-auth-panel="login">
          <div class="login-intro"><h3>Bem-vindo de volta</h3><p>Navegar pelo site não exige conta. Para divulgar grupos, avaliar, relatar ou comprar, entre com o Google ou com seu e-mail.</p></div>
          <button class="btn btn-google btn-block" type="button" data-google-login>${ICONE_GOOGLE} Continuar com Google</button>
          <div class="auth-divider">ou com e-mail</div>
          <form id="authLoginForm" novalidate>
            <label>E-mail<input id="authEmail" type="email" autocomplete="email" inputmode="email" required placeholder="voce@exemplo.com"></label>
            <label>Senha<div class="password-wrap"><input id="authPassword" type="password" autocomplete="current-password" required placeholder="Sua senha"><button type="button" class="password-toggle" data-toggle-password="authPassword" aria-label="Mostrar senha">Mostrar</button></div></label>
            <button class="btn btn-primary btn-block" id="authLogin" type="submit">Entrar</button>
            <div class="auth-row"><button class="auth-link" type="button" data-go="forgot">Esqueci minha senha</button><button class="auth-link" type="button" data-go="register">Criar conta</button></div>
            <div class="auth-result" id="authResult" aria-live="polite"></div>
          </form>
        </section>

        <section class="auth-panel hidden" data-auth-panel="register">
          <div id="registerFormFields" class="auth-panel" style="animation:none">
            <div class="login-intro"><h3>Crie sua conta</h3><p>Leva menos de um minuto. Com e-mail, confirme pelo link que enviaremos.</p></div>
            <button class="btn btn-google btn-block" type="button" data-google-login>${ICONE_GOOGLE} Cadastrar com Google</button>
            <div class="auth-divider">ou com e-mail</div>
            <form id="authRegisterForm" novalidate>
              <label>Nome de usuário<input id="registerUsername" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="24" required placeholder="ex.: sorasakifan"><span class="field-hint">3 a 24 caracteres: letras, números ou _</span></label>
              <label>E-mail<input id="registerEmail" type="email" autocomplete="email" inputmode="email" required placeholder="voce@exemplo.com"></label>
              <label>Senha<div class="password-wrap"><input id="registerPassword" type="password" autocomplete="new-password" minlength="8" required placeholder="Mínimo de 8 caracteres" aria-describedby="senhaDica"><button type="button" class="password-toggle" data-toggle-password="registerPassword" aria-label="Mostrar senha">Mostrar</button></div><span class="field-hint" id="senhaDica">Letras e números, pelo menos 8 caracteres.</span></label>
              <label>Confirmar senha<input id="registerConfirm" type="password" autocomplete="new-password" required placeholder="Digite a senha novamente"></label>
              <button class="btn btn-primary btn-block" id="authRegister" type="submit">Criar conta</button>
              <p class="field-hint">Ao criar sua conta, você concorda com os <a class="text-link" href="/termos" target="_blank" rel="noopener">Termos de Uso</a> e a <a class="text-link" href="/privacidade" target="_blank" rel="noopener">Política de Privacidade</a>.</p>
              <div class="auth-result" id="registerResult" aria-live="polite"></div>
            </form>
          </div>
          <div class="auth-code-area hidden" id="signupCodeArea">
            <div class="login-intro"><h3>Confirme seu e-mail</h3><p>Enviamos um código de 6 dígitos para <b id="signupEmailLabel"></b>. Digite abaixo para concluir seu cadastro.</p></div>
            <form id="authSignupCodeForm" novalidate>
              <label>Código<input id="signupCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></label>
              <button class="btn btn-primary btn-block" id="authSignupVerify" type="submit">Confirmar código</button>
            </form>
            <button class="btn btn-block" id="authResendSignup" type="button">Reenviar código</button>
            <button class="auth-link back-login" type="button" data-go="login">Voltar para o login</button>
            <div class="auth-result" id="signupResult" aria-live="polite"></div>
          </div>
        </section>

        <section class="auth-panel hidden" data-auth-panel="forgot">
          <div class="login-intro"><h3>Recuperar acesso</h3><p>Informe o e-mail da conta. Enviaremos um código de 6 dígitos para você redefinir a senha.</p></div>
          <form id="authForgotForm" novalidate>
            <label>E-mail<input id="forgotEmail" type="email" autocomplete="email" inputmode="email" required placeholder="voce@exemplo.com"></label>
            <button class="btn btn-primary btn-block" id="authSendCode" type="submit">Enviar código</button>
          </form>
          <form class="auth-code-area hidden" id="authCodeArea" novalidate>
            <p class="field-hint">Digite o código de 6 dígitos que enviamos e escolha a nova senha.</p>
            <label>Código<input id="resetCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></label>
            <label>Nova senha<input id="resetPasswordCode" type="password" autocomplete="new-password" minlength="8" placeholder="Mínimo de 8 caracteres"></label>
            <button class="btn btn-primary btn-block" id="authReset" type="submit">Redefinir senha</button>
            <button class="btn btn-block" id="authForgotResend" type="button">Reenviar código</button>
          </form>
          <button class="auth-link back-login" type="button" data-go="login">Voltar para o login</button>
          <div class="auth-result" id="forgotResult" aria-live="polite"></div>
        </section>

        <section class="auth-panel hidden" data-auth-panel="reset">
          <div class="login-intro"><h3>Crie uma nova senha</h3><p>Você entrou pelo link de recuperação. Defina a nova senha da sua conta.</p></div>
          <form id="authNewPasswordForm" novalidate>
            <label>Nova senha<div class="password-wrap"><input id="newPassword" type="password" autocomplete="new-password" minlength="8" required placeholder="Mínimo de 8 caracteres"><button type="button" class="password-toggle" data-toggle-password="newPassword" aria-label="Mostrar senha">Mostrar</button></div></label>
            <label>Confirmar nova senha<input id="newPassword2" type="password" autocomplete="new-password" required></label>
            <button class="btn btn-primary btn-block" id="authSaveNewPassword" type="submit">Salvar nova senha</button>
            <div class="auth-result" id="resetResult" aria-live="polite"></div>
          </form>
        </section>

        <section class="auth-panel hidden" data-auth-panel="emailcode">
          <div class="login-intro"><h3>Verifique seu e-mail</h3><p>Enviamos um código de 6 dígitos para <b id="loginCodeEmailLabel"></b>. Digite abaixo para continuar.</p></div>
          <form id="authEmailCodeForm" novalidate>
            <label>Código<input id="loginEmailCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></label>
            <button class="btn btn-primary btn-block" id="authEmailCodeVerify" type="submit">Confirmar</button>
            <button class="btn btn-block" id="authEmailCodeResend" type="button">Reenviar código</button>
            <button class="auth-link" type="button" id="authEmailCodeCancel">Cancelar e sair da conta</button>
            <div class="auth-result" id="emailCodeResult" aria-live="polite"></div>
          </form>
        </section>

        <section class="auth-panel hidden" data-auth-panel="mfa">
          <div class="login-intro"><h3>Verificação em duas etapas</h3><p>Abra o seu app autenticador (Google Authenticator, Authy, 1Password…) e digite o código de 6 dígitos do Sorasaki.</p></div>
          <form id="authMfaForm" novalidate>
            <label>Código<input id="mfaCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></label>
            <button class="btn btn-primary btn-block" id="authMfaVerify" type="submit">Confirmar</button>
            <button class="auth-link" type="button" id="authMfaCancel">Cancelar e sair da conta</button>
            <div class="auth-result" id="mfaResult" aria-live="polite"></div>
          </form>
        </section>

        <div class="turnstile-box" id="authCaptcha"></div>
        <div class="login-privacy">A gente nunca vai pedir sua senha por WhatsApp ou e-mail — desconfie se isso acontecer.</div>
      </div>`;
    document.body.append(loginOverlay, loginDrawer);
    captchaLogin = SoraCaptcha.mount(loginDrawer.querySelector("#authCaptcha"));

    const $ = (id) => loginDrawer.querySelector("#" + id);
    const tabs = loginDrawer.querySelectorAll("[data-auth-tab]");
    const panels = loginDrawer.querySelectorAll("[data-auth-panel]");
    function tab(name) {
      loginDrawer.dataset.panel = name;
      panels.forEach((p) => p.classList.toggle("hidden", p.dataset.authPanel !== name));
      tabs.forEach((t) => { const on = t.dataset.authTab === name; t.classList.toggle("active", on); t.setAttribute("aria-selected", String(on)); });
      loginDrawer.querySelector(".login-tabs").classList.toggle("hidden", ["forgot", "reset", "mfa", "emailcode"].includes(name));
    }
    loginDrawer._tab = tab;
    tabs.forEach((t) => { t.onclick = () => tab(t.dataset.authTab); });
    loginDrawer.querySelectorAll("[data-go]").forEach((b) => { b.onclick = () => tab(b.dataset.go); });
    loginDrawer.querySelectorAll("[data-toggle-password]").forEach((b) => {
      b.onclick = () => { const i = $(b.dataset.togglePassword); const show = i.type === "password"; i.type = show ? "text" : "password"; b.textContent = show ? "Ocultar" : "Mostrar"; b.setAttribute("aria-label", show ? "Ocultar senha" : "Mostrar senha"); };
    });
    loginDrawer.querySelector(".login-close").onclick = closeLogin;
    loginOverlay.onclick = closeLogin;
    const show = (id, ok, msg) => Sora.showResult($(id), ok === true ? "ok" : ok === "info" ? "info" : "error", msg);

    // Login com Google (OAuth/OIDC pelo Supabase). O código de volta é
    // trocado por sessão só neste navegador (PKCE). A conta é criada ou
    // ligada automaticamente pelo Supabase (mesmo e-mail verificado = mesma conta).
    loginDrawer.querySelectorAll("[data-google-login]").forEach((btn) => {
      btn.onclick = async () => {
        const c = ensureClient();
        if (!c) return Sora.toast("Não foi possível acessar sua conta agora. Recarregue a página e tente novamente.", "error");
        Sora.setBusy(btn, true, "Abrindo o Google…");
        intencao("oauth");
        const { error } = await c.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: "select_account" } }
        });
        if (error) { intencao(null); Sora.setBusy(btn, false); console.warn("[SORASAKI] Google:", error); Sora.toast("Não foi possível continuar com o Google agora. Tente novamente.", "error"); }
      };
    });

    function atualizarTravaLogin() {
      const btn = $("authLogin");
      const ate = travadoAte();
      if (!ate) { if (btn.dataset.travado) { delete btn.dataset.travado; btn.disabled = false; btn.textContent = "Entrar"; } return; }
      btn.dataset.travado = "1";
      btn.disabled = true;
      btn.textContent = `Aguarde ${Math.ceil((ate - Date.now()) / 1000)}s`;
      setTimeout(atualizarTravaLogin, 1000);
    }
    loginDrawer._atualizarTrava = atualizarTravaLogin;

    // Código de segurança por e-mail — a mesma arquitetura já usada nas
    // Configurações (security_email_codes + api/account-actions.js), agora
    // também para login e cadastro. purpose="login"/"signup" já sempre
    // exigem o código (não é mais opcional, ver api/account-actions.js).
    async function pedirCodigoEmailAuth(purpose) {
      const token = await getToken();
      return Sora.fetchJson("/api/account-actions?type=email-2fa-request", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ purpose }) });
    }
    async function confirmarCodigoEmailAuth(code) {
      const token = await getToken();
      return Sora.fetchJson("/api/account-actions?type=email-2fa-verify", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ code }) });
    }

    $("authLoginForm").onsubmit = async (e) => {
      e.preventDefault();
      const c = ensureClient();
      if (!c) return show("authResult", false, "Não foi possível acessar sua conta agora. Recarregue a página e tente novamente.");
      if (travadoAte()) { atualizarTravaLogin(); return show("authResult", false, "Muitas tentativas seguidas. Aguarde um pouco antes de tentar de novo."); }
      const email = $("authEmail").value.trim();
      const password = $("authPassword").value;
      if (!validEmail(email) || !password) return show("authResult", false, "Informe seu e-mail e sua senha.");
      const btn = $("authLogin");
      Sora.setBusy(btn, true, "Entrando…");
      show("authResult", null, "");
      try {
        const captchaToken = await captchaLogin.token();
        const { error } = await c.auth.signInWithPassword({ email, password, options: { captchaToken } });
        captchaLogin.reset();
        if (error) {
          const ate = error.code === "invalid_credentials" || /invalid login/i.test(error.message || "") ? registrarFalha() : 0;
          show("authResult", false, ate ? "E-mail ou senha incorretos. Por segurança, aguarde um pouco antes de tentar de novo." : traduzAuthError(error));
          return;
        }
        limparFalhas();
        $("authPassword").value = "";
        // Senha confirmada — agora o código por e-mail é obrigatório antes
        // de liberar a conta, sempre, não só pra quem ativou nas Configurações.
        $("loginCodeEmailLabel").textContent = email;
        tab("emailcode");
        setTimeout(() => $("loginEmailCode").focus(), 60);
        const r = await pedirCodigoEmailAuth("login");
        if (!r.ok || !r.body?.ok) show("emailCodeResult", false, r.body?.message || "Não conseguimos enviar o código agora. Tente reenviar em instantes.");
        else iniciarEspera($("authEmailCodeResend"), "logincode", 60, "Reenviar código");
      } catch (err) {
        console.error("[SORASAKI] Login:", err);
        show("authResult", false, traduzAuthError(err));
      } finally { Sora.setBusy(btn, false); atualizarTravaLogin(); }
    };

    $("authEmailCodeForm").onsubmit = async (e) => {
      e.preventDefault();
      const code = $("loginEmailCode").value.replace(/\D/g, "");
      if (code.length !== 6) return show("emailCodeResult", false, "Digite os 6 números do código.");
      const btn = $("authEmailCodeVerify");
      Sora.setBusy(btn, true, "Confirmando…");
      try {
        const r = await confirmarCodigoEmailAuth(code);
        if (!r.ok || !r.body?.ok) { $("loginEmailCode").value = ""; return show("emailCodeResult", false, r.body?.message || "Código incorreto. Confira e tente de novo."); }
        $("loginEmailCode").value = "";
        // Verificação em duas etapas por app autenticador (TOTP) continua
        // valendo por cima, se a pessoa tiver ativado.
        if (await mfaPendente()) { tab("mfa"); setTimeout(() => $("mfaCode").focus(), 60); return; }
        closeLogin();
        Sora.toast("Você entrou na sua conta.", "ok");
        runAfterAuth();
      } catch (err) { show("emailCodeResult", false, traduzAuthError(err)); }
      finally { Sora.setBusy(btn, false); }
    };
    $("authEmailCodeResend").onclick = async () => {
      if (esperaRestante("logincode")) return;
      const btn = $("authEmailCodeResend");
      Sora.setBusy(btn, true, "Reenviando…");
      try {
        const r = await pedirCodigoEmailAuth("login");
        if (!r.ok || !r.body?.ok) return show("emailCodeResult", false, r.body?.message || "Não conseguimos reenviar agora.");
        show("emailCodeResult", true, "Novo código enviado.");
      } catch (err) { show("emailCodeResult", false, traduzAuthError(err)); }
      finally { Sora.setBusy(btn, false); iniciarEspera(btn, "logincode", 60, "Reenviar código"); }
    };
    $("authEmailCodeCancel").onclick = async () => { closeLogin(true); await logout(); Sora.toast("Login cancelado."); };

    $("authMfaForm").onsubmit = async (e) => {
      e.preventDefault();
      const code = $("mfaCode").value.replace(/\D/g, "");
      if (code.length !== 6) return show("mfaResult", false, "Digite os 6 números do código.");
      const btn = $("authMfaVerify");
      Sora.setBusy(btn, true, "Confirmando…");
      try {
        const { error } = await confirmarCodigoMfa(code);
        if (error) { $("mfaCode").value = ""; return show("mfaResult", false, traduzAuthError(error)); }
        $("mfaCode").value = "";
        closeLogin(true);
        Sora.toast("Verificação confirmada.", "ok");
        runAfterAuth();
      } catch (err) { show("mfaResult", false, traduzAuthError(err)); }
      finally { Sora.setBusy(btn, false); }
    };
    $("authMfaCancel").onclick = async () => { closeLogin(true); await logout(); Sora.toast("Login cancelado."); };

    let pendingSignupEmail = "";
    $("authRegisterForm").onsubmit = async (e) => {
      e.preventDefault();
      const c = ensureClient();
      if (!c) return show("registerResult", false, "Não foi possível criar a conta agora. Recarregue a página e tente novamente.");
      const username = $("registerUsername").value.trim();
      const email = $("registerEmail").value.trim();
      const password = $("registerPassword").value;
      const confirm = $("registerConfirm").value;
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return show("registerResult", false, "O nome de usuário deve ter 3 a 24 caracteres, usando letras, números ou _.");
      if (!validEmail(email)) return show("registerResult", false, "Confira o e-mail digitado.");
      if (!senhaForte(password)) return show("registerResult", false, MSG_SENHA);
      if (password !== confirm) return show("registerResult", false, "As senhas não coincidem.");
      const btn = $("authRegister");
      Sora.setBusy(btn, true, "Criando conta…");
      show("registerResult", null, "");
      try {
        const captchaToken = await captchaLogin.token();
        intencao("signup");
        const { data, error } = await c.auth.signUp({
          email, password,
          options: { data: { username, display_name: username }, captchaToken }
        });
        captchaLogin.reset();
        if (error) { intencao(null); return show("registerResult", false, traduzAuthError(error)); }
        // Sem sessão de volta (ex.: se a confirmação nativa do Supabase por
        // algum motivo ainda estiver ligada nesse projeto)? Entra com a
        // própria senha recém-digitada só pra conseguir um token e pedir
        // nosso código — a conta continua só liberada depois do código.
        if (!data.session) {
          const { error: loginError } = await c.auth.signInWithPassword({ email, password });
          if (loginError) { intencao(null); return show("registerResult", false, traduzAuthError(loginError)); }
        }
        pendingSignupEmail = email;
        const r = await pedirCodigoEmailAuth("signup");
        if (!r.ok || !r.body?.ok) { intencao(null); return show("registerResult", false, r.body?.message || "Não conseguimos enviar o código de confirmação agora."); }
        $("signupEmailLabel").textContent = email;
        $("signupCodeArea").classList.remove("hidden");
        $("registerFormFields").classList.add("hidden");
        iniciarEspera($("authResendSignup"), "signup", 60, "Reenviar código");
        setTimeout(() => $("signupCode").focus(), 60);
      } catch (err) {
        console.error("[SORASAKI] Cadastro:", err);
        show("registerResult", false, traduzAuthError(err));
      } finally { Sora.setBusy(btn, false); }
    };

    $("authSignupCodeForm").onsubmit = async (e) => {
      e.preventDefault();
      const code = $("signupCode").value.replace(/\D/g, "");
      if (code.length !== 6) return show("signupResult", false, "Digite os 6 números do código.");
      const btn = $("authSignupVerify");
      Sora.setBusy(btn, true, "Confirmando…");
      try {
        const r = await confirmarCodigoEmailAuth(code);
        if (!r.ok || !r.body?.ok) { $("signupCode").value = ""; return show("signupResult", false, r.body?.message || "Código incorreto. Confira e tente de novo."); }
        intencao(null);
        closeLogin();
        Sora.toast("Conta criada. Bem-vindo ao Sorasaki!", "ok");
        runAfterAuth();
      } catch (err) { show("signupResult", false, traduzAuthError(err)); }
      finally { Sora.setBusy(btn, false); }
    };

    $("authResendSignup").onclick = async () => {
      if (!pendingSignupEmail) return show("signupResult", false, "Não foi possível reenviar agora. Tente criar a conta novamente.");
      if (esperaRestante("signup")) return;
      const btn = $("authResendSignup");
      Sora.setBusy(btn, true, "Reenviando…");
      try {
        const r = await pedirCodigoEmailAuth("signup");
        if (!r.ok || !r.body?.ok) return show("signupResult", false, r.body?.message || "Não conseguimos reenviar agora.");
        show("signupResult", true, "Novo código enviado.");
      } catch (err) { show("signupResult", false, traduzAuthError(err)); }
      finally { Sora.setBusy(btn, false); iniciarEspera(btn, "signup", 60, "Reenviar código"); }
    };

    $("authForgotForm").onsubmit = async (e) => {
      e.preventDefault();
      const email = $("forgotEmail").value.trim();
      if (!validEmail(email)) return show("forgotResult", false, "Informe o e-mail da conta.");
      const btn = $("authSendCode");
      if (esperaRestante("forgot")) return show("forgotResult", "info", "Aguarde alguns segundos antes de pedir outro código.");
      Sora.setBusy(btn, true, "Enviando…");
      try {
        const r = await Sora.fetchJson("/api/account-actions?type=password-reset-request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
        if (!r.ok) { show("forgotResult", false, r.body?.message || "Não foi possível enviar agora. Tente de novo em instantes."); return; }
        // Mesma resposta exista ou não a conta: não revela quais e-mails estão cadastrados.
        $("authCodeArea").classList.remove("hidden");
        show("forgotResult", true, r.body?.message || "Se existir uma conta com este e-mail, você vai receber um código em alguns minutos.");
        setTimeout(() => $("resetCode").focus(), 60);
      } catch (err) { show("forgotResult", false, traduzAuthError(err)); }
      finally { Sora.setBusy(btn, false); iniciarEspera(btn, "forgot", 60, "Enviar código"); }
    };

    $("authCodeArea").onsubmit = async (e) => {
      e.preventDefault();
      const email = $("forgotEmail").value.trim();
      const code = $("resetCode").value.replace(/\D/g, "");
      const password = $("resetPasswordCode").value;
      if (!email || code.length !== 6) return show("forgotResult", false, "Digite o código de 6 dígitos recebido.");
      if (!senhaForte(password)) return show("forgotResult", false, MSG_SENHA);
      const btn = $("authReset");
      Sora.setBusy(btn, true, "Salvando…");
      try {
        const r = await Sora.fetchJson("/api/account-actions?type=password-reset-confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, code, newPassword: password }) });
        if (!r.ok || !r.body?.ok) return show("forgotResult", false, r.body?.message || "Código inválido ou expirado. Peça um novo.");
        $("authCodeArea").reset();
        $("authCodeArea").classList.add("hidden");
        $("authEmail").value = email;
        tab("login");
        Sora.toast("Senha redefinida! Entre com sua nova senha.", "ok");
      } catch (err) { show("forgotResult", false, traduzAuthError(err)); }
      finally { Sora.setBusy(btn, false); }
    };

    $("authForgotResend").onclick = async () => {
      const email = $("forgotEmail").value.trim();
      if (!validEmail(email)) return show("forgotResult", false, "Informe o e-mail da conta.");
      if (esperaRestante("forgot")) return;
      const btn = $("authForgotResend");
      Sora.setBusy(btn, true, "Reenviando…");
      try {
        const r = await Sora.fetchJson("/api/account-actions?type=password-reset-request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
        show("forgotResult", r.ok, r.body?.message || "Se existir uma conta com este e-mail, você vai receber um código em alguns minutos.");
      } catch (err) { show("forgotResult", false, traduzAuthError(err)); }
      finally { Sora.setBusy(btn, false); iniciarEspera(btn, "forgot", 60, "Enviar código"); }
    };

    $("authNewPasswordForm").onsubmit = async (e) => {
      e.preventDefault();
      const c = ensureClient();
      const p1 = $("newPassword").value;
      const p2 = $("newPassword2").value;
      if (!c) return;
      if (!senhaForte(p1)) return show("resetResult", false, MSG_SENHA);
      if (p1 !== p2) return show("resetResult", false, "As senhas não coincidem.");
      const btn = $("authSaveNewPassword");
      Sora.setBusy(btn, true, "Salvando…");
      try {
        const { error } = await c.auth.updateUser({ password: p1 });
        if (error) return show("resetResult", false, traduzAuthError(error));
        $("authNewPasswordForm").reset();
        intencao(null);
        closeLogin();
        Sora.toast("Nova senha salva.", "ok");
      } catch (err) { show("resetResult", false, traduzAuthError(err)); }
      finally { Sora.setBusy(btn, false); }
    };
  }

  function openLogin(which = "login", message = "") {
    createLoginUI();
    if (!loginDrawer.classList.contains("is-open")) lastFocus = document.activeElement;
    loginDrawer._tab(which);
    if (which === "register") {
      loginDrawer.querySelector("#registerFormFields").classList.remove("hidden");
      loginDrawer.querySelector("#signupCodeArea").classList.add("hidden");
    }
    const box = loginDrawer.querySelector(which === "mfa" ? "#mfaResult" : which === "emailcode" ? "#emailCodeResult" : "#authResult");
    Sora.showResult(box, message ? "info" : "", message);
    loginDrawer._atualizarTrava();
    loginDrawer.classList.add("is-open");
    loginOverlay.classList.add("is-open");
    loginDrawer.setAttribute("aria-hidden", "false");
    document.body.classList.add("login-open");
    const foco = { login: "#authEmail", register: "#registerUsername", forgot: "#forgotEmail", reset: "#newPassword", mfa: "#mfaCode", emailcode: "#loginEmailCode" }[which];
    setTimeout(() => {
      const el = loginDrawer.querySelector(foco);
      // No celular, abrir o teclado sozinho atrapalha; só foca no desktop (e sempre no código de verificação).
      if (el && (which === "mfa" || which === "emailcode" || window.matchMedia("(hover: hover)").matches)) el.focus();
      else loginDrawer.querySelector(".login-close")?.focus({ preventScroll: true });
    }, 80);
  }
  function closeLogin(forcar) {
    if (!loginDrawer?.classList.contains("is-open")) return;
    // Fechar no meio da verificação em duas etapas encerra a sessão pela metade.
    if (forcar !== true && loginDrawer.dataset.panel === "mfa" && currentUser) {
      loginDrawer.querySelector("#authMfaCancel").click();
      return;
    }
    loginDrawer.classList.remove("is-open");
    loginOverlay.classList.remove("is-open");
    loginDrawer.setAttribute("aria-hidden", "true");
    document.body.classList.remove("login-open");
    lastFocus?.focus?.({ preventScroll: true });
  }

  /* ----- Perfil ----- */
  let profileModal = null;
  let profileOverlay = null;
  let captchaPerfil = null;
  let mfaEmAndamento = null;
  const CATEGORIAS = { vendas: "Compra e venda", comunidade: "Comunidade", jogos: "Jogos", freefire: "Free Fire", divulgacao: "Divulgação", amizades: "Amizades", suporte: "Suporte", estudos: "Estudos", outros: "Outros" };
  const STATUS_GRUPO = { pending: "Em análise", approved: "Publicada", rejected: "Recusada", removed: "Removida" };
  const NOME_PROVEDOR = { email: "E-mail e senha", google: "Google" };

  function provedores(user) {
    const lista = user?.app_metadata?.providers || (user?.identities || []).map((i) => i.provider);
    return [...new Set(lista || [])];
  }

  function createProfileUI() {
    if (profileModal) return;
    profileOverlay = document.createElement("div");
    profileOverlay.className = "sora-profile-overlay";
    profileModal = document.createElement("section");
    profileModal.className = "sora-profile-modal";
    profileModal.setAttribute("role", "dialog");
    profileModal.setAttribute("aria-modal", "true");
    profileModal.setAttribute("aria-labelledby", "profileTitle");
    profileModal.innerHTML = `
      <div class="profile-head"><div><span class="eyebrow">Sua conta</span><h2 id="profileTitle" style="margin-top:8px">Meu perfil</h2></div><button class="icon-btn profile-close" type="button" aria-label="Fechar">×</button></div>
      <div class="profile-card-main"><div class="profile-avatar" id="profileAvatar">S</div><div><strong id="profileUsername">@usuario</strong><span id="profileEmail"></span><span class="profile-status" id="profileStatus"></span></div></div>
      <div class="profile-grid">
        <div class="profile-info"><small>Último acesso</small><b id="profileLastLogin">—</b></div>
        <div class="profile-info"><small>Conta criada em</small><b id="profileCreated">—</b></div>
        <div class="profile-info"><small>Formas de entrar</small><b id="profileProviders">—</b></div>
        <div class="profile-info"><small>Duas etapas</small><b id="profileMfaInfo">—</b></div>
      </div>

      <div class="profile-section-title">Divulgações</div>
      <button class="profile-action" id="profileGroupsBtn" type="button" aria-expanded="false"><div><strong>Minhas divulgações</strong><small id="profileGroupsSummary">Carregando…</small></div><b aria-hidden="true">›</b></button>
      <div class="profile-groups-list hidden" id="profileGroups"></div>

      <div data-bot-platform hidden>
        <div class="profile-section-title">Bot no seu número</div>
        <a class="profile-action" href="/meu-bot"><div><strong>Conectar com bot</strong><small>Planos, conexão do número e controle dos grupos</small></div><b aria-hidden="true">›</b></a>
      </div>

      <div class="profile-section-title">Conta</div>
      <button class="profile-action" id="profileInfoBtn" type="button" aria-expanded="false"><div><strong>Nome de usuário</strong><small>Altere como você aparece no Sorasaki</small></div><b aria-hidden="true">›</b></button>
      <form class="profile-edit-form hidden" id="profileEditForm" novalidate>
        <label>Nome de usuário<input id="profileEditUsername" type="text" maxlength="24" autocomplete="username" autocapitalize="none" spellcheck="false"><span class="field-hint">3 a 24 caracteres: letras, números ou _</span></label>
        <div class="profile-form-actions"><button class="btn btn-sm" id="profileEditCancel" type="button">Cancelar</button><button class="btn btn-primary btn-sm" id="profileEditSave" type="submit">Salvar</button></div>
        <div class="auth-result" id="profileEditResult" aria-live="polite"></div>
      </form>
      <button class="profile-action" id="profileEmailBtn" type="button" aria-expanded="false"><div><strong>E-mail</strong><small>Troque o e-mail da conta com confirmação</small></div><b aria-hidden="true">›</b></button>
      <form class="profile-edit-form hidden" id="profileEmailForm" novalidate>
        <label>Novo e-mail<input id="profileNewEmail" type="email" inputmode="email" autocomplete="email"></label>
        <p class="field-hint">Enviamos um link de confirmação. Por segurança, o e-mail atual também pode receber um aviso para confirmar a troca.</p>
        <div class="profile-form-actions"><button class="btn btn-sm" data-close-form type="button">Cancelar</button><button class="btn btn-primary btn-sm" id="profileEmailSave" type="submit">Enviar confirmação</button></div>
        <div class="auth-result" id="profileEmailResult" aria-live="polite"></div>
      </form>

      <div class="profile-section-title">Segurança</div>
      <div class="protecao-nivel" id="profileProtectionLevel"></div>
      <button class="profile-action" id="profilePasswordBtn" type="button" aria-expanded="false"><div><strong id="profilePasswordTitle">Alterar senha</strong><small id="profilePasswordHint">Confirme a senha atual e escolha uma nova</small></div><b aria-hidden="true">›</b></button>
      <form class="profile-password-form hidden" id="profilePasswordForm" novalidate>
        <label id="profileCurrentWrap">Senha atual<input id="profileCurrentPassword" type="password" autocomplete="current-password"></label>
        <label>Nova senha<input id="profileNewPassword" type="password" autocomplete="new-password" minlength="8"></label>
        <label>Confirmar nova senha<input id="profileNewPassword2" type="password" autocomplete="new-password" minlength="8"></label>
        <label id="profileNonceWrap" class="hidden">Código enviado ao seu e-mail<input id="profileNonce" inputmode="numeric" autocomplete="one-time-code" maxlength="10"></label>
        <div class="turnstile-box" id="profileCaptcha"></div>
        <div class="profile-form-actions"><button class="btn btn-sm" id="profilePasswordCancel" type="button">Cancelar</button><button class="btn btn-primary btn-sm" id="profilePasswordSave" type="submit">Salvar senha</button></div>
        <div class="auth-result" id="profilePasswordResult" aria-live="polite"></div>
      </form>
      <button class="profile-action" id="profileMfaBtn" type="button" aria-expanded="false"><div><strong>Verificação em duas etapas</strong><small id="profileMfaHint">Proteja a conta com um código do app autenticador</small></div><b aria-hidden="true">›</b></button>
      <div class="profile-password-form hidden" id="profileMfaBox" aria-live="polite"></div>
      <button class="profile-action hidden" id="profileEmailMfaBtn" type="button" aria-expanded="false"><div><strong>Código de segurança por e-mail</strong><small id="profileEmailMfaHint">Receba um código no seu e-mail em ações sensíveis</small></div><b aria-hidden="true">›</b></button>
      <div class="profile-password-form hidden" id="profileEmailMfaBox" aria-live="polite"></div>
      <button class="profile-action" id="profileSessionsBtn" type="button" aria-expanded="false"><div><strong>Sessões</strong><small>Saia da conta em outros aparelhos</small></div><b aria-hidden="true">›</b></button>
      <div class="profile-password-form hidden" id="profileSessionsBox">
        <p class="field-hint">Use se você entrou em um aparelho que não é seu ou se desconfia de acesso indevido. Trocar a senha também é recomendado.</p>
        <div class="profile-form-actions"><button class="btn btn-sm" id="profileSignOutOthers" type="button">Sair dos outros aparelhos</button><button class="btn btn-sm btn-danger" id="profileSignOutAll" type="button">Sair de todos, inclusive este</button></div>
      </div>

      <div class="profile-section-title">Zona de cuidado</div>
      <button class="profile-action danger" id="profileDeleteBtn" type="button" aria-expanded="false"><div><strong>Excluir conta</strong><small>Apaga sua conta e suas divulgações. Não dá para desfazer.</small></div><b aria-hidden="true">›</b></button>
      <form class="profile-password-form hidden" id="profileDeleteForm" novalidate>
        <p class="field-hint">Isso remove seu perfil, divulgações, avaliações, relatos e imagens enviadas. Digite <b>EXCLUIR</b> para confirmar.</p>
        <label>Confirmação<input id="profileDeleteConfirm" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="EXCLUIR"></label>
        <div class="profile-form-actions"><button class="btn btn-sm" data-close-form type="button">Cancelar</button><button class="btn btn-sm btn-danger" id="profileDeleteSave" type="submit">Excluir minha conta</button></div>
        <div class="auth-result" id="profileDeleteResult" aria-live="polite"></div>
      </form>

      <button class="btn btn-ghost profile-logout" id="profileLogout" type="button">Sair da conta</button>`;
    document.body.append(profileOverlay, profileModal);
    captchaPerfil = SoraCaptcha.mount(profileModal.querySelector("#profileCaptcha"));

    const $ = (id) => profileModal.querySelector("#" + id);
    const pares = [["profileGroupsBtn", "profileGroups"], ["profileInfoBtn", "profileEditForm"], ["profileEmailBtn", "profileEmailForm"], ["profilePasswordBtn", "profilePasswordForm"], ["profileMfaBtn", "profileMfaBox"], ["profileEmailMfaBtn", "profileEmailMfaBox"], ["profileSessionsBtn", "profileSessionsBox"], ["profileDeleteBtn", "profileDeleteForm"]];
    const toggle = (btnId, formId, force) => {
      const form = $(formId);
      const abrir = force ?? form.classList.contains("hidden");
      form.classList.toggle("hidden", !abrir);
      $(btnId).setAttribute("aria-expanded", String(abrir));
      if (abrir && formId === "profileMfaBox") renderMfa();
      if (abrir && formId === "profileEmailMfaBox") renderEmailMfa();
    };
    pares.forEach(([b, f]) => { $(b).onclick = () => toggle(b, f); });
    profileModal.querySelectorAll("[data-close-form]").forEach((b) => {
      b.onclick = () => { const form = b.closest("form"); const par = pares.find(([, f]) => f === form.id); form.reset(); if (par) toggle(par[0], par[1], false); };
    });
    profileModal.querySelector(".profile-close").onclick = closeProfile;
    profileOverlay.onclick = closeProfile;
    $("profilePasswordCancel").onclick = () => { $("profilePasswordForm").reset(); $("profileNonceWrap").classList.add("hidden"); toggle("profilePasswordBtn", "profilePasswordForm", false); };
    $("profileEditCancel").onclick = () => toggle("profileInfoBtn", "profileEditForm", false);

    $("profilePasswordForm").onsubmit = async (e) => {
      e.preventDefault();
      const c = ensureClient(), user = getUser(), res = $("profilePasswordResult");
      if (!c || !user) return;
      const temSenha = provedores(user).includes("email");
      const current = $("profileCurrentPassword").value, p1 = $("profileNewPassword").value, p2 = $("profileNewPassword2").value;
      const nonce = $("profileNonce").value.trim();
      if ((temSenha && !current) || !p1 || !p2) return Sora.showResult(res, "error", "Preencha todos os campos.");
      if (!senhaForte(p1)) return Sora.showResult(res, "error", MSG_SENHA);
      if (p1 !== p2) return Sora.showResult(res, "error", "As novas senhas não coincidem.");
      const btn = $("profilePasswordSave");
      Sora.setBusy(btn, true, "Salvando…");
      try {
        if (temSenha && !nonce) {
          const captchaToken = await captchaPerfil.token();
          const { error: loginError } = await c.auth.signInWithPassword({ email: user.email, password: current, options: { captchaToken } });
          captchaPerfil.reset();
          if (loginError) return Sora.showResult(res, "error", /captcha/i.test(loginError.message || "") ? traduzAuthError(loginError) : "A senha atual está incorreta.");
        }
        const { error } = await c.auth.updateUser(nonce ? { password: p1, nonce } : { password: p1 });
        if (error && (error.code === "reauthentication_needed" || /reauthenticat/i.test(error.message || ""))) {
          await c.auth.reauthenticate();
          $("profileNonceWrap").classList.remove("hidden");
          return Sora.showResult(res, "info", "Por segurança, enviamos um código para o seu e-mail. Digite-o e salve de novo.");
        }
        if (error) return Sora.showResult(res, "error", traduzAuthError(error));
        $("profilePasswordForm").reset();
        $("profileNonceWrap").classList.add("hidden");
        Sora.showResult(res, "", "");
        toggle("profilePasswordBtn", "profilePasswordForm", false);
        Sora.toast(temSenha ? "Senha alterada." : "Senha criada. Agora você também pode entrar com e-mail e senha.", "ok");
        renderProfile();
      } catch (err) { Sora.showResult(res, "error", traduzAuthError(err)); }
      finally { Sora.setBusy(btn, false); }
    };

    $("profileEditForm").onsubmit = async (e) => {
      e.preventDefault();
      const c = ensureClient(), user = getUser(), res = $("profileEditResult");
      const username = $("profileEditUsername").value.trim();
      if (!c || !user) return;
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return Sora.showResult(res, "error", "Use 3 a 24 caracteres: letras, números ou _.");
      const btn = $("profileEditSave");
      Sora.setBusy(btn, true, "Salvando…");
      try {
        const { error } = await c.from("profiles").update({ username, display_name: username }).eq("user_id", user.id);
        if (error) {
          console.warn("[SORASAKI] Perfil:", error);
          return Sora.showResult(res, "error", error.code === "23505" ? "Esse nome de usuário já está em uso." : "Não foi possível salvar agora. Tente novamente.");
        }
        c.auth.updateUser({ data: { username, display_name: username } }).catch(() => {});
        Sora.showResult(res, "", "");
        toggle("profileInfoBtn", "profileEditForm", false);
        Sora.toast("Nome de usuário atualizado.", "ok");
        await renderProfile();
      } catch (err) { Sora.showResult(res, "error", Sora.friendlyError(err)); }
      finally { Sora.setBusy(btn, false); }
    };

    $("profileEmailForm").onsubmit = async (e) => {
      e.preventDefault();
      const c = ensureClient(), user = getUser(), res = $("profileEmailResult");
      const email = $("profileNewEmail").value.trim();
      if (!c || !user) return;
      if (!validEmail(email)) return Sora.showResult(res, "error", "Confira o e-mail digitado.");
      if (email.toLowerCase() === String(user.email || "").toLowerCase()) return Sora.showResult(res, "error", "Esse já é o e-mail da sua conta.");
      if (esperaRestante("email")) return Sora.showResult(res, "info", "Aguarde alguns segundos antes de pedir outra confirmação.");
      const btn = $("profileEmailSave");
      Sora.setBusy(btn, true, "Enviando…");
      try {
        intencao("email_change");
        const { error } = await c.auth.updateUser({ email }, { emailRedirectTo: location.origin + "/" });
        if (error) { intencao(null); return Sora.showResult(res, "error", traduzAuthError(error)); }
        Sora.showResult(res, "ok", "Pronto. Abra o link que enviamos para confirmar a troca — até lá, continua valendo o e-mail atual.");
      } catch (err) { Sora.showResult(res, "error", traduzAuthError(err)); }
      finally { Sora.setBusy(btn, false); iniciarEspera(btn, "email", 60, "Enviar confirmação"); }
    };

    $("profileSignOutOthers").onclick = async (ev) => {
      const btn = ev.currentTarget;
      if (!Sora.confirmTap(btn, "Toque de novo para confirmar")) return;
      Sora.setBusy(btn, true, "Encerrando…");
      try {
        const { error } = await ensureClient().auth.signOut({ scope: "others" });
        if (error) throw error;
        Sora.toast("Sessões em outros aparelhos encerradas.", "ok");
      } catch (err) { Sora.toast(traduzAuthError(err), "error"); }
      finally { Sora.setBusy(btn, false); }
    };
    $("profileSignOutAll").onclick = async (ev) => {
      const btn = ev.currentTarget;
      if (!Sora.confirmTap(btn, "Toque de novo para sair de todos")) return;
      Sora.setBusy(btn, true, "Saindo…");
      await logout("global");
      Sora.setBusy(btn, false);
      closeProfile();
      Sora.toast("Você saiu da conta em todos os aparelhos.");
    };

    $("profileDeleteForm").onsubmit = async (e) => {
      e.preventDefault();
      const res = $("profileDeleteResult");
      if ($("profileDeleteConfirm").value.trim().toUpperCase() !== "EXCLUIR") return Sora.showResult(res, "error", "Digite EXCLUIR para confirmar.");
      const btn = $("profileDeleteSave");
      Sora.setBusy(btn, true, "Excluindo…");
      try {
        const token = await getToken();
        const r = await Sora.fetchJson("/api/account-actions?type=delete-account", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: "delete", confirm: "EXCLUIR" }) }, 20000);
        if (!r.ok || !r.body?.ok) {
          if (r.body?.code === "mfa_required") { closeProfile(); openLogin("mfa", "Confirme o código para continuar."); return; }
          return Sora.showResult(res, "error", r.body?.message || "Não foi possível excluir a conta agora. Tente novamente.");
        }
        try { await ensureClient().auth.signOut({ scope: "local" }); } catch {}
        currentUser = null;
        notify("SIGNED_OUT");
        closeProfile();
        Sora.toast("Sua conta foi excluída. Sentiremos sua falta.", "ok", 6000);
      } catch (err) { Sora.showResult(res, "error", Sora.friendlyError(err)); }
      finally { Sora.setBusy(btn, false); }
    };

    $("profileLogout").onclick = async (ev) => {
      const btn = ev.currentTarget;
      if (!Sora.confirmTap(btn, "Toque de novo para sair")) return;
      Sora.setBusy(btn, true, "Saindo…");
      await logout();
      Sora.setBusy(btn, false);
      closeProfile();
      Sora.toast("Você saiu da conta.");
    };
  }

  // Nível de proteção da conta: sempre calculado a partir do que o Supabase
  // realmente confirma (fatores de MFA verificados), nunca de algo salvo no
  // navegador — então não dá pra falsificar mudando localStorage.
  // metodosAtivos hoje só pode ser 0 ou 1 (só temos o autenticador TOTP);
  // a estrutura já está pronta pra somar outros métodos (ex.: código por
  // e-mail) quando existirem, sem precisar mudar essa função.
  function renderNivelProtecao(box, metodosAtivos) {
    if (!box) return;
    const niveis = [
      { min: 0, emoji: "🟢", nome: "Proteção básica", cor: "var(--ok, #4ade80)" },
      { min: 1, emoji: "🔵", nome: "Protegida", cor: "#5b8def" },
      { min: 2, emoji: "🟣", nome: "Muito protegida", cor: "var(--accent)" },
      { min: 3, emoji: "🔥", nome: "Proteção máxima", cor: "#ff8a4c" }
    ];
    const nivel = [...niveis].reverse().find((n) => metodosAtivos >= n.min) || niveis[0];
    const pct = Math.round((metodosAtivos / 3) * 100);
    box.innerHTML = `
      <div class="protecao-topo"><span>${nivel.emoji} ${nivel.nome}</span><span class="protecao-pct">${pct}%</span></div>
      <div class="protecao-barra"><div class="protecao-barra-fill" style="width:${pct}%;background:${nivel.cor}"></div></div>
      <p class="field-hint">${metodosAtivos > 0 ? "Isso deixa sua conta bem mais difícil de invadir." : "Ative o aplicativo autenticador abaixo pra deixar sua conta mais protegida."}</p>`;
  }

  // Tela de verificação em duas etapas dentro do perfil: ativar, confirmar e desativar.
  async function renderMfa() {
    const box = profileModal.querySelector("#profileMfaBox");
    const c = ensureClient();
    box.innerHTML = '<div class="skeleton" style="height:48px"></div>';
    try {
      const { data, error } = await c.auth.mfa.listFactors();
      if (error) throw error;
      const verificado = (data?.totp || []).find((f) => f.status === "verified");
      if (verificado) {
        box.innerHTML = `<p><b>Ativada.</b> Ao entrar, pedimos o código do seu app autenticador.</p>
          <form id="mfaOffForm" novalidate><label>Para desativar, digite um código atual<input id="mfaOffCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></label>
          <div class="profile-form-actions"><button class="btn btn-sm btn-danger" type="submit" id="mfaOffBtn">Desativar</button></div><div class="auth-result" id="mfaOffResult" aria-live="polite"></div></form>`;
        box.querySelector("#mfaOffForm").onsubmit = async (e) => {
          e.preventDefault();
          const res = box.querySelector("#mfaOffResult");
          const code = box.querySelector("#mfaOffCode").value.replace(/\D/g, "");
          if (code.length !== 6) return Sora.showResult(res, "error", "Digite os 6 números do código.");
          const btn = box.querySelector("#mfaOffBtn");
          Sora.setBusy(btn, true, "Desativando…");
          try {
            const v = await c.auth.mfa.challengeAndVerify({ factorId: verificado.id, code });
            if (v.error) return Sora.showResult(res, "error", traduzAuthError(v.error));
            const { error: ue } = await c.auth.mfa.unenroll({ factorId: verificado.id });
            if (ue) return Sora.showResult(res, "error", traduzAuthError(ue));
            await c.auth.refreshSession().catch(() => {});
            Sora.toast("Verificação em duas etapas desativada.", "ok");
            renderProfile();
            renderMfa();
          } catch (err) { Sora.showResult(res, "error", traduzAuthError(err)); }
          finally { Sora.setBusy(btn, false); }
        };
        return;
      }
      // Remove tentativas de ativação abandonadas antes de começar outra.
      for (const f of data?.all || []) if (f.status === "unverified") await c.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
      box.innerHTML = `<p>Com a verificação ativada, além da senha (ou do Google), o Sorasaki pede um código de 6 dígitos gerado pelo seu celular. <b>Recomendado para a equipe.</b></p>
        <div class="profile-form-actions"><button class="btn btn-primary btn-sm" type="button" id="mfaStartBtn">Ativar verificação</button></div><div class="auth-result" id="mfaStartResult" aria-live="polite"></div>`;
      box.querySelector("#mfaStartBtn").onclick = async (ev) => {
        const btn = ev.currentTarget;
        Sora.setBusy(btn, true, "Preparando…");
        try {
          const { data: en, error: ee } = await c.auth.mfa.enroll({ factorType: "totp", friendlyName: `Sorasaki ${new Date().toISOString().slice(0, 16)}` });
          if (ee) throw ee;
          mfaEmAndamento = en.id;
          const qr = String(en.totp?.qr_code || "");
          box.innerHTML = `<p>1. No app autenticador, escaneie o QR code (ou digite a chave).</p>
            <div class="mfa-qr">${qr.startsWith("data:image/") ? `<img src="${escapeHtml(qr)}" alt="QR code para o app autenticador" width="180" height="180">` : ""}</div>
            <p class="field-hint">Chave: <code class="mfa-secret">${escapeHtml(en.totp?.secret || "")}</code></p>
            <form id="mfaVerifyForm" novalidate><label>2. Digite o código que aparece no app<input id="mfaVerifyCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></label>
            <div class="profile-form-actions"><button class="btn btn-sm" type="button" id="mfaAbort">Cancelar</button><button class="btn btn-primary btn-sm" type="submit" id="mfaVerifyBtn">Confirmar e ativar</button></div><div class="auth-result" id="mfaVerifyResult" aria-live="polite"></div></form>`;
          box.querySelector("#mfaAbort").onclick = async () => { await c.auth.mfa.unenroll({ factorId: mfaEmAndamento }).catch(() => {}); mfaEmAndamento = null; renderMfa(); };
          box.querySelector("#mfaVerifyForm").onsubmit = async (e) => {
            e.preventDefault();
            const res = box.querySelector("#mfaVerifyResult");
            const code = box.querySelector("#mfaVerifyCode").value.replace(/\D/g, "");
            if (code.length !== 6) return Sora.showResult(res, "error", "Digite os 6 números do código.");
            const vb = box.querySelector("#mfaVerifyBtn");
            Sora.setBusy(vb, true, "Confirmando…");
            try {
              const { error: ve } = await c.auth.mfa.challengeAndVerify({ factorId: mfaEmAndamento, code });
              if (ve) return Sora.showResult(res, "error", traduzAuthError(ve));
              mfaEmAndamento = null;
              Sora.toast("Verificação em duas etapas ativada.", "ok");
              renderProfile();
              renderMfa();
            } catch (err) { Sora.showResult(res, "error", traduzAuthError(err)); }
            finally { Sora.setBusy(vb, false); }
          };
        } catch (err) {
          console.warn("[SORASAKI] Ativar duas etapas:", err);
          Sora.showResult(box.querySelector("#mfaStartResult"), "error", /disabled|not enabled/i.test(err?.message || "") ? "A verificação em duas etapas ainda não está habilitada no sistema. Fale com a equipe." : traduzAuthError(err));
          Sora.setBusy(btn, false);
        }
      };
    } catch (err) {
      console.warn("[SORASAKI] Duas etapas:", err);
      box.innerHTML = '<p class="field-hint">Não foi possível carregar esta opção agora. Tente novamente em instantes.</p>';
    }
  }

  // Código de segurança por e-mail: um segundo método de 2FA, independente
  // do TOTP, enviado pelo próprio backend do Sorasaki via SMTP direto (ver
  // api/_mailer.js) — não depende do sistema de e-mail do Supabase Auth.
  async function renderEmailMfa() {
    const box = profileModal.querySelector("#profileEmailMfaBox");
    const user = getUser(), c = ensureClient();
    box.innerHTML = '<div class="skeleton" style="height:48px"></div>';
    let ativo = false;
    try {
      const { data } = await c.from("profiles").select("email_mfa_enabled").eq("user_id", user.id).maybeSingle();
      ativo = Boolean(data?.email_mfa_enabled);
    } catch (err) { console.warn("[SORASAKI] Código por e-mail:", err); }

    async function pedirCodigo(purpose, btn) {
      Sora.setBusy(btn, true, "Enviando…");
      try {
        const token = await getToken();
        const r = await Sora.fetchJson("/api/account-actions?type=email-2fa-request", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ purpose }) });
        Sora.setBusy(btn, false);
        if (!r.ok || !r.body?.ok) { Sora.toast(r.body?.message || "Não conseguimos enviar o código agora.", "error"); return false; }
        Sora.toast(r.body.message, "ok");
        return true;
      } catch (err) { Sora.setBusy(btn, false); Sora.toast(traduzAuthError(err), "error"); return false; }
    }
    async function confirmarCodigo(code) {
      const token = await getToken();
      return Sora.fetchJson("/api/account-actions?type=email-2fa-verify", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ code }) });
    }

    if (ativo) {
      box.innerHTML = `<p><b>Ativado.</b> A gente pede esse código em ações sensíveis da sua conta.</p>
        <button class="btn btn-sm" id="emailMfaSendDisable" type="button">Desativar</button>
        <form id="emailMfaDisableForm" class="hidden" novalidate>
          <label>Código enviado ao seu e-mail<input id="emailMfaDisableCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></label>
          <div class="profile-form-actions"><button class="btn btn-sm btn-danger" type="submit">Confirmar desativação</button></div>
          <div class="auth-result" id="emailMfaDisableResult" aria-live="polite"></div>
        </form>`;
      box.querySelector("#emailMfaSendDisable").onclick = async (e) => {
        if (await pedirCodigo("disable", e.currentTarget)) box.querySelector("#emailMfaDisableForm").classList.remove("hidden");
      };
      box.querySelector("#emailMfaDisableForm").onsubmit = async (e) => {
        e.preventDefault();
        const res = box.querySelector("#emailMfaDisableResult");
        const code = box.querySelector("#emailMfaDisableCode").value.replace(/\D/g, "");
        if (code.length !== 6) return Sora.showResult(res, "error", "Digite os 6 números do código.");
        const btn = e.target.querySelector("button[type=submit]");
        Sora.setBusy(btn, true, "Confirmando…");
        const r = await confirmarCodigo(code);
        Sora.setBusy(btn, false);
        if (!r.ok || !r.body?.ok) return Sora.showResult(res, "error", r.body?.message || "Código incorreto.");
        Sora.toast(r.body.message, "ok");
        renderProfile(); renderEmailMfa();
      };
    } else {
      box.innerHTML = `<p>Receba um código no seu e-mail sempre que precisar confirmar uma ação sensível — funciona junto com o app autenticador, se você já usa um.</p>
        <button class="btn btn-primary btn-sm" id="emailMfaSendEnroll" type="button">Ativar por e-mail</button>
        <form id="emailMfaEnrollForm" class="hidden" novalidate>
          <label>Código enviado ao seu e-mail<input id="emailMfaEnrollCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"></label>
          <div class="profile-form-actions"><button class="btn btn-primary btn-sm" type="submit">Confirmar</button></div>
          <div class="auth-result" id="emailMfaEnrollResult" aria-live="polite"></div>
        </form>`;
      box.querySelector("#emailMfaSendEnroll").onclick = async (e) => {
        if (await pedirCodigo("enroll", e.currentTarget)) box.querySelector("#emailMfaEnrollForm").classList.remove("hidden");
      };
      box.querySelector("#emailMfaEnrollForm").onsubmit = async (e) => {
        e.preventDefault();
        const res = box.querySelector("#emailMfaEnrollResult");
        const code = box.querySelector("#emailMfaEnrollCode").value.replace(/\D/g, "");
        if (code.length !== 6) return Sora.showResult(res, "error", "Digite os 6 números do código.");
        const btn = e.target.querySelector("button[type=submit]");
        Sora.setBusy(btn, true, "Confirmando…");
        const r = await confirmarCodigo(code);
        Sora.setBusy(btn, false);
        if (!r.ok || !r.body?.ok) return Sora.showResult(res, "error", r.body?.message || "Código incorreto.");
        Sora.toast(r.body.message, "ok");
        renderProfile(); renderEmailMfa();
      };
    }
  }

  async function renderProfile() {
    const user = getUser(), c = ensureClient();
    if (!user || !c || !profileModal) return;
    const $ = (id) => profileModal.querySelector("#" + id);
    let perfil = null;
    try {
      const { data, error } = await c.from("profiles").select("username,display_name,created_at").eq("user_id", user.id).maybeSingle();
      if (error) console.warn("[SORASAKI] Perfil:", error); else perfil = data;
    } catch (e) { console.warn("[SORASAKI] Perfil:", e); }
    const username = perfil?.username || user.user_metadata?.username || user.email?.split("@")[0] || "usuario";
    const confirmado = Boolean(user.email_confirmed_at);
    const provs = provedores(user);
    const temSenha = provs.includes("email");
    $("profileAvatar").textContent = Sora.initials(username);
    $("profileUsername").textContent = "@" + username;
    $("profileEmail").textContent = user.email || "";
    $("profileStatus").textContent = confirmado ? "E-mail confirmado" : "E-mail aguardando confirmação";
    $("profileStatus").classList.toggle("pending", !confirmado);
    $("profileLastLogin").textContent = user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";
    $("profileCreated").textContent = fmtData(perfil?.created_at || user.created_at);
    $("profileProviders").textContent = provs.map((p) => NOME_PROVEDOR[p] || p).join(", ") || "E-mail";
    $("profileEditUsername").value = username;
    $("profileCurrentWrap").classList.toggle("hidden", !temSenha);
    $("profilePasswordTitle").textContent = temSenha ? "Alterar senha" : "Criar senha";
    $("profilePasswordHint").textContent = temSenha ? "Confirme a senha atual e escolha uma nova" : "Para entrar também com e-mail e senha, além do Google";
    try {
      const { data } = await c.auth.mfa.listFactors();
      const ativo = (data?.totp || []).some((f) => f.status === "verified");
      $("profileMfaInfo").textContent = ativo ? "Ativada" : "Desativada";
      $("profileMfaHint").textContent = ativo ? "Ativada — pedimos um código ao entrar" : "Proteja a conta com um código do app autenticador";
      let emailMfaAtivo = false;
      try {
        const { data: perfilSeg } = await c.from("profiles").select("email_mfa_enabled").eq("user_id", user.id).maybeSingle();
        emailMfaAtivo = Boolean(perfilSeg?.email_mfa_enabled);
      } catch {}
      $("profileEmailMfaHint").textContent = emailMfaAtivo ? "Ativado — pedimos um código em ações sensíveis" : "Receba um código no seu e-mail em ações sensíveis";
      renderNivelProtecao($("profileProtectionLevel"), (ativo ? 1 : 0) + (emailMfaAtivo ? 1 : 0));
    } catch { $("profileMfaInfo").textContent = "—"; renderNivelProtecao($("profileProtectionLevel"), 0); }

    const list = $("profileGroups");
    const summary = $("profileGroupsSummary");
    try {
      const { data, error } = await c.from("groups").select("id,name,category,status,view_count,created_at").eq("owner_id", user.id).order("created_at", { ascending: false }).limit(30);
      if (error) throw error;
      const rows = data || [];
      summary.textContent = rows.length ? `${rows.length} ${rows.length === 1 ? "divulgação enviada" : "divulgações enviadas"}` : "Nenhuma divulgação ainda";
      list.innerHTML = rows.map((g) => `
        <div class="profile-group-row">
          <div><strong>${escapeHtml(g.name)}</strong><small><span class="status-badge ${escapeHtml(g.status)}">${STATUS_GRUPO[g.status] || escapeHtml(g.status)}</span>${escapeHtml(CATEGORIAS[g.category] || g.category)} · ${fmtNumero(g.view_count || 0)} visualizações</small></div>
          <div class="profile-group-actions"><a class="btn btn-sm" href="/grupos?editar=${Number(g.id)}">Editar</a><button class="btn btn-sm btn-danger" type="button" data-profile-delete="${Number(g.id)}">Remover</button></div>
        </div>`).join("") || '<div class="profile-groups-empty">Você ainda não enviou nenhuma divulgação. <a class="text-link" href="/grupos#divulgar">Divulgar agora</a></div>';
      list.querySelectorAll("[data-profile-delete]").forEach((b) => {
        b.onclick = async () => {
          if (!Sora.confirmTap(b, "Confirmar")) return;
          Sora.setBusy(b, true);
          const { error: delError } = await c.from("groups").delete().eq("id", Number(b.dataset.profileDelete)).eq("owner_id", user.id);
          if (delError) { console.warn("[SORASAKI] Remover divulgação:", delError); Sora.setBusy(b, false); Sora.toast("Não foi possível remover a divulgação. Tente novamente.", "error"); return; }
          Sora.toast("Divulgação removida.", "ok");
          document.dispatchEvent(new CustomEvent("sorasaki:groups-changed"));
          renderProfile();
        };
      });
    } catch (e) {
      console.warn("[SORASAKI] Divulgações do perfil:", e);
      summary.textContent = "Não foi possível carregar agora";
      list.innerHTML = '<div class="profile-groups-empty">Não foi possível carregar suas divulgações. Tente novamente em instantes.</div>';
    }
  }

  function openProfile() {
    if (!getUser()) { openLogin("login"); return; }
    createProfileUI();
    revelarAtalhosDoBot();
    lastFocus = document.activeElement;
    profileModal.classList.add("is-open");
    profileOverlay.classList.add("is-open");
    document.body.classList.add("profile-open");
    setTimeout(() => profileModal.querySelector(".profile-close")?.focus(), 60);
    renderProfile();
  }
  function closeProfile() {
    if (!profileModal?.classList.contains("is-open")) return;
    profileModal.classList.remove("is-open");
    profileOverlay.classList.remove("is-open");
    document.body.classList.remove("profile-open");
    lastFocus?.focus?.({ preventScroll: true });
  }

  function updateAuthUI() {
    const user = getUser();
    document.querySelectorAll(".sora-login-trigger").forEach((btn) => {
      btn.classList.toggle("logged", Boolean(user));
      const nome = user?.user_metadata?.username || user?.email?.split("@")[0] || "";
      const label = btn.querySelector(".login-trigger-label");
      const avatar = btn.querySelector(".login-avatar");
      if (label) label.textContent = user ? "Perfil" : "Entrar";
      if (avatar) avatar.textContent = user ? Sora.initials(nome) : "";
      btn.setAttribute("aria-label", user ? "Abrir meu perfil" : "Entrar ou criar conta");
    });
    document.querySelectorAll("[data-auth-required]").forEach((el) => el.classList.toggle("auth-locked", !user));
    document.querySelectorAll("[data-when-logged]").forEach((el) => { el.hidden = !user; });
    document.querySelectorAll("[data-when-guest]").forEach((el) => { el.hidden = Boolean(user); });
  }

  window.SorasakiAuth = {
    getUser, getToken, ready, logout, clear: logout, setAfterAuth, onAuthChange, getClient: ensureClient,
    mfaLevel: nivelMfa, mfaPending: mfaPendente,
    open: (which = "login", message = "") => openLogin(typeof which === "string" ? which : "login", message),
    close: closeLogin,
    openProfile, closeProfile,
    requireLogin(msg = "Entre na sua conta para continuar.") {
      if (getUser()) return true;
      openLogin("login", msg);
      return false;
    }
  };

  function init() {
    document.querySelectorAll(".sora-login-trigger").forEach((btn) => {
      btn.addEventListener("click", () => (getUser() ? openProfile() : openLogin("login")));
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeLogin(); closeProfile(); } });
    syncSession();
  }
  window.SorasakiAuth._init = init;
})();

/* ===== 5. Manutenção, visitas e preferências ===== */
const SORA_PREFS = {
  get(key, fallback) { try { return localStorage.getItem("sorasaki_pref_" + key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem("sorasaki_pref_" + key, value); } catch {} }
};
if (SORA_PREFS.get("motion", "auto") === "reduce") document.documentElement.classList.add("reduce-motion");

async function instalarGuardaDeManutencao() {
  // O middleware já bloqueia no servidor; isto cobre páginas em cache.
  if (caminhoAtual() === "/controle-8f4c2e91") return false;
  const state = await Sora.siteState();
  if (!state?.maintenance) return false;
  if (state.start_at) { const start = new Date(state.start_at).getTime(); if (!Number.isNaN(start) && Date.now() < start) return false; }
  if (document.getElementById("sorasakiMaintenance")) return true;
  const overlay = document.createElement("div");
  overlay.id = "sorasakiMaintenance";
  overlay.className = "sorasaki-maintenance";
  const card = document.createElement("section");
  card.className = "sorasaki-maintenance-card";
  const visual = document.createElement("div");
  visual.className = "sorasaki-maintenance-visual";
  const img = document.createElement("img");
  img.src = "/img/sorasaki-manutencao.webp";
  img.alt = "";
  visual.appendChild(img);
  const title = document.createElement("h1");
  title.textContent = state.title || "Estamos em manutenção";
  const message = document.createElement("p");
  message.textContent = state.message || "Estamos fazendo algumas melhorias. Voltamos em breve.";
  card.append(visual, title, message);
  if (state.return_at) {
    const d = new Date(state.return_at);
    if (!Number.isNaN(d.getTime())) {
      const eta = document.createElement("div");
      eta.className = "sorasaki-maintenance-return";
      eta.textContent = `Previsão de retorno: ${d.toLocaleString("pt-BR", { dateStyle: "medium", timeStyle: "short" })}`;
      card.appendChild(eta);
    }
  }
  const thanks = document.createElement("div");
  thanks.className = "sorasaki-maintenance-thanks";
  thanks.textContent = "Obrigado pela paciência.";
  card.appendChild(thanks);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  document.documentElement.classList.add("maintenance-active");
  return true;
}

function registrarVisita() {
  const path = caminhoAtual();
  if (path === "/controle-8f4c2e91" || path.startsWith("/api/")) return;
  try {
    let id = localStorage.getItem("sorasaki_visitor_id");
    if (!id || !/^[A-Za-z0-9_-]{20,120}$/.test(id)) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "_");
      localStorage.setItem("sorasaki_visitor_id", id);
    }
    fetch("/api/account-actions?type=site-analytics", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visitor_id: id, path }) }).catch(() => {});
  } catch {}
}

// Entrada suave de blocos marcados com data-reveal.
function ligarRevelacao() {
  const alvos = document.querySelectorAll("[data-reveal]");
  if (!alvos.length || !("IntersectionObserver" in window) || document.documentElement.classList.contains("reduce-motion")) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("is-visible"); io.unobserve(en.target); } });
  }, { rootMargin: "0px 0px -8% 0px", threshold: .08 });
  alvos.forEach((el) => {
    if (el.getBoundingClientRect().top < window.innerHeight) return; // já visível: não anima
    el.classList.add("reveal");
    io.observe(el);
  });
}

// Borboleta roxa — detalhe de identidade do Sorasaki.
// Desenhada em SVG (leve e nítida em qualquer tela): as asas batem por CSS e
// o voo usa offset-path com a Web Animations API. Às vezes ela pousa por
// alguns segundos num canto decorativo da página e segue viagem.
// Nunca bloqueia cliques (pointer-events: none), fica escondida para leitores
// de tela, pausa com a aba em segundo plano e não aparece com "reduzir movimento".
function motionReduzido() {
  return document.documentElement.classList.contains("reduce-motion") || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const SORA_BORBOLETA_SVG = `<svg viewBox="0 0 64 48" class="sb-svg" aria-hidden="true" focusable="false">
  <g class="sb-asa sb-esq">
    <path d="M31 23C24 8 11 1 4.5 6.5 0 10.5 3 19 12 22.5c6 2.3 13 2.2 19 1.2Z" fill="url(#sbGradA)"/>
    <path d="M31 26c-8 .8-17 5-18.5 11.5-1.2 5.5 5 8.5 10.5 4.5 4.5-3.3 7-10 8-16Z" fill="url(#sbGradB)"/>
    <path d="M28 21C21 11 13 7 8 8.5" stroke="#f5e9ff" stroke-opacity=".35" stroke-width=".7" fill="none"/>
  </g>
  <g class="sb-asa sb-dir">
    <path d="M33 23C40 8 53 1 59.5 6.5 64 10.5 61 19 52 22.5c-6 2.3-13 2.2-19 1.2Z" fill="url(#sbGradA)"/>
    <path d="M33 26c8 .8 17 5 18.5 11.5 1.2 5.5-5 8.5-10.5 4.5-4.5-3.3-7-10-8-16Z" fill="url(#sbGradB)"/>
    <path d="M36 21c7-10 15-14 20-12.5" stroke="#f5e9ff" stroke-opacity=".35" stroke-width=".7" fill="none"/>
  </g>
  <path d="M32 15.5c1.3 2 1.4 17.5 0 21.5-1.4-4-1.3-19.5 0-21.5Z" fill="#2a0f55"/>
  <path d="M32 16c-1.3-4-3.4-6.6-5.8-7.8M32 16c1.3-4 3.4-6.6 5.8-7.8" stroke="#d8b4fe" stroke-width=".8" stroke-linecap="round" fill="none"/>
</svg>`;

function criarBorboleta() {
  if (motionReduzido()) return;
  if (!window.CSS || !CSS.supports("offset-path", "path('M0 0')") || !Element.prototype.animate) return;
  if (caminhoAtual() === "/controle-8f4c2e91") return;

  const camada = document.createElement("div");
  camada.className = "sora-borboleta-camada";
  camada.setAttribute("aria-hidden", "true");
  // Gradientes definidos uma vez e reaproveitados por todas as borboletas.
  camada.innerHTML = `<svg width="0" height="0" style="position:absolute"><defs>
    <linearGradient id="sbGradA" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f0e2ff"/><stop offset=".38" stop-color="#b57bff"/><stop offset="1" stop-color="#6d28d9"/></linearGradient>
    <linearGradient id="sbGradB" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c79bff"/><stop offset="1" stop-color="#5b21b6"/></linearGradient>
  </defs></svg>`;
  document.body.appendChild(camada);

  const pequena = window.matchMedia("(max-width: 640px)").matches;
  const w = () => window.innerWidth;
  const h = () => window.innerHeight;
  const rnd = (a, b) => a + Math.random() * (b - a);

  // Lugares onde ela pode pousar: cantos de elementos decorativos visíveis,
  // nunca em cima de texto ou botões.
  function pontoDePouso() {
    const alvos = [...document.querySelectorAll(".home-hero-art, .split-hero .art, .brand-mark")];
    for (const el of alvos.sort(() => Math.random() - 0.5)) {
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.bottom < 40 || r.top > h() - 60 || r.right < 0 || r.left > w()) continue;
      if (el.classList.contains("brand-mark")) return { x: r.right + 6, y: r.top - 6 };
      return { x: r.right - rnd(40, 90), y: Math.max(70, r.top + rnd(8, 40)) };
    }
    return null;
  }

  function curva(x0, y0, x1, y1) {
    const c1x = x0 + (x1 - x0) * rnd(0.2, 0.4), c2x = x0 + (x1 - x0) * rnd(0.6, 0.8);
    const c1y = rnd(h() * 0.05, h() * 0.8), c2y = rnd(h() * 0.05, h() * 0.8);
    return `path('M ${x0.toFixed(0)} ${y0.toFixed(0)} C ${c1x.toFixed(0)} ${c1y.toFixed(0)}, ${c2x.toFixed(0)} ${c2y.toFixed(0)}, ${x1.toFixed(0)} ${y1.toFixed(0)}')`;
  }

  function voar(el, path, duracao, { entrar = false, sair = false } = {}) {
    el.style.offsetPath = path;
    const quadros = [
      { offsetDistance: "0%", opacity: entrar ? 0 : 1 },
      { offsetDistance: "8%", opacity: 1 },
      { offsetDistance: "92%", opacity: 1 },
      { offsetDistance: "100%", opacity: sair ? 0 : 1 }
    ];
    return el.animate(quadros, { duration: duracao, easing: "cubic-bezier(.45,.05,.55,.95)", fill: "forwards" }).finished;
  }

  async function viagem(tamanho) {
    const el = document.createElement("div");
    el.className = `sora-borboleta ${tamanho}`;
    el.innerHTML = `<div class="sb-bob">${SORA_BORBOLETA_SVG}</div>`;
    camada.appendChild(el);
    const daEsquerda = Math.random() < 0.5;
    const x0 = daEsquerda ? -60 : w() + 60;
    const y0 = rnd(h() * 0.15, h() * 0.75);
    const xf = daEsquerda ? w() + 60 : -60;
    const yf = rnd(h() * 0.15, h() * 0.75);
    const vel = pequena ? 1.25 : 1;
    try {
      const pouso = Math.random() < 0.35 ? pontoDePouso() : null;
      if (pouso) {
        await voar(el, curva(x0, y0, pouso.x, pouso.y), rnd(9000, 13000) * vel, { entrar: true });
        el.classList.add("pousada");
        await new Promise((r) => setTimeout(r, rnd(3500, 6000)));
        el.classList.remove("pousada");
        await voar(el, curva(pouso.x, pouso.y, xf, yf), rnd(9000, 13000) * vel, { sair: true });
      } else {
        await voar(el, curva(x0, y0, xf, yf), rnd(16000, 24000) * vel, { entrar: true, sair: true });
      }
    } catch {}
    el.remove();
  }

  function ciclo(tamanho, pausaMin, pausaMax) {
    setTimeout(async () => {
      if (!document.hidden && !document.body.classList.contains("group-modal-open")) await viagem(tamanho);
      ciclo(tamanho, pausaMin, pausaMax);
    }, rnd(pausaMin, pausaMax));
  }

  // Uma no celular; duas no computador, em profundidades diferentes.
  ciclo("plano-perto", 2500, 9000);
  if (!pequena) ciclo("plano-longe", 12000, 26000);
}

/* ===== 6. Assistente (perguntas frequentes) ===== */
const SORASAKI_FAQ = [
  { pergunta: "O que é o Sorasaki?", resposta: "O Sorasaki é um bot para grupos de WhatsApp que ajuda na proteção, organização e administração dos grupos.\n\nEste site reúne o status do bot ao vivo, a vitrine de comunidades, o catálogo e as novidades do projeto." },
  { pergunta: "Como divulgo o meu grupo?", resposta: "Vá em Grupos e toque em \"Divulgar meu grupo\". Você precisa estar conectado a uma conta.\n\nPreencha nome, categoria, descrição e o link de convite. A equipe confere antes de publicar — você acompanha o status em \"Minhas divulgações\"." },
  { pergunta: "Quanto tempo leva para aprovar?", resposta: "Toda divulgação passa por uma checagem manual da equipe. Assim que for revisada, o status muda em \"Minhas divulgações\" — publicada ou recusada, com o motivo quando houver." },
  { pergunta: "Preciso ter uma conta para usar o site?", resposta: "Não para navegar. A conta só é necessária para divulgar grupos, avaliar, relatar problemas, enviar sugestões ou comprar." },
  { pergunta: "Por que um comando não responde?", resposta: "Veja primeiro a página Status: se o bot estiver offline ou reconectando, os comandos voltam a funcionar em instantes.\n\nSe o bot estiver online e só um comando falhar, relate em Avaliações e bugs contando o que você digitou — isso ajuda a corrigir mais rápido." },
  { pergunta: "Como relato um bug?", resposta: "Em Avaliações e bugs, preencha o que aconteceu, onde (site ou bot) e, se puder, os passos para repetir o problema. É preciso estar conectado para enviar." },
  { pergunta: "Posso sugerir uma função nova?", resposta: "Pode e deve. Use o formulário de sugestões em Avaliações e bugs. Algumas ideias podem entrar nas próximas atualizações." },
  { pergunta: "As estatísticas são em tempo real?", resposta: "Os números do bot são atualizados a cada poucos segundos enquanto a página está aberta. As visitas ao site são contadas de forma anônima, sem guardar IP." },
  { pergunta: "O Sorasaki é gratuito?", resposta: "Navegar, divulgar um grupo e usar a vitrine não custam nada. Planos de destaque e produtos do catálogo são pagos e aparecem com o preço antes da compra." },
  { pergunta: "Como falo com a equipe?", resposta: "Na página Suporte você encontra o e-mail e o WhatsApp da equipe. Conte o que aconteceu e, se possível, mande um print." }
];

function criarAssistente() {
  if (document.querySelector(".assistant-widget")) return;
  if (caminhoAtual() === "/controle-8f4c2e91" || SORA_PREFS.get("assistant", "on") === "off") return;

  const widget = document.createElement("aside");
  widget.className = "assistant-widget";
  widget.setAttribute("aria-label", "Ajuda rápida");
  widget.innerHTML = `
    <div class="sora-chat-panel" id="soraChatPanel" role="dialog" aria-label="Perguntas frequentes">
      <div class="sora-chat-head">
        <div class="sora-chat-head-info"><span class="sora-chat-avatar"><img src="/img/sorasaki-avatar.webp" alt="" width="36" height="36"></span><div><strong>Sorasaki</strong><small>Perguntas frequentes</small></div></div>
        <button class="icon-btn" type="button" data-chat-close aria-label="Fechar">×</button>
      </div>
      <div class="sora-chat-body" id="soraChatBody"></div>
    </div>
    <button class="assistant-launcher" type="button" aria-label="Abrir perguntas frequentes" aria-expanded="false" aria-controls="soraChatPanel">
      <img src="/img/sorasaki-avatar.webp" alt="" width="56" height="56" draggable="false"><span class="launcher-close" aria-hidden="true">×</span>
    </button>`;
  document.body.appendChild(widget);

  // No celular o botão só aparece depois de rolar um pouco, para não cobrir
  // os botões principais da primeira tela.
  if (window.matchMedia("(max-width: 640px)").matches && window.scrollY < 280) {
    widget.classList.add("is-tucked");
    const revelar = () => { if (window.scrollY >= 280) { widget.classList.remove("is-tucked"); window.removeEventListener("scroll", revelar); } };
    window.addEventListener("scroll", revelar, { passive: true });
  }

  const panel = widget.querySelector("#soraChatPanel");
  const body = widget.querySelector("#soraChatBody");
  const launcher = widget.querySelector(".assistant-launcher");
  let iniciado = false;

  const rolar = () => { body.scrollTop = body.scrollHeight; };
  function mensagem(tipo, texto) {
    const el = document.createElement("div");
    el.className = `sora-chat-msg ${tipo}`;
    el.innerHTML = String(texto).split(/\n{2,}/).map((p) => `<p>${escapeHtml(p)}</p>`).join("");
    body.appendChild(el);
    rolar();
  }
  function perguntas() {
    const chips = document.createElement("div");
    chips.className = "sora-chat-chips";
    SORASAKI_FAQ.forEach((item) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sora-chat-chip";
      b.textContent = item.pergunta;
      b.onclick = () => responder(item, chips);
      chips.appendChild(b);
    });
    body.appendChild(chips);
    rolar();
  }
  function responder(item, chips) {
    chips.remove();
    mensagem("user", item.pergunta);
    const digitando = document.createElement("div");
    digitando.className = "sora-chat-msg assistant sora-chat-typing";
    digitando.innerHTML = "<span></span><span></span><span></span>";
    body.appendChild(digitando);
    rolar();
    setTimeout(() => {
      digitando.remove();
      mensagem("assistant", item.resposta);
      const voltar = document.createElement("button");
      voltar.type = "button";
      voltar.className = "sora-chat-back";
      voltar.textContent = "Ver outras perguntas";
      voltar.onclick = () => { voltar.remove(); perguntas(); };
      body.appendChild(voltar);
      rolar();
    }, 450);
  }
  function abrir() {
    widget.querySelector(".assistant-hint")?.remove();
    panel.classList.add("is-open");
    widget.classList.add("chat-open");
    launcher.setAttribute("aria-expanded", "true");
    launcher.setAttribute("aria-label", "Fechar perguntas frequentes");
    if (!iniciado) { iniciado = true; mensagem("assistant", "Oi! Escolha uma pergunta abaixo que eu respondo na hora."); perguntas(); }
  }
  function fechar() {
    panel.classList.remove("is-open");
    widget.classList.remove("chat-open");
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-label", "Abrir perguntas frequentes");
  }
  launcher.onclick = () => (panel.classList.contains("is-open") ? fechar() : abrir());
  widget.querySelector("[data-chat-close]").onclick = fechar;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && panel.classList.contains("is-open")) fechar(); });

  // Uma dica discreta, uma vez por sessão.
  try {
    if (!sessionStorage.getItem("sorasaki_hint_seen")) {
      setTimeout(() => {
        if (panel.classList.contains("is-open") || document.body.classList.contains("group-modal-open")) return;
        sessionStorage.setItem("sorasaki_hint_seen", "1");
        const hint = document.createElement("div");
        hint.className = "assistant-hint";
        hint.innerHTML = 'Dúvidas sobre o Sorasaki? Toque em mim.<button type="button" aria-label="Dispensar">×</button>';
        hint.querySelector("button").onclick = () => hint.remove();
        widget.insertBefore(hint, launcher);
        setTimeout(() => hint.remove(), 9000);
      }, 5000);
    }
  } catch {}
}

/* ===== 7. Inicialização ===== */
// Imagens decorativas não abrem menu de "salvar imagem" nem são arrastadas.
// (Links continuam funcionando normalmente, inclusive os que têm imagem.)
document.addEventListener("contextmenu", (e) => { if (e.target instanceof HTMLImageElement && !e.target.closest("a")) e.preventDefault(); });
document.addEventListener("dragstart", (e) => { if (e.target instanceof HTMLImageElement) e.preventDefault(); });

window.addEventListener("unhandledrejection", (e) => console.error("[SORASAKI] Erro não tratado:", e.reason));

// Atalhos "Meu bot" ([data-bot-platform]) só aparecem quando o admin liga a
// plataforma de bots. Consulta uma vez por sessão, só com conta conectada.
async function revelarAtalhosDoBot() {
  const mostrar = () => document.querySelectorAll("[data-bot-platform]").forEach((el) => { el.hidden = false; });
  try {
    const salvo = sessionStorage.getItem("sorasaki_bot_platform");
    if (salvo === "1") { mostrar(); return; }
    if (salvo === "0") return;
  } catch {}
  await window.SorasakiAuth?.ready;
  if (!window.SorasakiAuth?.getUser?.()) return;
  try {
    const token = await window.SorasakiAuth.getToken();
    const r = await Sora.fetchJson("/api/v1/bots?type=status", { headers: { Authorization: `Bearer ${token}` } }, 10000);
    const ligado = Boolean(r.ok && r.body?.enabled);
    try { sessionStorage.setItem("sorasaki_bot_platform", ligado ? "1" : "0"); } catch {}
    if (ligado) mostrar();
  } catch {}
}

function iniciarSorasaki() {
  // Atalho de teclado: primeiro Tab da página leva direto ao conteúdo.
  const principal = document.getElementById("conteudo");
  if (principal && !document.querySelector(".skip-link")) {
    principal.setAttribute("tabindex", "-1");
    const pular = document.createElement("a");
    pular.className = "skip-link";
    pular.href = "#conteudo";
    pular.textContent = "Pular para o conteúdo";
    document.body.prepend(pular);
  }
  marcarNavAtiva();
  window.SorasakiAuth._init();
  criarMenuSorasaki();
  marcarNavAtiva();
  ligarIndicadorDoBot();
  criarAssistente();
  ligarRevelacao();
  criarBorboleta();
  iniciarConfigPublica();
  revelarAtalhosDoBot();
  window.SorasakiAuth?.onAuthChange?.((u, ev) => {
    if (ev === "INITIAL") return;
    try { sessionStorage.removeItem("sorasaki_bot_platform"); } catch {}
    if (u) revelarAtalhosDoBot();
  });

  const aviso = document.getElementById("avisoConexao");
  if (aviso) {
    onFetchError((msg) => { aviso.textContent = msg; aviso.classList.add("is-visible"); });
    onStats(() => { aviso.classList.remove("is-visible"); });
  }
  // Estatísticas do bot principal saíram do painel público (agora só na área
  // autenticada do dono, em /meu-bot). As linhas que buscavam dados da ponte
  // publicamente (bootstrapDashboard / buscarStats) foram desativadas de
  // propósito — não apagamos o código porque a ponte ainda pode servir um
  // painel interno no futuro, só não fica mais exposta ao público.

  instalarGuardaDeManutencao().then((ativa) => {
    window.SORASAKI_MAINTENANCE = ativa;
    document.dispatchEvent(new CustomEvent("sorasaki:maintenance-checked", { detail: { active: ativa } }));
    if (!ativa) registrarVisita();
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciarSorasaki);
else iniciarSorasaki();
