// Página "Meu bot" (meu-bot.html): planos, assinatura, conexão do número,
// estado do bot e liga/desliga por grupo. Tudo passa por /api/v1/bots, que
// valida no servidor e só devolve dados do próprio usuário.
(function () {
  const auth = window.SorasakiAuth;
  const area = document.getElementById("botArea");
  const esc = escapeHtml;
  const ND = "Informação não disponível.";
  const PERIODO = { weekly: "semana", monthly: "mês", yearly: "ano" };
  const SUB = { trialing: "Teste grátis", pending_payment: "Aguardando pagamento", active: "Ativa", past_due: "Vencida (em carência)", suspended: "Suspensa por falta de pagamento", expired: "Expirada", canceled: "Cancelada" };
  const CONEXAO = { pending_approval: "Aguardando aprovação da equipe", approved: "Aprovado — aguardando um servidor", dispatched: "Gerando o código de pareamento…", code_ready: "Código pronto", connected: "Conectado", rejected: "Recusado", failed: "Falhou", expired: "Expirou", canceled: "Cancelado" };
  const TOM_CLASSE = { ok: "approved", info: "", warn: "pending", error: "suspended", muted: "" };
  let dados = null;
  let timer = null;
  let contagem = null;

  // Campos do formulário "Conectar número" que não podem ser apagados por um
  // re-render automático (polling ou o usuário voltando de outra aba/app)
  // enquanto ainda não foram enviados.
  const CAMPOS_PRESERVAVEIS = ["botTelefone", "botDono"];

  const fmt = (d) => (d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : ND);
  const dinheiro = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const val = (v) => (v === null || v === undefined || v === "" ? ND : esc(String(v)));

  // Monta o link do WhatsApp pra fechar a contratação/renovação de um plano
  // (substitui o antigo link de checkout do Mercado Pago).
  function linkWhatsAppPagamento(plano, nomeInstancia) {
    const numero = String(window.SORASAKI_CONTACT?.whatsapp || "").replace(/\D/g, "");
    if (!numero) return null;
    const texto = `Olá! Quero contratar o plano ${plano || ""} do Sorasaki${nomeInstancia ? ` pro bot "${nomeInstancia}"` : ""}.`;
    return `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
  }

  async function api(type, body) {
    const token = await auth.getToken();
    const opts = body === undefined
      ? { headers: { Authorization: `Bearer ${token}` } }
      : { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) };
    return Sora.fetchJson(`/api/v1/bots?type=${encodeURIComponent(type)}`, opts, 20000);
  }

  async function acao(btn, type, body, { confirmar = null } = {}) {
    if (confirmar && !Sora.confirmTap(btn, confirmar)) return;
    Sora.setBusy(btn, true);
    try {
      const r = await api(type, body || {});
      if (!r.ok) { Sora.toast(r.body?.message || "Não foi possível concluir. Tente de novo.", "error", 6000); return; }
      const whatsappUrl = r.body?.whatsapp_url;
      if ((type === "subscribe" || type === "renew" || type === "change-plan") && whatsappUrl) {
        Sora.toast(r.body?.message || "Fale com a gente no WhatsApp para fechar a contratação.", "ok", 4000);
        window.open(whatsappUrl, "_blank", "noopener");
        await carregar();
        return;
      }
      Sora.toast(r.body?.message || "Pronto.", "ok", 5000);
      await carregar();
    } catch (e) {
      Sora.toast(Sora.friendlyError(e), "error");
    } finally { Sora.setBusy(btn, false); }
  }

  /* ---------------- carregar ---------------- */
  let chamadaAtual = 0;

  async function carregar() {
    clearTimeout(timer);
    const minhaChamada = ++chamadaAtual;
    await auth.ready;
    if (minhaChamada !== chamadaAtual) return;
    if (!auth.getUser()) {
      if (minhaChamada !== chamadaAtual) return;
      area.innerHTML = '<div class="empty-state"><strong>Entre para conectar o seu bot</strong><span>É preciso ter uma conta no Sorasaki.</span><button class="btn btn-primary btn-sm" type="button" data-login>Entrar ou criar conta</button></div>';
      area.querySelector("[data-login]").onclick = () => auth.open("login");
      return;
    }
    let r;
    try { r = await api("status"); } catch (e) {
      if (minhaChamada !== chamadaAtual) return;
      area.innerHTML = Sora.emptyState("Não foi possível carregar.", Sora.friendlyError(e), { retry: true, icon: "alert" });
      area.querySelector("[data-retry]").onclick = carregar;
      return;
    }
    if (minhaChamada !== chamadaAtual) return;
    if (!r.ok) {
      area.innerHTML = Sora.emptyState("Não foi possível carregar.", r.body?.message || "Tente de novo em instantes.", { retry: true, icon: "alert" });
      area.querySelector("[data-retry]").onclick = carregar;
      return;
    }
    dados = r.body;

    if (dados.phase_notice) document.querySelector("[data-phase-text]").textContent = dados.phase_notice;
    render();
    const rapido = ["dispatched", "code_ready", "approved"].includes(dados.connection?.status) || ["connecting", "restarting"].includes(dados.instance?.status?.code);
    timer = setTimeout(carregar, rapido ? 5000 : 20000);
  }

  /* ---------------- telas ---------------- */
  // Guarda o que está nos campos preserváveis (e qual deles estava focado)
  // antes de jogar fora o HTML atual.
  function capturarCamposPreservaveis() {
    const valores = {};
    for (const id of CAMPOS_PRESERVAVEIS) {
      const el = document.getElementById(id);
      if (el) valores[id] = el.value;
    }
    const ativo = document.activeElement;
    return {
      valores,
      focoId: ativo && CAMPOS_PRESERVAVEIS.includes(ativo.id) ? ativo.id : null,
      selecaoInicio: ativo && "selectionStart" in ativo ? ativo.selectionStart : null,
      selecaoFim: ativo && "selectionEnd" in ativo ? ativo.selectionEnd : null
    };
  }

  // Depois de recriar o HTML, devolve os valores (só se o campo ainda existir
  // na tela nova) e o foco/cursor de volta pro lugar.
  function restaurarCamposPreservaveis(estado) {
    for (const id of CAMPOS_PRESERVAVEIS) {
      const valor = estado.valores[id];
      if (!valor) continue;
      const el = document.getElementById(id);
      if (el && !el.value) el.value = valor;
    }
    if (estado.focoId) {
      const el = document.getElementById(estado.focoId);
      if (el) {
        el.focus();
        if (estado.selecaoInicio !== null && estado.selecaoFim !== null && typeof el.setSelectionRange === "function") {
          try { el.setSelectionRange(estado.selecaoInicio, estado.selecaoFim); } catch (e) {}
        }
      }
    }
  }

  function render() {
    // Preserva o que a pessoa já tinha digitado no formulário "Conectar
    // número" antes de recriar a tela — sem isso, tanto o polling automático
    // quanto o "voltar de outra aba/app" (ex.: abrir o WhatsApp pra parear)
    // apagavam o número no meio da digitação.
    const camposPreservados = capturarCamposPreservaveis();

    if (!dados.enabled) {
      area.innerHTML = Sora.emptyState("Em breve", "A área de bots individuais ainda está sendo liberada. Volte em alguns dias.", { icon: "star" });
      return;
    }
    const sub = dados.subscription;
    const semAssinatura = !dados.instance || !sub || ["expired", "canceled"].includes(sub.status);
    area.innerHTML = `
      ${dados.test_notice ? `<div class="inline-alert"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l9.5 16.5h-19z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.5h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><div><strong>Pagamentos em modo de teste.</strong> ${esc(dados.test_notice)}</div></div>` : ""}
      ${dados.instance ? painelInstancia() : ""}
      ${dados.instance && sub ? painelAssinatura() : ""}
      ${semAssinatura ? painelPlanos() : ""}
      ${dados.instance && !semAssinatura ? painelConexao() : ""}
      ${dados.instance ? painelGrupos() : ""}
      ${dados.instance ? painelEventos() : ""}`;
    ligar();
    restaurarCamposPreservaveis(camposPreservados);
  }

  function badge(st) {
    return `<span class="status-badge ${TOM_CLASSE[st?.tone] || ""}">${esc(st?.label || "—")}</span>`;
  }

  function painelInstancia() {
    const i = dados.instance;
    return `<section class="panel bot-card">
      <div class="section-heading"><div><h2>${esc(i.name)}</h2></div>${badge(i.status)}</div>
      ${i.status?.warning ? `<p class="bot-warning">${esc(i.status.warning)}</p>` : ""}
      ${i.status_reason && ["suspended", "blocked", "revoked"].includes(i.status?.code) ? `<p class="bot-warning">Motivo: ${esc(i.status_reason)}</p>` : ""}
      <dl class="bot-info">
        <div><dt>Número do bot</dt><dd>${val(i.phone_masked)}</dd></div>
        <div><dt>Dono (controla pelo WhatsApp)</dt><dd>${val(i.owner_contact_masked)}</dd></div>
        <div><dt>Onde está rodando</dt><dd>${val(i.execution_location)}</dd></div>
        <div><dt>Última atividade</dt><dd>${fmt(i.last_activity_at)}</dd></div>
        <div><dt>Conectado desde</dt><dd>${fmt(i.connected_since)}</dd></div>
        <div><dt>Última conexão</dt><dd>${fmt(i.last_connected_at)}</dd></div>
        <div><dt>Grupos</dt><dd>${i.groups_count}</dd></div>
        <div><dt>Comandos executados</dt><dd>${i.commands_count}</dd></div>
        <div><dt>Criado em</dt><dd>${fmt(i.created_at)}</dd></div>
        <div class="wide"><dt>Último erro</dt><dd>${i.last_error ? `${esc(i.last_error.message)} <small class="admin-muted">(${fmt(i.last_error.at)})</small>` : "Nenhum"}</dd></div>
      </dl>
      <div class="admin-actions">
        <button class="btn btn-sm" type="button" data-acao="restart">Reiniciar bot</button>
        ${i.phone_masked ? '<button class="btn btn-sm btn-danger" type="button" data-acao="disconnect">Desconectar número</button>' : ""}
        <button class="btn btn-sm btn-ghost" type="button" data-acao="rename">Renomear</button>
      </div>
    </section>`;
  }

  function painelAssinatura() {
    const s = dados.subscription;
    const pend = (dados.payments || []).filter((p) => p.status === "pending");
    const aberta = ["trialing", "pending_payment", "active", "past_due", "suspended"].includes(s.status);
    const opcoes = (dados.plans || []).map((p) => `<option value="${esc(p.code)}" ${s.plan?.code === p.code ? "selected" : ""}>${esc(p.name)} — ${dinheiro(p.price)}/${PERIODO[p.period]}</option>`).join("");
    return `<section class="panel bot-card">
      <div class="section-heading"><div><h2>Assinatura</h2></div><span class="status-badge ${["active", "trialing"].includes(s.status) ? "approved" : ["pending_payment", "past_due"].includes(s.status) ? "pending" : "suspended"}">${esc(SUB[s.status] || s.status)}</span></div>
      <dl class="bot-info">
        <div><dt>Plano</dt><dd>${val(s.plan?.name)}${s.next_plan ? ` <small class="admin-muted">→ ${esc(s.next_plan.name)} na renovação</small>` : ""}</dd></div>
        <div><dt>Valor</dt><dd>${dinheiro(s.price)}/${PERIODO[s.period] || s.period}</dd></div>
        <div><dt>Início</dt><dd>${fmt(s.started_at)}</dd></div>
        <div><dt>${s.status === "trialing" ? "Teste até" : "Vencimento"}</dt><dd>${fmt(s.status === "trialing" ? s.trial_ends_at : s.current_period_end)}</dd></div>
        ${s.cancel_at_period_end ? '<div class="wide"><dt>Cancelamento</dt><dd>Agendado para o fim do período.</dd></div>' : ""}
      </dl>
      ${pend.length ? `<p class="bot-warning">Pagamento ${pend[0].is_test ? "de teste " : ""}aguardando confirmação (${dinheiro(pend[0].amount)}).${pend[0].checkout_url ? ` <a class="btn btn-sm btn-primary" href="${esc(pend[0].checkout_url)}">Continuar pagamento</a>` : pend[0].gateway === "whatsapp" ? ` <a class="btn btn-sm btn-primary" href="${esc(linkWhatsAppPagamento(s.plan?.name, dados.instance?.name) || "#")}" target="_blank" rel="noopener">Falar no WhatsApp</a>` : ""}</p>` : ""}
      ${aberta ? `<div class="admin-actions">
        ${s.status !== "pending_payment" && !pend.length ? '<button class="btn btn-sm btn-primary" type="button" data-acao="renew">Renovar</button>' : ""}
        <select id="botTrocaPlano" aria-label="Trocar plano">${opcoes}</select><button class="btn btn-sm" type="button" data-acao="change-plan">Trocar plano</button>
        ${s.cancel_at_period_end ? '<button class="btn btn-sm" type="button" data-acao="resume">Desfazer cancelamento</button>' : '<button class="btn btn-sm btn-ghost" type="button" data-acao="cancel">Cancelar assinatura</button>'}
      </div>` : ""}
    </section>`;
  }

  function painelPlanos() {
    const planos = dados.plans || [];
    if (!planos.length) return `<section class="panel">${Sora.emptyState("Nenhum plano disponível agora.", "Volte mais tarde.")}</section>`;
    return `<section class="panel">
      <div class="section-heading"><div><h2>Escolha um plano</h2></div><span>Você escolhe o período. Pode trocar ou cancelar depois.</span></div>
      ${dados.instance ? "" : '<label class="bot-field">Nome do seu bot <span class="field-optional">opcional</span><input id="botNome" maxlength="40" placeholder="Ex.: Bot da Loja"></label>'}
      <div class="bot-plans">${planos.map((p) => `
        <article class="plan-card">
          <span class="eyebrow">${esc(p.name)}</span>
          <h3>${dinheiro(p.price)}<small>/${PERIODO[p.period]}</small></h3>
          ${p.description ? `<p>${esc(p.description)}</p>` : ""}
          <ul class="bot-features">${(p.features || []).map((f) => `<li>${esc(f)}</li>`).join("")}${p.limits?.max_groups ? `<li>Até ${Number(p.limits.max_groups)} grupos</li>` : ""}${p.trial_days ? `<li>${Number(p.trial_days)} dia(s) de teste grátis</li>` : ""}</ul>
          <button class="btn btn-primary" type="button" data-assinar="${esc(p.code)}">Assinar ${esc(p.name.toLowerCase())}</button>
        </article>`).join("")}</div>
    </section>`;
  }

  function painelConexao() {
    const c = dados.connection;
    const i = dados.instance;
    const aberta = c && ["pending_approval", "approved", "dispatched", "code_ready"].includes(c.status);
    const conectado = i.phone_masked && ["online", "connecting", "restarting", "offline", "worker_unavailable", "no_internet", "temporary_failure", "maintenance"].includes(i.status?.code) && c?.status === "connected";
    if (aberta) {
      const codigo = c.pairing_code ? `
        <div class="pairing-code" role="status"><span>Seu código</span><strong data-codigo>${esc(c.pairing_code)}</strong><button class="btn btn-sm btn-ghost" type="button" data-copiar-codigo="${esc(c.pairing_code)}">Copiar</button><small data-expira="${esc(c.code_expires_at || "")}">vale por poucos minutos</small></div>
        <ol class="bot-steps">
          <li>No celular com o número ${esc(c.phone_masked || "")}, abra o WhatsApp.</li>
          <li>Toque em <b>Configurações → Aparelhos conectados → Conectar um aparelho</b>.</li>
          <li>Escolha <b>Conectar com número de telefone</b> e digite o código acima.</li>
        </ol>` : "";
      return `<section class="panel bot-card">
        <div class="section-heading"><div><h2>Conexão do número</h2></div><span class="status-badge pending">${esc(CONEXAO[c.status] || c.status)}</span></div>
        <p class="admin-muted">Número: ${val(c.phone_masked)} · pedido em ${fmt(c.created_at)}</p>
        ${codigo}
        <div class="admin-actions"><button class="btn btn-sm btn-ghost" type="button" data-acao="cancel-connection">Cancelar pedido</button></div>
      </section>`;
    }
    if (conectado) return "";
    const ultima = c && ["rejected", "failed", "expired"].includes(c.status)
      ? `<p class="bot-warning">Último pedido: ${esc(CONEXAO[c.status])}${c.reason ? ` — ${esc(c.reason)}` : ""}${c.error ? ` — ${esc(c.error)}` : ""}</p>` : "";
    const podeConectar = ["trialing", "active", "past_due"].includes(dados.subscription?.status);
    return `<section class="panel bot-card">
      <div class="section-heading"><div><h2>Conectar número</h2></div><span>O bot vai funcionar neste número.</span></div>
      ${ultima}
      ${podeConectar ? `<form id="botConectar" class="admin-form" novalidate>
        <div class="admin-form-grid">
          <label>Número do bot (com código do país)<input id="botTelefone" required inputmode="tel" autocomplete="off" placeholder="+55 11 91234-5678 ou +1 305 555-0100" maxlength="20"></label>
          <label>Seu número pessoal (dono) <span class="field-optional">opcional</span><input id="botDono" inputmode="tel" autocomplete="off" placeholder="+55 11 98888-7777" maxlength="20"></label>
        </div>
        <p class="field-hint">Aceitamos número de qualquer país — sempre comece pelo <b>+</b> e o código do país (+55 Brasil, +1 EUA/Canadá, +56 Chile, +351 Portugal...). O dono é quem manda comandos de dono pelo WhatsApp (precisa ser diferente do número do bot). Nunca pedimos senha ou código por mensagem.</p>
        <div class="admin-actions"><button class="btn btn-primary" type="submit">Pedir conexão</button></div>
      </form>` : `<p class="admin-muted">${dados.subscription?.status === "pending_payment" ? "Assim que o pagamento for confirmado, você poderá conectar o número aqui." : "Renove a assinatura para conectar um número."}</p>`}
    </section>`;
  }

  function painelGrupos() {
    const grupos = dados.groups || [];
    const cat = dados.catalog || [];
    const catDivulgacao = cat.find((c) => c.key === "feature:divulgacao_automatica");
    const catResto = cat.filter((c) => c.key !== "feature:divulgacao_automatica");
    const corpo = grupos.length ? grupos.map((g) => {
      const sDiv = catDivulgacao ? g.settings[catDivulgacao.key] : null;
      const atualDiv = catDivulgacao ? (sDiv ? sDiv.enabled : (g.actual[catDivulgacao.key] ?? true)) : false;
      return `
      <details class="bot-group">
        <summary><strong>${esc(g.name || "Grupo sem nome")}</strong><span class="admin-muted">${g.member_count ?? "?"} membros · ${g.bot_is_admin ? "bot é admin" : "bot não é admin"} · última atividade: ${fmt(g.last_activity_at)}</span></summary>
        <p class="admin-muted">ID protegido: ${esc(g.ref)} · visto desde ${fmt(g.first_seen_at)} · comandos: ${g.commands_count}</p>
        ${g.bot_is_admin === false ? '<p class="bot-warning">O bot não é admin neste grupo: funções como antilink e remover membros não funcionam até ele virar admin.</p>' : ""}
        ${catDivulgacao ? `<div class="divulgacao-card ${atualDiv ? "is-on" : "is-off"}">
          <span class="divulgacao-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 2.5l2.1 7.4 7.4 2.1-7.4 2.1L12 21.5l-2.1-7.4L2.5 12l7.4-2.1z" fill="currentColor"/></svg></span>
          <div class="divulgacao-card-copy">
            <strong>Divulgação automática ${atualDiv ? '<span class="status-badge approved">Ativada</span>' : '<span class="status-badge">Desativada</span>'}</strong>
            <p>${esc(catDivulgacao.how)}${sDiv ? ` <small class="admin-muted">— alterado por ${sDiv.by === "admin" ? "administração" : "você"} em ${fmt(sDiv.at)}${sDiv.pending ? " · aplicando…" : ""}</small>` : ""}</p>
          </div>
          <label class="switch switch-lg" title="${atualDiv ? "Desativar" : "Ativar"} divulgação automática"><input type="checkbox" data-grupo="${esc(g.ref)}" data-chave="${esc(catDivulgacao.key)}" ${atualDiv ? "checked" : ""} aria-label="Divulgação automática"><span></span></label>
        </div>` : ""}
        <div class="settings-list">${catResto.map((c) => {
          const s = g.settings[c.key];
          const atual = s ? s.enabled : (g.actual[c.key] ?? (c.key.startsWith("category:") || c.key === "feature:respostas_automaticas"));
          return `<div class="setting-row"><div><strong>${esc(c.label)}</strong><p>${esc(c.how)}${s ? ` <small class="admin-muted">— alterado por ${s.by === "admin" ? "administração" : "você"} em ${fmt(s.at)}${s.pending ? " · aplicando…" : ""}</small>` : ""}</p></div>
            <label class="switch"><input type="checkbox" data-grupo="${esc(g.ref)}" data-chave="${esc(c.key)}" ${atual ? "checked" : ""} aria-label="${esc(c.label)}"><span></span></label></div>`;
        }).join("")}</div>
        <form class="admin-toolbar bot-cmd" data-cmd-grupo="${esc(g.ref)}"><input placeholder="Desligar um comando específico (ex.: ban)" maxlength="40" autocapitalize="none"><button class="btn btn-sm" type="submit">Desligar comando</button></form>
        ${Object.entries(g.settings).filter(([k]) => k.startsWith("cmd:")).map(([k, s]) => `<span class="chip-static">${esc(k.slice(4))}: ${s.enabled ? "ligado" : "desligado"} <button class="text-link" type="button" data-grupo="${esc(g.ref)}" data-chave-toggle="${esc(k)}" data-valor="${s.enabled ? "0" : "1"}">${s.enabled ? "desligar" : "religar"}</button></span>`).join(" ")}
        ${g.recent_events?.length ? `<ul class="bot-events">${g.recent_events.map((e) => `<li><small>${fmt(e.at)}</small> ${esc(e.event)}</li>`).join("")}</ul>` : ""}
      </details>`;
    }).join("") : Sora.emptyState("Nenhum grupo ainda.", "Os grupos aparecem aqui quando o bot estiver conectado e dentro deles. Só mostramos grupos em que o bot está.");
    return `<section class="panel"><div class="section-heading"><div><h2>Grupos e comandos</h2></div><span>Cada mudança vale só para o grupo escolhido e chega ao bot em até 1 minuto.</span></div>${corpo}</section>`;
  }

  function painelEventos() {
    const ev = dados.events || [];
    return `<section class="panel"><div class="section-heading"><div><h2>Histórico</h2></div></div>
      ${ev.length ? `<ul class="bot-events">${ev.map((e) => `<li class="${e.severity === "error" ? "is-error" : e.severity === "warning" ? "is-warn" : ""}"><small>${fmt(e.created_at)}</small> ${esc(e.message || e.event)}</li>`).join("")}</ul>` : '<p class="admin-muted">Nada por aqui ainda.</p>'}</section>`;
  }

  /* ---------------- eventos da tela ---------------- */
  function ligar() {
    area.querySelectorAll("[data-copiar-codigo]").forEach((b) => {
      b.onclick = async () => {
        const codigo = b.dataset.copiarCodigo || "";
        try {
          await navigator.clipboard.writeText(codigo);
        } catch (e) {
          const campo = document.createElement("textarea");
          campo.value = codigo;
          campo.style.position = "fixed";
          campo.style.opacity = "0";
          document.body.appendChild(campo);
          campo.select();
          try { document.execCommand("copy"); } catch (e2) {}
          campo.remove();
        }
        Sora.toast("Código copiado.", "ok", 2000);
      };
    });
    area.querySelectorAll("[data-assinar]").forEach((b) => {
      b.onclick = () => acao(b, "subscribe", { plan_code: b.dataset.assinar, instance_name: document.getElementById("botNome")?.value || undefined });
    });
    area.querySelectorAll("[data-acao]").forEach((b) => {
      const t = b.dataset.acao;
      if (t === "rename") {
        b.onclick = () => {
          const nome = prompt("Novo nome do bot (2 a 40 caracteres):", dados.instance?.name || "");
          if (nome) acao(b, "rename", { name: nome });
        };
      } else if (t === "change-plan") {
        b.onclick = () => acao(b, "change-plan", { plan_code: document.getElementById("botTrocaPlano").value });
      } else if (t === "disconnect") {
        b.onclick = () => acao(b, "disconnect", {}, { confirmar: "Toque de novo para desconectar" });
      } else if (t === "cancel") {
        b.onclick = () => acao(b, "cancel", {}, { confirmar: "Toque de novo para cancelar" });
      } else {
        b.onclick = () => acao(b, t, {});
      }
    });
    const form = document.getElementById("botConectar");
    if (form) {
      form.onsubmit = (e) => {
        e.preventDefault();
        const tel = document.getElementById("botTelefone").value.trim();
        if (!tel.startsWith("+") && !tel.startsWith("00")) { Sora.toast("Comece o número pelo código do país (ex: +55 para Brasil, +1 para EUA, +56 para Chile).", "error"); return; }
        if (tel.replace(/\D/g, "").length < 8) { Sora.toast("Digite o número completo, com DDD/área e código do país.", "error"); return; }
        acao(form.querySelector('button[type="submit"]'), "connect", { phone: tel, owner_contact: document.getElementById("botDono").value.trim() || undefined });
      };
    }
    area.querySelectorAll("input[data-chave]").forEach((inp) => {
      inp.onchange = async () => {
        inp.disabled = true;
        const r = await api("group-setting", { group_ref: inp.dataset.grupo, key: inp.dataset.chave, enabled: inp.checked }).catch(() => null);
        inp.disabled = false;
        if (!r?.ok) { inp.checked = !inp.checked; Sora.toast(r?.body?.message || "Não foi possível salvar.", "error"); return; }
        Sora.toast(r.body.message, "ok", 3500);
      };
    });
    area.querySelectorAll("[data-chave-toggle]").forEach((b) => {
      b.onclick = () => acao(b, "group-setting", { group_ref: b.dataset.grupo, key: b.dataset.chaveToggle, enabled: b.dataset.valor === "1" });
    });
    area.querySelectorAll("form[data-cmd-grupo]").forEach((f) => {
      f.onsubmit = (e) => {
        e.preventDefault();
        const nome = f.querySelector("input").value.trim().toLowerCase().replace(/^[#!./$]/, "");
        if (!/^[a-z0-9_-]{2,40}$/.test(nome)) { Sora.toast("Nome de comando inválido.", "error"); return; }
        acao(f.querySelector("button"), "group-setting", { group_ref: f.dataset.cmdGrupo, key: `cmd:${nome}`, enabled: false });
      };
    });
    // Contagem do código de pareamento.
    clearInterval(contagem);
    const exp = area.querySelector("[data-expira]");
    if (exp && exp.dataset.expira) {
      const fim = new Date(exp.dataset.expira).getTime();
      const tick = () => {
        const s = Math.max(0, Math.round((fim - Date.now()) / 1000));
        exp.textContent = s > 0 ? `expira em ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "expirou — cancele e peça de novo";
      };
      tick();
      contagem = setInterval(tick, 1000);
    }
  }

  auth.onAuthChange?.(() => carregar());
  document.addEventListener("visibilitychange", () => { if (!document.hidden && dados) carregar(); });
  carregar();
})();
