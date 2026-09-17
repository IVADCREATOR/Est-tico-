// Painel admin → "Bots individuais". Tudo passa por /api/v1/bots?type=admin-*
// (o servidor confere admin + 2FA e registra auditoria de cada ação).
(function () {
  if (!window.SoraAdmin) return;
  const auth = window.SorasakiAuth;
  const $ = (id) => document.getElementById(id);
  const esc = escapeHtml;
  const ND = "Informação não disponível.";
  const fmt = (d) => (d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : ND);
  const dinheiro = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const val = (v) => (v === null || v === undefined || v === "" ? `<span class="admin-muted">${ND}</span>` : esc(String(v)));
  const TOM = { ok: "approved", warn: "pending", error: "suspended", info: "", muted: "" };
  const SUB = { trialing: "Teste", pending_payment: "Aguardando pagamento", active: "Ativa", past_due: "Vencida (carência)", suspended: "Suspensa (pagamento)", expired: "Expirada", canceled: "Cancelada" };
  const ESTADO = { pending_approval: "Aguardando aprovação", approved: "Aprovada", suspended: "Suspensa", blocked: "Bloqueada", revoked: "Revogada" };
  const PERIODO = { weekly: "Semanal", monthly: "Mensal", yearly: "Anual" };
  let planos = [];
  let workers = [];
  let detalheId = null;

  async function api(type, { query = "", body } = {}) {
    const token = await auth.getToken();
    const opts = body === undefined
      ? { headers: { Authorization: `Bearer ${token}` } }
      : { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) };
    return Sora.fetchJson(`/api/v1/bots?type=${type}${query}`, opts, 25000);
  }
  function erroNaTela(el, r) {
    el.innerHTML = `<div class="admin-empty">${esc(r?.body?.message || "Não foi possível carregar.")}</div>`;
  }
  async function executar(btn, type, body, depois) {
    Sora.setBusy(btn, true);
    try {
      const r = await api(type, { body });
      if (!r.ok) { Sora.toast(r.body?.message || "Não foi possível concluir.", "error", 7000); return null; }
      Sora.toast(r.body?.message || "Pronto.", "ok", 5000);
      if (depois) await depois(r.body);
      return r.body;
    } catch (e) { Sora.toast(Sora.friendlyError(e), "error"); return null; }
    finally { Sora.setBusy(btn, false); }
  }
  const badge = (st) => `<span class="status-badge ${TOM[st?.tone] || ""}">${esc(st?.label || "—")}</span>`;

  /* ================= Bots e números ================= */
  async function carregarLista() {
    const lista = $("botList");
    lista.innerHTML = '<div class="admin-empty">Carregando…</div>';
    const q = encodeURIComponent($("botSearch").value.trim());
    const r = await api("admin-list", { query: `&q=${q}&status=${encodeURIComponent($("botFilter").value)}` });
    if (!r.ok) return erroNaTela(lista, r);
    const s = r.body.summary;
    $("botKpis").innerHTML = [["Bots", s.total], ["Online agora", s.online], ["Pedidos pendentes", s.pendentes], ["Workers online", s.workers_online]]
      .map(([k, v]) => `<div class="admin-kpi"><b>${v}</b><span>${k}</span></div>`).join("");
    const c = document.querySelector('[data-count="bots"]');
    if (c) { c.hidden = !s.pendentes; c.textContent = s.pendentes || ""; }
    if (!r.body.instances.length) { lista.innerHTML = '<div class="admin-empty">Nenhum bot encontrado.</div>'; return; }
    lista.innerHTML = r.body.instances.map((i) => `
      <article class="admin-item">
        <div class="admin-item-head"><div><h3>${esc(i.name)} ${i.is_main ? '<span class="chip-static">bot principal</span>' : ""} ${i.pending_connection ? '<span class="status-badge pending">pedido de conexão</span>' : ""}</h3>
          <p class="admin-muted">${i.owner ? `${esc(i.owner.username || "—")} · ${esc(i.owner.email || "")}` : "sem dono"} · ${esc(ESTADO[i.admin_state] || i.admin_state)}</p></div>${badge(i.status)}</div>
        <dl class="bot-info bot-info-compact">
          <div><dt>Número</dt><dd>${val(i.phone_masked)}</dd></div>
          <div><dt>Plano</dt><dd>${val(i.plan)}</dd></div>
          <div><dt>Assinatura</dt><dd>${val(SUB[i.subscription_status] || i.subscription_status)}</dd></div>
          <div><dt>Vencimento</dt><dd>${fmt(i.expires_at)}</dd></div>
          <div><dt>Última atividade</dt><dd>${fmt(i.last_activity_at)}</dd></div>
          <div><dt>Última conexão</dt><dd>${fmt(i.last_connected_at)}</dd></div>
          <div><dt>Grupos / comandos</dt><dd>${i.groups_count} / ${i.commands_count}</dd></div>
          <div><dt>Onde roda</dt><dd>${val(i.execution_location)}</dd></div>
          <div><dt>Criado</dt><dd>${fmt(i.created_at)}</dd></div>
          <div class="wide"><dt>Último erro</dt><dd>${i.last_error ? `${esc(i.last_error.message)} <small class="admin-muted">(${fmt(i.last_error.at)})</small>` : "Nenhum"}</dd></div>
        </dl>
        <div class="admin-actions"><button class="btn btn-sm btn-primary" type="button" data-detalhe="${esc(i.id)}">Abrir detalhes e ações</button></div>
      </article>`).join("");
    lista.querySelectorAll("[data-detalhe]").forEach((b) => { b.onclick = () => abrirDetalhe(b.dataset.detalhe); });
    if (detalheId) abrirDetalhe(detalheId, { rolar: false });
  }

  async function garantirAuxiliares() {
    if (!planos.length) { const r = await api("admin-plans"); if (r.ok) planos = r.body.plans; }
    if (!workers.length) { const r = await api("admin-workers"); if (r.ok) workers = r.body.workers; }
  }

  async function abrirDetalhe(id, { rolar = true } = {}) {
    detalheId = id;
    const painel = $("botDetailPanel");
    const box = $("botDetail");
    painel.hidden = false;
    box.innerHTML = '<div class="admin-empty">Carregando detalhes…</div>';
    if (rolar) painel.scrollIntoView({ behavior: "smooth", block: "start" });
    await garantirAuxiliares();
    const r = await api("admin-instance", { query: `&id=${encodeURIComponent(id)}` });
    if (!r.ok) return erroNaTela(box, r);
    const d = r.body;
    const i = d.instance;
    const sub = d.subscriptions.find((s) => ["trialing", "pending_payment", "active", "past_due", "suspended"].includes(s.status)) || d.subscriptions[0];
    const pend = d.connections.find((c) => c.status === "pending_approval");
    const pagPend = d.payments.filter((p) => p.status === "pending");
    const ctx = (c) => [c.context?.country, c.context?.region].filter(Boolean).join(" / ") || ND;
    box.innerHTML = `
      <div class="section-heading"><div><h2>${esc(i.name)}</h2><p class="admin-muted">ID ${esc(i.id)}</p></div>${badge(i.status)}</div>
      <dl class="bot-info">
        <div><dt>Dono</dt><dd>${i.owner ? `${val(i.owner.username)}<br><small>${val(i.owner.email)}</small>` : "sem dono"}</dd></div>
        <div><dt>Situação</dt><dd>${esc(ESTADO[i.admin_state] || i.admin_state)}${i.status_reason ? `<br><small>${esc(i.status_reason)}</small>` : ""}</dd></div>
        <div><dt>Estado informado pelo worker</dt><dd>${esc(i.op_status)} · desejado: ${esc(i.desired_state)}</dd></div>
        <div><dt>Número</dt><dd>${val(i.phone_masked)}</dd></div>
        <div><dt>Dono pelo WhatsApp</dt><dd>${val(i.owner_contact_masked)}</dd></div>
        <div><dt>Worker</dt><dd>${i.worker ? `${esc(i.worker.name)} (${esc(i.worker.kind)}${i.worker.region ? `, ${esc(i.worker.region)}` : ""})<br><small>último sinal ${fmt(i.worker.last_heartbeat_at)} · agente ${val(i.worker.agent_version)}</small>` : val(null)}</dd></div>
        <div><dt>Processo</dt><dd>Node ${val(i.runtime.node)} · ${val(i.runtime.platform)} · ${i.runtime.rss_mb ?? "?"} MB</dd></div>
        <div><dt>Visto pelo worker</dt><dd>${fmt(i.last_seen_by_worker_at)}</dd></div>
        <div><dt>Conectado desde</dt><dd>${fmt(i.connected_since)}</dd></div>
        <div><dt>Grupos / comandos</dt><dd>${i.groups_count} / ${i.commands_count}</dd></div>
        <div class="wide"><dt>Último erro</dt><dd>${i.last_error ? `${esc(i.last_error.code || "")} ${esc(i.last_error.message)} (${fmt(i.last_error.at)})` : "Nenhum"}</dd></div>
      </dl>

      <h3 class="panel-title">Ações</h3>
      <label class="bot-field">Motivo (obrigatório para suspender, bloquear, revogar, desconectar e recusar)<input id="botMotivo" maxlength="300" placeholder="Ex.: pagamento não identificado"></label>
      <div class="admin-actions">
        ${pend ? '<button class="btn btn-sm btn-primary" data-ad="accept-connection">Aceitar conexão</button><button class="btn btn-sm admin-danger" data-ad="reject-connection">Recusar conexão</button>' : ""}
        ${i.admin_state === "pending_approval" ? '<button class="btn btn-sm btn-primary" data-ad="approve">Aprovar</button>' : ""}
        ${["suspended", "blocked"].includes(i.admin_state) ? '<button class="btn btn-sm btn-primary" data-ad="reactivate">Reativar</button>' : ""}
        ${i.admin_state === "approved" ? '<button class="btn btn-sm" data-ad="suspend">Suspender</button>' : ""}
        ${i.admin_state !== "blocked" && i.admin_state !== "revoked" ? '<button class="btn btn-sm admin-danger" data-ad="block">Bloquear</button>' : ""}
        ${i.admin_state !== "revoked" ? '<button class="btn btn-sm admin-danger" data-ad="revoke" data-confirmar="Confirmar revogação">Revogar</button>' : ""}
        ${["revoked", "blocked"].includes(i.admin_state) ? '<button class="btn btn-sm admin-danger" data-ad="delete" data-confirmar="Excluir definitivamente — apaga a sessão e não pode ser desfeito">Excluir bot</button>' : ""}
        ${i.phone_masked ? '<button class="btn btn-sm admin-danger" data-ad="disconnect" data-confirmar="Confirmar desconexão">Desconectar número</button>' : ""}
        ${i.management === "managed" ? '<button class="btn btn-sm" data-ad="start">Iniciar</button><button class="btn btn-sm" data-ad="stop">Parar</button><button class="btn btn-sm" data-ad="restart">Reiniciar</button>' : '<span class="admin-muted">Bot principal: o worker só observa (não inicia nem para).</span>'}
      </div>
      <div class="admin-actions">
        <select id="botPlanoSel">${planos.map((p) => `<option value="${esc(p.code)}">${esc(p.name)} — ${dinheiro(p.price)}</option>`).join("")}</select>
        <button class="btn btn-sm" data-ad="change-plan">Trocar plano</button>
        <input id="botDias" type="number" min="1" max="400" placeholder="dias" style="max-width:90px"><button class="btn btn-sm" data-ad="grant-subscription">Conceder assinatura</button>
      </div>
      <div class="admin-actions">
        <input id="botValidade" type="datetime-local" aria-label="Nova validade"><button class="btn btn-sm" data-ad="set-validity">Alterar validade</button>
        <select id="botWorkerSel">${workers.map((w) => `<option value="${esc(w.id)}" ${i.worker?.id === w.id ? "selected" : ""}>${esc(w.name)} (${w.online ? "online" : "offline"}, ${w.instances}/${w.capacity})</option>`).join("")}</select>
        <button class="btn btn-sm" data-ad="assign-worker">Mover para worker</button>
      </div>
      <div class="admin-actions"><input id="botNota" maxlength="300" placeholder="Observação interna (o dono não vê)"><button class="btn btn-sm" data-ad="note">Salvar observação</button></div>

      <div class="admin-two">
        <div><h3 class="panel-title">Assinaturas</h3>${d.subscriptions.length ? d.subscriptions.map((s) => `<div class="admin-item"><strong>${esc(s.plan?.name || "?")} · ${esc(SUB[s.status] || s.status)}</strong><span class="admin-muted">${dinheiro(s.price)} · início ${fmt(s.started_at)} · vence ${fmt(s.status === "trialing" ? s.trial_ends_at : s.current_period_end)}${s.cancel_at_period_end ? " · cancelamento agendado" : ""}</span></div>`).join("") : '<p class="admin-muted">Nenhuma.</p>'}</div>
        <div><h3 class="panel-title">Pagamentos</h3>${d.payments.length ? d.payments.map((p) => `<div class="admin-item"><strong>${dinheiro(p.amount)} · ${esc(p.status)} ${p.is_test ? '<span class="chip-static">teste</span>' : ""}</strong><span class="admin-muted">${esc(p.kind)} · ${esc(p.gateway)} · criado ${fmt(p.created_at)}${p.paid_at ? ` · pago ${fmt(p.paid_at)}` : ""}</span>${p.status === "pending" ? (p.is_test ? `<button class="btn btn-sm btn-primary" data-ad="confirm-payment" data-pagamento="${esc(p.id)}">Confirmar pagamento de teste</button>` : `<button class="btn btn-sm btn-primary" data-ad="confirm-payment" data-pagamento="${esc(p.id)}" data-confirmar="Confirmar mesmo sem o gateway ter avisado o pagamento">Confirmar pagamento</button>`) : ""}</div>`).join("") : '<p class="admin-muted">Nenhum.</p>'}</div>
      </div>

      <h3 class="panel-title">Pedidos de conexão (localização aproximada e aparelho de quem pediu)</h3>
      ${d.connections.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Quando</th><th>Status</th><th>Número</th><th>IP</th><th>País/região</th><th>Aparelho</th><th>Obs.</th></tr></thead><tbody>${d.connections.map((c) => `<tr><td>${fmt(c.created_at)}</td><td>${esc(c.status)}</td><td>${val(c.phone_masked)}</td><td>${val(c.ip)}</td><td>${esc(ctx(c))}</td><td>${[c.context?.device, c.context?.os, c.context?.browser].filter(Boolean).map(esc).join(" · ") || ND}</td><td>${esc(c.reason || c.error || "")}</td></tr>`).join("")}</tbody></table></div>` : '<p class="admin-muted">Nenhum.</p>'}
      ${pagPend.length ? "" : ""}

      <h3 class="panel-title">Grupos e comandos</h3>
      <div id="botDetailGroups">${renderGrupos(d.groups, i.id)}</div>

      <div class="admin-two">
        <div><h3 class="panel-title">Histórico de eventos</h3><ul class="bot-events">${d.events.map((e) => `<li class="${e.severity === "error" ? "is-error" : e.severity === "warning" ? "is-warn" : ""}"><small>${fmt(e.created_at)} · ${esc(e.actor_type)}${e.visibility === "admin" ? " · interno" : ""}</small> ${esc(e.message || e.event)}</li>`).join("") || "<li>Nada ainda.</li>"}</ul></div>
        <div><h3 class="panel-title">Erros e avisos (logs resumidos)</h3><ul class="bot-events bot-logs">${d.logs.map((l) => `<li class="${l.level === "error" ? "is-error" : "is-warn"}"><small>${fmt(l.created_at)}</small> ${esc(l.message)}</li>`).join("") || "<li>Nenhum.</li>"}</ul>
          <h3 class="panel-title">Tarefas do worker</h3><ul class="bot-events">${d.jobs.map((j) => `<li><small>${fmt(j.created_at)}</small> ${esc(j.type)} → ${esc(j.status)} (${esc(j.requested_by_type)})</li>`).join("") || "<li>Nenhuma.</li>"}</ul></div>
      </div>`;
    box.querySelectorAll("[data-ad]").forEach((b) => {
      b.onclick = () => {
        if (b.dataset.confirmar && !Sora.confirmTap(b, b.dataset.confirmar)) return;
        const action = b.dataset.ad;
        const body = { action, instance_id: i.id, reason: $("botMotivo").value.trim() || undefined };
        if (action === "change-plan" || action === "grant-subscription") { body.plan_code = $("botPlanoSel").value; body.days = Number($("botDias").value) || undefined; }
        if (action === "set-validity") { if (!$("botValidade").value) { Sora.toast("Escolha a nova data.", "error"); return; } body.period_end = new Date($("botValidade").value).toISOString(); }
        if (action === "assign-worker") body.worker_id = $("botWorkerSel").value;
        if (action === "note") body.text = $("botNota").value;
        if (action === "confirm-payment") body.payment_id = b.dataset.pagamento;
        executar(b, "admin-action", body, () => carregarLista());
      };
    });
    ligarGrupos(box, i.id);
  }

  let catalogo = null;
  function renderGrupos(grupos, instanceId) {
    if (!grupos?.length) return '<div class="admin-empty">Nenhum grupo informado por este bot.</div>';
    const cat = catalogo || [];
    return grupos.map((g) => `
      <details class="bot-group">
        <summary><strong>${esc(g.name || "Grupo sem nome")}</strong><span class="admin-muted">${esc(g.ref)} · ${g.member_count ?? "?"} membros · ${g.status} · ${g.bot_is_admin ? "bot admin" : "bot não admin"} · visto ${fmt(g.last_seen_at)}</span></summary>
        <p class="admin-muted">Primeira vez: ${fmt(g.first_seen_at)} · última atividade: ${fmt(g.last_activity_at)} · comandos: ${g.commands_count}</p>
        <div class="settings-list">${cat.map((c) => {
          const s = g.settings[c.key];
          const atual = s ? s.enabled : (g.actual[c.key] ?? (c.key.startsWith("category:") || c.key === "feature:respostas_automaticas" || c.key === "feature:divulgacao_automatica"));
          return `<div class="setting-row"><div><strong>${esc(c.label)}</strong><p>${s ? `alterado por ${s.by === "admin" ? "administração" : "dono"} em ${fmt(s.at)}${s.pending ? " · aplicando…" : ""}` : "sem alteração pelo painel"}</p></div>
            <label class="switch"><input type="checkbox" data-g="${esc(g.id)}" data-k="${esc(c.key)}" data-inst="${esc(instanceId)}" ${atual ? "checked" : ""} aria-label="${esc(c.label)}"><span></span></label></div>`;
        }).join("")}</div>
        ${Object.entries(g.settings).filter(([k]) => k.startsWith("cmd:")).map(([k, s]) => `<span class="chip-static">${esc(k.slice(4))}: ${s.enabled ? "ligado" : "desligado"}</span>`).join(" ")}
        ${g.recent_events?.length ? `<ul class="bot-events">${g.recent_events.map((e) => `<li><small>${fmt(e.at)}</small> ${esc(e.event)}</li>`).join("")}</ul>` : ""}
      </details>`).join("");
  }
  function ligarGrupos(raiz) {
    raiz.querySelectorAll("input[data-g]").forEach((inp) => {
      inp.onchange = async () => {
        inp.disabled = true;
        const r = await api("admin-group-setting", { body: { instance_id: inp.dataset.inst, group_id: inp.dataset.g, key: inp.dataset.k, enabled: inp.checked } }).catch(() => null);
        inp.disabled = false;
        if (!r?.ok) { inp.checked = !inp.checked; Sora.toast(r?.body?.message || "Não foi possível salvar.", "error"); return; }
        Sora.toast(r.body.message, "ok", 3500);
      };
    });
  }

  async function garantirCatalogo() {
    if (catalogo) return;
    // O catálogo público vem junto do status do usuário (mesma lista do servidor).
    const r = await api("status").catch(() => null);
    catalogo = r?.ok ? r.body.catalog : [];
  }

  window.SoraAdmin.registrarAba("bots", async () => { await garantirCatalogo(); await carregarLista(); });
  $("botSearchForm").onsubmit = (e) => { e.preventDefault(); carregarLista(); };

  /* ================= Grupos dos bots ================= */
  window.SoraAdmin.registrarAba("botgroups", async () => {
    await garantirCatalogo();
    const sel = $("botGroupsInstance");
    const box = $("botGroupsList");
    if (sel.options.length <= 1) {
      const r = await api("admin-list");
      if (r.ok) sel.insertAdjacentHTML("beforeend", r.body.instances.map((i) => `<option value="${esc(i.id)}">${esc(i.name)}${i.is_main ? " (principal)" : ""}</option>`).join(""));
      sel.onchange = () => window.SoraAdmin.carregarGrupos();
    }
    await window.SoraAdmin.carregarGrupos();
    void box;
  });
  window.SoraAdmin.carregarGrupos = async () => {
    const id = $("botGroupsInstance").value;
    const box = $("botGroupsList");
    box.innerHTML = '<div class="admin-empty">Carregando…</div>';
    const r = await api("admin-groups", { query: id ? `&instance_id=${encodeURIComponent(id)}` : "" });
    if (!r.ok) return erroNaTela(box, r);
    if (id) { box.innerHTML = renderGrupos(r.body.groups, id); ligarGrupos(box); return; }
    box.innerHTML = r.body.groups.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Grupo</th><th>ID protegido</th><th>Bot</th><th>Membros</th><th>Comandos</th><th>Última atividade</th><th>Visto</th></tr></thead><tbody>${r.body.groups.map((g) => `<tr><td>${esc(g.name || "—")}</td><td>${esc(g.ref)}</td><td>${esc(g.instance_name)}${g.is_main ? " (principal)" : ""}</td><td>${g.member_count ?? "?"}</td><td>${g.commands_count}</td><td>${fmt(g.last_activity_at)}</td><td>${fmt(g.last_seen_at)}</td></tr>`).join("")}</tbody></table></div><p class="field-hint">Escolha um bot acima para ligar/desligar funções de cada grupo.</p>` : '<div class="admin-empty">Nenhum grupo informado pelos bots ainda.</div>';
  };

  /* ================= Planos ================= */
  function formPlano(p = {}) {
    $("botPlanTitle").textContent = p.code ? `Editar plano ${p.name}` : "Novo plano";
    $("botPlanFormBox").innerHTML = `<form id="botPlanForm" class="admin-form" novalidate><div class="admin-form-grid">
      <label>Código<input id="bpCode" value="${esc(p.code || "")}" ${p.code ? "readonly" : ""} maxlength="40" placeholder="mensal"></label>
      <label>Nome<input id="bpName" value="${esc(p.name || "")}" maxlength="60"></label>
      <label>Período<select id="bpPeriod">${Object.entries(PERIODO).map(([k, v]) => `<option value="${k}" ${p.period === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <label>Duração (dias)<input id="bpDays" type="number" min="1" max="400" value="${p.duration_days || 30}"></label>
      <label>Preço (R$)<input id="bpPrice" type="number" min="0" step="0.01" value="${p.price ?? ""}"></label>
      <label>Dias de teste<input id="bpTrial" type="number" min="0" max="30" value="${p.trial_days || 0}"></label>
      <label>Máximo de grupos<input id="bpMax" type="number" min="1" max="1000" value="${p.limits?.max_groups || ""}"></label>
      <label>Ordem<input id="bpOrder" type="number" value="${p.display_order || 0}"></label>
      <label class="wide">Descrição<textarea id="bpDesc" maxlength="600">${esc(p.description || "")}</textarea></label>
      <label class="wide">Recursos (um por linha)<textarea id="bpFeat" maxlength="1500">${esc((p.features || []).join("\n"))}</textarea></label>
      <label><span>Ativo (aparece para os usuários)</span><input id="bpActive" type="checkbox" ${p.active === false ? "" : "checked"}></label>
    </div><div class="admin-actions"><button class="btn btn-primary" type="submit">Salvar plano</button><button class="btn btn-ghost" type="button" id="bpNovo">Novo</button></div>
    <p class="field-hint">Mudar o preço vale para novas assinaturas e renovações. Quem já pagou mantém o valor contratado até renovar.</p></form>`;
    $("bpNovo").onclick = () => formPlano();
    $("botPlanForm").onsubmit = (e) => {
      e.preventDefault();
      executar(e.submitter || $("botPlanForm").querySelector("button"), "admin-plan-save", {
        code: $("bpCode").value.trim(), name: $("bpName").value.trim(), period: $("bpPeriod").value, duration_days: Number($("bpDays").value),
        price: Number($("bpPrice").value), trial_days: Number($("bpTrial").value) || 0, limits: { max_groups: Number($("bpMax").value) || null },
        display_order: Number($("bpOrder").value) || 0, description: $("bpDesc").value, features: $("bpFeat").value.split("\n").map((x) => x.trim()).filter(Boolean),
        active: $("bpActive").checked
      }, async () => { planos = []; await carregarPlanos(); });
    };
  }
  async function carregarPlanos() {
    const r = await api("admin-plans");
    const box = $("botPlansList");
    if (!r.ok) return erroNaTela(box, r);
    planos = r.body.plans;
    box.innerHTML = planos.map((p) => `<div class="admin-item"><div class="admin-item-head"><div><h3>${esc(p.name)} <small class="admin-muted">(${esc(p.code)})</small></h3><p class="admin-muted">${PERIODO[p.period]} · ${p.duration_days} dias · ${dinheiro(p.price)}${p.trial_days ? ` · ${p.trial_days} dias de teste` : ""}${p.limits?.max_groups ? ` · até ${p.limits.max_groups} grupos` : ""}</p></div><span class="status-badge ${p.active ? "approved" : "suspended"}">${p.active ? "Ativo" : "Inativo"}</span></div><div class="admin-actions"><button class="btn btn-sm" data-editar="${esc(p.code)}">Editar</button></div></div>`).join("") || '<div class="admin-empty">Nenhum plano.</div>';
    box.querySelectorAll("[data-editar]").forEach((b) => { b.onclick = () => { formPlano(planos.find((p) => p.code === b.dataset.editar)); $("botPlanFormBox").scrollIntoView({ behavior: "smooth" }); }; });
  }
  window.SoraAdmin.registrarAba("botplans", async () => { formPlano(); await carregarPlanos(); });

  /* ================= Workers e ajustes ================= */
  function formWorker(w = {}) {
    $("botWorkerTitle").textContent = w.id ? `Editar worker ${w.name}` : "Novo worker";
    $("botWorkerFormBox").innerHTML = `<form id="botWorkerForm" class="admin-form" novalidate><div class="admin-form-grid">
      <label>Nome<input id="bwName" value="${esc(w.name || "")}" maxlength="40" placeholder="celular-ivad"></label>
      <label>Tipo<select id="bwKind">${[["phone", "Celular (teste)"], ["vps", "VPS"], ["pterodactyl", "Pterodactyl"], ["other", "Outro"]].map(([k, v]) => `<option value="${k}" ${w.kind === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <label>Região <span class="field-optional">opcional</span><input id="bwRegion" value="${esc(w.region || "")}" maxlength="60" placeholder="SP"></label>
      <label>Capacidade (bots)<input id="bwCap" type="number" min="0" max="500" value="${w.capacity ?? 2}"></label>
      <label>Situação<select id="bwStatus"><option value="online">Normal</option><option value="maintenance" ${w.status === "maintenance" ? "selected" : ""}>Em manutenção</option><option value="disabled" ${w.status === "disabled" ? "selected" : ""}>Desativado</option></select></label>
      <label><span>Aceita bots novos</span><input id="bwNew" type="checkbox" ${w.accepts_new === false ? "" : "checked"}></label>
      <label class="wide">Observações<textarea id="bwNotes" maxlength="500">${esc(w.notes || "")}</textarea></label>
    </div><div class="admin-actions"><button class="btn btn-primary" type="submit">Salvar worker</button><button class="btn btn-ghost" type="button" id="bwNovo">Novo</button></div></form>`;
    $("bwNovo").onclick = () => formWorker();
    $("botWorkerForm").onsubmit = (e) => {
      e.preventDefault();
      executar($("botWorkerForm").querySelector("button"), "admin-worker-save", {
        id: w.id, name: $("bwName").value.trim(), kind: $("bwKind").value, region: $("bwRegion").value.trim(), capacity: Number($("bwCap").value),
        status: $("bwStatus").value, accepts_new: $("bwNew").checked, notes: $("bwNotes").value
      }, async () => { workers = []; await carregarWorkers(); formWorker(); });
    };
  }
  async function carregarWorkers() {
    const [rw, rc] = await Promise.all([api("admin-workers"), api("admin-settings")]);
    const box = $("botWorkersList");
    if (!rw.ok) return erroNaTela(box, rw);
    workers = rw.body.workers;
    box.innerHTML = workers.map((w) => {
      const m = w.metrics || {};
      return `<div class="admin-item"><div class="admin-item-head"><div><h3>${esc(w.name)} <small class="admin-muted">${esc(w.kind)}${w.region ? ` · ${esc(w.region)}` : ""}</small></h3>
        <p class="admin-muted">Último sinal: ${fmt(w.last_heartbeat_at)} · IP: ${val(w.last_ip)} · agente ${val(w.agent_version)} · bots ${w.instances}/${w.capacity}${w.accepts_new ? "" : " · não aceita novos"}</p></div>
        <span class="status-badge ${w.status === "disabled" ? "suspended" : w.online ? "approved" : "pending"}">${w.status === "disabled" ? "Desativado" : w.status === "maintenance" ? "Em manutenção" : w.online ? "Online" : "Worker indisponível"}</span></div>
        <dl class="bot-info bot-info-compact">
          <div><dt>Disco livre</dt><dd>${m.disk_free_mb != null ? `${m.disk_free_mb} MB` : ND}</dd></div>
          <div><dt>Memória livre</dt><dd>${m.mem_free_mb != null ? `${m.mem_free_mb} MB` : ND}</dd></div>
          <div><dt>Temperatura</dt><dd>${m.temp_c != null ? `${m.temp_c} °C` : ND}</dd></div>
          <div><dt>Bateria</dt><dd>${m.battery_pct != null ? `${m.battery_pct}%${m.charging ? " (carregando)" : ""}` : ND}</dd></div>
          <div><dt>Sistema</dt><dd>${val(m.platform)} · Node ${val(m.node)}</dd></div>
          <div><dt>Ligado há</dt><dd>${m.uptime_s != null ? `${Math.round(m.uptime_s / 3600)} h` : ND}</dd></div>
        </dl>
        <div class="admin-actions"><button class="btn btn-sm" data-wedit="${esc(w.id)}">Editar</button><button class="btn btn-sm" data-wtoken="${esc(w.id)}" data-confirmar="${w.has_token ? "Gerar outro (o atual para de funcionar)" : "Confirmar"}">${w.has_token ? "Trocar token" : "Gerar token"}</button></div>
        <div data-token-box="${esc(w.id)}"></div></div>`;
    }).join("") || '<div class="admin-empty">Nenhum worker. Crie um abaixo e gere o token para configurar o celular/servidor.</div>';
    box.querySelectorAll("[data-wedit]").forEach((b) => { b.onclick = () => { formWorker(workers.find((w) => w.id === b.dataset.wedit)); $("botWorkerFormBox").scrollIntoView({ behavior: "smooth" }); }; });
    box.querySelectorAll("[data-wtoken]").forEach((b) => {
      b.onclick = async () => {
        if (!Sora.confirmTap(b, b.dataset.confirmar)) return;
        const out = await executar(b, "admin-worker-token", { worker_id: b.dataset.wtoken });
        if (!out?.token) return;
        const alvo = box.querySelector(`[data-token-box="${b.dataset.wtoken}"]`);
        alvo.innerHTML = `<div class="inline-alert"><div><strong>Token do worker — aparece só agora.</strong> Copie e salve no aparelho em <code>segredos/worker.token</code> (permissão 600). Não mande por mensagem nem coloque no GitHub.<div class="bot-token"><code>${esc(out.token)}</code></div><button class="btn btn-sm" type="button" data-copiar>Copiar</button> <button class="btn btn-sm btn-ghost" type="button" data-esconder>Já copiei, esconder</button></div></div>`;
        alvo.querySelector("[data-copiar]").onclick = async () => { try { await navigator.clipboard.writeText(out.token); Sora.toast("Copiado.", "ok"); } catch { Sora.toast("Selecione e copie manualmente.", "error"); } };
        alvo.querySelector("[data-esconder]").onclick = () => { alvo.innerHTML = ""; };
      };
    });
    if (rc.ok) {
      const s = rc.body.settings;
      $("botSettingsBox").innerHTML = `<form id="botSettingsForm" class="admin-form" novalidate><div class="settings-list">
        <div class="setting-row"><div><strong>Mostrar "Meu bot" para os usuários</strong><p>Desligado, ninguém assina nem conecta; o resto do site segue igual.</p></div><label class="switch"><input type="checkbox" id="bsEnabled" ${s.bot_platform_enabled ? "checked" : ""}><span></span></label></div>
        <div class="setting-row"><div><strong>Exigir aprovação da equipe para conectar</strong><p>Recomendado na fase de testes.</p></div><label class="switch"><input type="checkbox" id="bsApproval" ${s.bot_require_approval ? "checked" : ""}><span></span></label></div>
      </div><div class="admin-form-grid">
        <label>Dias de teste grátis (0 = sem teste)<input id="bsTrial" type="number" min="0" max="30" value="${s.bot_trial_days}"></label>
        <label>Bots por conta<input id="bsMax" type="number" min="1" max="10" value="${s.bot_max_instances_per_user}"></label>
        <label>Guardar logs resumidos no banco por<select id="bsRet">${[3, 7, 15, 30].map((d) => `<option value="${d}" ${s.bot_log_retention_days === d ? "selected" : ""}>${d} dias</option>`).join("")}</select></label>
        <label>Pagamentos<select id="bsPayment"><option value="mercadopago" ${s.bot_payment_mode === "mercadopago" ? "selected" : ""}>Mercado Pago</option><option value="manual_test" ${s.bot_payment_mode === "manual_test" ? "selected" : ""}>Teste manual</option></select></label>
      </div><p class="field-hint">Mercado Pago exige as credenciais de produção configuradas na Vercel. O pagamento só deve liberar a hospedagem após confirmação pelo webhook.</p>
      <div class="admin-actions"><button class="btn btn-primary" type="submit">Salvar ajustes</button><button class="btn" type="button" id="bsMain">Registrar bot principal (só monitoramento)</button></div></form>`;
      $("botSettingsForm").onsubmit = (e) => {
        e.preventDefault();
        executar($("botSettingsForm").querySelector('button[type="submit"]'), "admin-settings", {
          bot_platform_enabled: $("bsEnabled").checked, bot_require_approval: $("bsApproval").checked, bot_trial_days: Number($("bsTrial").value) || 0,
          bot_max_instances_per_user: Number($("bsMax").value) || 1, bot_log_retention_days: Number($("bsRet").value), bot_payment_mode: $("bsPayment").value
        });
      };
      $("bsMain").onclick = (e) => executar(e.currentTarget, "admin-create-main", { worker_id: workers[0]?.id, name: "SORASAKI (principal)" });
    } else erroNaTela($("botSettingsBox"), rc);
  }
  window.SoraAdmin.registrarAba("botworkers", async () => { formWorker(); await carregarWorkers(); });

  /* ================= Pagamentos ================= */
  window.SoraAdmin.registrarAba("botpayments", async () => { await carregarPagamentos(); });
  async function carregarPagamentos() {
    const box = $("botPaymentsList");
    box.innerHTML = '<div class="admin-empty">Carregando…</div>';
    const status = $("botPaySel").value;
    const r = await api("admin-payments", { query: `&status=${encodeURIComponent(status)}&limit=200` });
    if (!r.ok) return erroNaTela(box, r);
    const linhas = r.body.payments || [];
    box.innerHTML = linhas.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Quando</th><th>Cliente</th><th>Plano</th><th>Valor</th><th>Método</th><th>Status</th><th>Ação</th></tr></thead><tbody>${linhas.map((p) => `<tr><td>${fmt(p.created_at)}</td><td>${esc(p.user)}</td><td>${esc(p.plan || "—")}</td><td>${dinheiro(p.amount)}${p.is_test ? ' <span class="chip-static">teste</span>' : ""}</td><td>${esc(p.gateway)}</td><td>${esc(p.status)}${p.gateway_status ? ` (${esc(p.gateway_status)})` : ""}</td><td>${p.status === "pending" && p.instance_id ? (p.is_test ? `<button class="btn btn-sm btn-primary" data-confirmarpg="${esc(p.id)}" data-instancia="${esc(p.instance_id)}">Confirmar</button>` : `<button class="btn btn-sm btn-primary" data-confirmarpg="${esc(p.id)}" data-instancia="${esc(p.instance_id)}" data-confirmar="Confirmar mesmo sem o gateway ter avisado o pagamento">Confirmar</button>`) : "—"}</td></tr>`).join("")}</tbody></table></div>` : '<div class="admin-empty">Nada por aqui.</div>';
    $("botPaySel").onchange = carregarPagamentos;
    box.querySelectorAll("[data-confirmarpg]").forEach((b) => {
      b.onclick = () => {
        if (b.dataset.confirmar && !Sora.confirmTap(b, b.dataset.confirmar)) return;
        executar(b, "admin-action", { action: "confirm-payment", instance_id: b.dataset.instancia, payment_id: b.dataset.confirmarpg }, carregarPagamentos);
      };
    });
  }
  document.querySelector('[data-reload="botpayments"]')?.addEventListener("click", carregarPagamentos);

  /* ================= Auditoria ================= */
  window.SoraAdmin.registrarAba("botaudit", async () => {
    const box = $("botAuditList");
    box.innerHTML = '<div class="admin-empty">Carregando…</div>';
    const r = await api("admin-audit", { query: "&limit=200" });
    if (!r.ok) return erroNaTela(box, r);
    box.innerHTML = r.body.audit.length ? `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Quando</th><th>Admin</th><th>Ação</th><th>Instância</th><th>Usuário</th><th>IP</th><th>Resultado</th><th>Motivo</th></tr></thead><tbody>${r.body.audit.map((a) => `<tr><td>${fmt(a.created_at)}</td><td>${esc(a.admin || "—")}</td><td>${esc(a.action)}</td><td>${a.instance_id ? esc(a.instance_id.slice(0, 8)) : "—"}</td><td>${a.user_id ? esc(a.user_id.slice(0, 8)) : "—"}</td><td>${val(a.ip)}</td><td>${esc(a.result || "—")}</td><td>${esc(a.reason || "")}</td></tr>`).join("")}</tbody></table></div>` : '<div class="admin-empty">Nenhuma ação registrada ainda.</div>';
  });
})();
