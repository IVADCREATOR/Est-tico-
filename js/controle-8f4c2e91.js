// Script da página controle-8f4c2e91.html (antes ficava inline no HTML).
// Fica em arquivo separado para o CSP não precisar de 'unsafe-inline' em scripts.
(function () {
  const auth = window.SorasakiAuth;
  const $ = (id) => document.getElementById(id);
  const esc = escapeHtml;
  const CAT = { vendas: "Compra e venda", comunidade: "Comunidade", jogos: "Jogos", freefire: "Free Fire", divulgacao: "Divulgação", amizades: "Amizades", suporte: "Suporte", estudos: "Estudos", outros: "Outros" };
  const GROUP_STATUS = { pending: "Pendente", approved: "Publicada", rejected: "Recusada", removed: "Removida" };
  let client = null;
  let user = null;
  let started = false;
  const cache = {};

  /* ---------- Utilidades ---------- */
  const fmt = (d) => (d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");
  // datetime-local trabalha no horário local; toISOString() deslocaria 3 horas.
  const dtLocal = (d) => {
    if (!d) return "";
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
  };
  const fromLocal = (v) => (v ? new Date(v).toISOString() : null);
  const num = (v) => (v === "" || v == null ? null : Number(v));
  const result = (id, type, msg) => Sora.showResult($(id), type, msg);
  const dbError = (error, fallback = "Não foi possível salvar. Tente novamente.") => {
    console.warn("[SORASAKI] Painel:", error);
    if (error?.code === "23505") return "Já existe um registro com esse valor (nome, código ou endereço repetido).";
    if (error?.code === "23514") return "Algum valor está fora do permitido. Confira os campos.";
    if (error?.code === "42P01" || String(error?.message || "").includes("does not exist")) return "Esta área ainda não foi configurada no banco. Execute o SQL de atualização do projeto.";
    return Sora.friendlyError(error, fallback);
  };
  const empty = (msg) => `<div class="admin-empty">${esc(msg)}</div>`;
  async function count(table, filters = []) {
    let q = client.from(table).select("*", { count: "exact", head: true });
    filters.forEach(([col, val]) => { q = q.eq(col, val); });
    const r = await q;
    return r.error ? null : r.count || 0;
  }
  async function logAction(action, entity, id, details = {}) {
    try { await client.rpc("log_admin_activity", { p_action: action, p_entity: entity, p_entity_id: id == null ? null : String(id), p_details: details }); } catch {}
  }
  function scrollToForm(formId) {
    $(formId).closest(".panel").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- Acesso ---------- */
  async function checkAccess() {
    await auth.ready;
    client = auth.getClient();
    user = auth.getUser();
    const msg = $("adminMessage");
    if (!client) { msg.innerHTML = Sora.emptyState("Não foi possível carregar o painel.", "Recarregue a página em alguns instantes.", { retry: true }); msg.querySelector("[data-retry]").onclick = () => location.reload(); return; }
    if (!user) {
      $("adminContent").hidden = true;
      msg.hidden = false;
      msg.innerHTML = '<div class="empty-state"><strong>Área restrita</strong><span>Entre com uma conta administradora para continuar.</span><button class="btn btn-primary btn-sm" type="button" data-login>Entrar</button></div>';
      msg.querySelector("[data-login]").onclick = () => auth.open("login");
      return;
    }
    const { data, error } = await client.from("profiles").select("role,account_status").eq("user_id", user.id).maybeSingle();
    if (error || data?.role !== "admin" || (data?.account_status || "active") !== "active") {
      $("adminContent").hidden = true;
      msg.hidden = false;
      msg.innerHTML = '<div class="empty-state"><strong>Acesso não disponível</strong><span>Esta área é reservada à administração.</span><a class="btn btn-sm" href="/">Voltar ao site</a></div>';
      return;
    }
    // Com verificação em duas etapas ativada, os poderes de admin só valem
    // depois do código (o banco e as APIs exigem a sessão confirmada — AAL2).
    const nivel = await auth.mfaLevel();
    if (nivel && nivel.nextLevel === "aal2" && nivel.currentLevel !== "aal2") {
      $("adminContent").hidden = true;
      msg.hidden = false;
      msg.innerHTML = '<div class="empty-state"><strong>Confirme a verificação em duas etapas</strong><span>Digite o código do seu app autenticador para usar o painel.</span><button class="btn btn-primary btn-sm" type="button" data-mfa>Digitar código</button></div>';
      msg.querySelector("[data-mfa]").onclick = () => auth.open("mfa");
      return;
    }
    msg.hidden = true;
    $("adminContent").hidden = false;
    $("adminWho").textContent = `Conectado como ${user.email}`;
    $("adminMfaTip").hidden = Boolean(nivel && nivel.nextLevel === "aal2");
    if (!started) { started = true; start(); }
  }
  auth.onAuthChange((u, event) => {
    if (event === "INITIAL") return;
    if (event === "MFA_CHALLENGE_VERIFIED" || (u?.id || null) !== (user?.id || null)) { started = false; checkAccess(); }
  });
  $("adminMfaOpen").onclick = () => auth.openProfile();

  /* ---------- Abas ---------- */
  const LOADERS = {};
  function openTab(name) {
    document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".admin-view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
    try { history.replaceState(null, "", `#${name}`); } catch {}
    LOADERS[name]?.();
  }
  document.querySelectorAll("[data-tab]").forEach((b) => { b.onclick = () => { openTab(b.dataset.tab); b.scrollIntoView({ block: "nearest", inline: "center" }); }; });
  document.querySelectorAll("[data-reload]").forEach((b) => { b.onclick = () => LOADERS[b.dataset.reload]?.(); });
  // Módulos extras do painel (ex.: js/admin-bots.js) registram as próprias abas aqui.
  window.SoraAdmin = { registrarAba: (nome, fn) => { LOADERS[nome] = fn; } };

  async function refreshCounts() {
    const [g, r, rp, bugs] = await Promise.all([
      count("groups", [["status", "pending"]]),
      count("reviews", [["status", "pending"]]),
      count("reports", [["status", "open"]]),
      count("bug_reports", [["status", "open"]])
    ]);
    const set = (k, v) => { const el = document.querySelector(`[data-count="${k}"]`); if (!el) return; el.hidden = !v; el.textContent = v || ""; };
    set("groups", g); set("reviews", r); set("reports", rp); set("feedback", bugs);
    return { g, r, rp, bugs };
  }

  /* ---------- Resumo ---------- */
  LOADERS.dashboard = async () => {
    $("kpis").innerHTML = '<div class="admin-kpi"><b class="skeleton">—</b><span>Carregando</span></div>'.repeat(4);
    const [pend, users, verified, approved, official, news, analytics, activity] = await Promise.all([
      refreshCounts(),
      count("profiles"), count("profiles", [["email_confirmed", true]]), count("groups", [["status", "approved"]]),
      count("official_groups", [["active", true]]), count("news", [["status", "published"]]),
      Sora.fetchJson("/api/account-actions?type=site-analytics").then((r) => (r.ok ? r.body?.website : null)).catch(() => null),
      client.from("admin_activity").select("action,entity,entity_id,created_at").order("created_at", { ascending: false }).limit(8)
    ]);
    const kpi = (v, label) => `<div class="admin-kpi"><b>${v == null ? "—" : fmtNumero(v)}</b><span>${label}</span></div>`;
    $("kpis").innerHTML = [
      kpi(users, "Contas"), kpi(verified, "E-mails confirmados"), kpi(approved, "Divulgações publicadas"), kpi(official, "Grupos oficiais"),
      kpi(news, "Notícias publicadas"), kpi(analytics?.unique_visitors_today, "Visitantes hoje"), kpi(analytics?.unique_visitors_total, "Visitantes no total"), kpi(analytics?.page_views_total, "Páginas vistas")
    ].join("");
    const fila = [
      ["groups", pend.g, "divulgação aguardando análise", "divulgações aguardando análise"],
      ["reviews", pend.r, "avaliação aguardando aprovação", "avaliações aguardando aprovação"],
      ["reports", pend.rp, "relato de grupo aberto", "relatos de grupos abertos"],
      ["feedback", pend.bugs, "relato de bug aberto", "relatos de bug abertos"]
    ].filter(([, n]) => n);
    $("dashQueue").innerHTML = fila.length
      ? fila.map(([tab, n, um, varios]) => `<button class="profile-action" type="button" data-goto="${tab}"><div><strong>${fmtNumero(n)} ${n === 1 ? um : varios}</strong><small>Abrir para revisar</small></div><b>›</b></button>`).join("")
      : empty("Nada pendente. Tudo em dia.");
    $("dashQueue").querySelectorAll("[data-goto]").forEach((b) => { b.onclick = () => openTab(b.dataset.goto); });
    $("dashActivity").innerHTML = (activity.data || []).map(activityItem).join("") || empty("Nenhuma atividade registrada ainda.");
  };

  /* ---------- Estatísticas ---------- */
  LOADERS.stats = async () => {
    $("statsContent").innerHTML = '<div class="skeleton" style="height:120px"></div>';
    const [u, v, g, p, o, n, c, r, a] = await Promise.all([
      count("profiles"), count("profiles", [["email_confirmed", true]]), count("groups"), count("groups", [["status", "approved"]]),
      count("official_groups", [["active", true]]), count("news", [["status", "published"]]), count("coupons", [["active", true]]), count("reports", [["status", "open"]]),
      Sora.fetchJson("/api/account-actions?type=site-analytics").then((x) => (x.ok ? x.body?.website : null)).catch(() => null)
    ]);
    const w = a || {};
    const kpi = (v, label) => `<div class="admin-kpi"><b>${v == null ? "—" : fmtNumero(v)}</b><span>${label}</span></div>`;
    $("statsContent").innerHTML = `<div class="admin-kpis">${[kpi(u, "Contas"), kpi(v, "Confirmadas"), kpi(g, "Divulgações"), kpi(p, "Publicadas"), kpi(o, "Oficiais ativos"), kpi(n, "Notícias"), kpi(c, "Cupons ativos"), kpi(r, "Relatos abertos"), kpi(w.unique_visitors_total, "Visitantes únicos"), kpi(w.page_views_total, "Páginas vistas")].join("")}</div>
      <div class="admin-two" style="margin-top:16px">
        <div class="panel"><h2 class="panel-title">Hoje</h2><p>${fmtNumero(w.unique_visitors_today)} visitantes únicos</p><p>${fmtNumero(w.page_views_today)} páginas vistas</p></div>
        <div class="panel"><h2 class="panel-title">Páginas mais acessadas</h2>${(w.top_pages || []).map((x) => `<p><strong>${esc(x.path)}</strong> · ${fmtNumero(x.page_views)}</p>`).join("") || '<p class="admin-muted">Nenhuma visita registrada ainda.</p>'}</div>
      </div>
      ${a ? "" : '<p class="admin-muted" style="margin-top:12px">As visitas ao site não puderam ser carregadas agora.</p>'}
      <p class="admin-muted" style="margin-top:12px">As visitas usam um identificador aleatório do navegador; nenhum IP é armazenado.</p>`;
  };

  /* ---------- Divulgações ---------- */
  LOADERS.groups = async () => {
    const box = $("groupsList");
    box.innerHTML = '<div class="skeleton" style="height:120px"></div>';
    const status = $("groupStatus").value;
    let q = client.from("groups").select("id,owner_id,name,platform,description,category,invite_url,avatar_url,member_count,status,admin_note,admin_badge,featured_by_admin,created_at,view_count,tags,contact_url,highlight").order("created_at", { ascending: status === "pending" }).limit(300);
    if (status !== "all") q = q.eq("status", status);
    const { data, error } = await q;
    if (error) { box.innerHTML = empty("Não foi possível carregar as divulgações."); console.warn(error); return; }
    const owners = [...new Set((data || []).map((g) => g.owner_id))];
    let donos = {};
    if (owners.length) {
      const pr = await client.from("profiles").select("user_id,username,email").in("user_id", owners);
      donos = Object.fromEntries((pr.data || []).map((p) => [p.user_id, p]));
    }
    cache.groups = data || [];
    const term = $("groupSearch").value.trim().toLowerCase();
    const rows = cache.groups.filter((g) => !term || `${g.name} ${g.description} ${g.platform} ${CAT[g.category]} ${donos[g.owner_id]?.email || ""} ${donos[g.owner_id]?.username || ""}`.toLowerCase().includes(term));
    box.innerHTML = rows.map((g) => {
      const dono = donos[g.owner_id];
      const img = Sora.safeUrl(g.avatar_url);
      return `<article class="admin-item" data-group="${g.id}">
        <div class="admin-item-head">
          <div style="display:flex;gap:12px;align-items:flex-start"><div class="group-icon" style="width:44px;height:44px">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : esc(Sora.initials(g.name))}</div><div style="min-width:0"><h3>${esc(g.name)}</h3><div class="admin-muted">${esc(CAT[g.category] || g.category)} · ${esc(g.platform || "Plataforma não informada")} · ${fmtNumero(g.member_count || 0)} membros · ${fmtNumero(g.view_count || 0)} visitas</div><div class="admin-muted">Enviada por ${esc(dono?.username ? "@" + dono.username : "conta")} ${dono?.email ? "(" + esc(dono.email) + ")" : ""} em ${fmt(g.created_at)}</div></div></div>
          <span class="status-badge ${esc(g.status)}">${GROUP_STATUS[g.status] || esc(g.status)}</span>
        </div>
        ${g.highlight ? `<div class="group-highlight">${esc(g.highlight)}</div>` : ""}
        <p>${esc(g.description)}</p>
        ${g.tags ? `<div class="admin-muted">Tags: ${esc(g.tags)}</div>` : ""}
        <div class="admin-actions"><a class="btn btn-sm" href="${esc(Sora.safeUrl(g.invite_url))}" target="_blank" rel="noopener noreferrer">Testar link ↗</a>${g.contact_url ? `<a class="btn btn-sm btn-ghost" href="${esc(Sora.safeUrl(g.contact_url))}" target="_blank" rel="noopener noreferrer">Contato ↗</a>` : ""}</div>
        <div class="admin-actions">
          <select data-f="status" aria-label="Situação">${Object.entries(GROUP_STATUS).map(([k, v]) => `<option value="${k}" ${g.status === k ? "selected" : ""}>${v}</option>`).join("")}</select>
          <select data-f="badge" aria-label="Selo"><option value="">Sem selo</option><option value="indicado" ${g.admin_badge === "indicado" ? "selected" : ""}>Selo: Indicado</option><option value="parceiro" ${g.admin_badge === "parceiro" ? "selected" : ""}>Selo: Parceiro</option><option value="oficial" ${g.admin_badge === "oficial" ? "selected" : ""}>Selo: Oficial</option></select>
          <label class="check" style="padding:8px 12px;min-height:40px;align-items:center"><input type="checkbox" data-f="featured" ${g.featured_by_admin ? "checked" : ""}><span>Destacar</span></label>
        </div>
        <div class="admin-actions">
          <input data-f="note" maxlength="500" placeholder="Nota para o dono (motivo da recusa, ajuste pedido…)" value="${esc(g.admin_note || "")}">
          <button class="btn btn-primary btn-sm" type="button" data-act="save">Salvar decisão</button>
          ${g.status === "pending" ? '<button class="btn btn-sm" type="button" data-act="approve">Aprovar agora</button>' : ""}
        </div>
      </article>`;
    }).join("") || empty(status === "pending" ? "Nenhuma divulgação aguardando análise." : "Nenhuma divulgação encontrada.");
  };
  $("groupsList").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const item = btn.closest("[data-group]");
    const id = Number(item.dataset.group);
    const get = (f) => item.querySelector(`[data-f="${f}"]`);
    let status = btn.dataset.act === "approve" ? "approved" : get("status").value;
    const featured = get("featured").checked && status === "approved";
    const patch = {
      status,
      admin_note: get("note").value.trim() || null,
      admin_badge: get("badge").value || null,
      featured_by_admin: featured,
      approved_at: status === "approved" ? new Date().toISOString() : null
    };
    Sora.setBusy(btn, true, "Salvando…");
    const { error } = await client.from("groups").update(patch).eq("id", id);
    Sora.setBusy(btn, false);
    if (error) { Sora.toast(dbError(error, "Não foi possível salvar a decisão."), "error"); return; }
    Sora.toast(status === "approved" ? "Divulgação publicada." : status === "rejected" ? "Divulgação recusada. O dono verá a nota." : "Decisão salva.", "ok");
    LOADERS.groups();
    refreshCounts();
  });
  let groupSearchTimer = null;
  $("groupSearch").addEventListener("input", () => { clearTimeout(groupSearchTimer); groupSearchTimer = setTimeout(LOADERS.groups, 250); });
  $("groupStatus").addEventListener("change", LOADERS.groups);

  /* ---------- Avaliações ---------- */
  LOADERS.reviews = async () => {
    const box = $("reviewsList");
    box.innerHTML = '<div class="skeleton" style="height:90px"></div>';
    const status = $("reviewStatus").value;
    let q = client.from("reviews").select("id,group_id,rating,comment,status,created_at,groups(name)").order("created_at", { ascending: false }).limit(200);
    if (status !== "all") q = q.eq("status", status);
    const { data, error } = await q;
    if (error) { box.innerHTML = empty(dbError(error, "Não foi possível carregar as avaliações.")); return; }
    const label = { pending: "Pendente", visible: "Aprovada", hidden: "Oculta" };
    box.innerHTML = (data || []).map((r) => `<article class="admin-item" data-review="${r.id}">
      <div class="admin-item-head"><div><h3>${"★".repeat(r.rating)}<span style="color:var(--faint)">${"★".repeat(5 - r.rating)}</span> · ${esc(r.groups?.name || "Grupo removido")}</h3><div class="admin-muted">${fmt(r.created_at)}</div></div><span class="status-badge ${esc(r.status)}">${label[r.status] || esc(r.status)}</span></div>
      <p>${esc(r.comment || "Sem comentário.")}</p>
      <div class="admin-actions">${r.status !== "visible" ? '<button class="btn btn-primary btn-sm" type="button" data-set="visible">Aprovar</button>' : ""}${r.status !== "hidden" ? '<button class="btn btn-sm" type="button" data-set="hidden">Ocultar</button>' : ""}<button class="btn btn-sm btn-danger" type="button" data-set="delete">Excluir</button></div>
    </article>`).join("") || empty(status === "pending" ? "Nenhuma avaliação aguardando aprovação." : "Nenhuma avaliação encontrada.");
  };
  $("reviewsList").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-set]");
    if (!btn) return;
    const id = Number(btn.closest("[data-review]").dataset.review);
    if (btn.dataset.set === "delete" && !Sora.confirmTap(btn, "Confirmar exclusão")) return;
    Sora.setBusy(btn, true);
    const { error } = btn.dataset.set === "delete" ? await client.from("reviews").delete().eq("id", id) : await client.from("reviews").update({ status: btn.dataset.set }).eq("id", id);
    Sora.setBusy(btn, false);
    if (error) { Sora.toast(dbError(error), "error"); return; }
    Sora.toast(btn.dataset.set === "visible" ? "Avaliação aprovada." : btn.dataset.set === "hidden" ? "Avaliação ocultada." : "Avaliação excluída.", "ok");
    LOADERS.reviews(); refreshCounts();
  });
  $("reviewStatus").addEventListener("change", LOADERS.reviews);

  /* ---------- Relatos ---------- */
  LOADERS.reports = async () => {
    const box = $("reportsList");
    box.innerHTML = '<div class="skeleton" style="height:90px"></div>';
    const status = $("reportStatus").value;
    let q = client.from("reports").select("id,group_id,reason,description,status,created_at,groups(name,invite_url,status)").order("created_at", { ascending: false }).limit(200);
    if (status !== "all") q = q.eq("status", status);
    const { data, error } = await q;
    if (error) { box.innerHTML = empty("Não foi possível carregar os relatos."); console.warn(error); return; }
    const motivo = { spam: "Spam", link_invalido: "Link não funciona", conteudo_inadequado: "Conteúdo inadequado", fraude: "Possível golpe", outro: "Outro motivo" };
    const st = { open: "Aberto", reviewing: "Em análise", resolved: "Resolvido", dismissed: "Descartado" };
    box.innerHTML = (data || []).map((r) => `<article class="admin-item" data-report="${r.id}" data-group-id="${r.group_id}">
      <div class="admin-item-head"><div><h3>${esc(r.groups?.name || "Grupo removido")}</h3><div class="admin-muted">${esc(motivo[r.reason] || r.reason)} · ${fmt(r.created_at)}</div></div><span class="status-badge ${esc(r.status)}">${st[r.status] || esc(r.status)}</span></div>
      <p>${esc(r.description || "Sem detalhes adicionais.")}</p>
      <div class="admin-actions">
        <select data-f="status" aria-label="Situação do relato">${Object.entries(st).map(([k, v]) => `<option value="${k}" ${r.status === k ? "selected" : ""}>${v}</option>`).join("")}</select>
        <button class="btn btn-primary btn-sm" type="button" data-act="save">Salvar</button>
        ${r.groups?.invite_url ? `<a class="btn btn-sm" href="${esc(Sora.safeUrl(r.groups.invite_url))}" target="_blank" rel="noopener noreferrer">Testar link ↗</a>` : ""}
        ${r.groups && r.groups.status === "approved" ? '<button class="btn btn-sm btn-danger" type="button" data-act="remove-group">Tirar grupo da vitrine</button>' : ""}
      </div>
    </article>`).join("") || empty(status === "open" ? "Nenhum relato aberto." : "Nenhum relato encontrado.");
  };
  $("reportsList").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const item = btn.closest("[data-report]");
    const id = Number(item.dataset.report);
    if (btn.dataset.act === "remove-group") {
      if (!Sora.confirmTap(btn, "Confirmar remoção")) return;
      Sora.setBusy(btn, true);
      const { error } = await client.from("groups").update({ status: "removed", featured_by_admin: false, approved_at: null, admin_note: "Removido após relato de usuário." }).eq("id", Number(item.dataset.groupId));
      if (!error) await client.from("reports").update({ status: "resolved" }).eq("id", id);
      Sora.setBusy(btn, false);
      if (error) { Sora.toast(dbError(error), "error"); return; }
      Sora.toast("Grupo retirado da vitrine e relato resolvido.", "ok");
    } else {
      Sora.setBusy(btn, true);
      const { error } = await client.from("reports").update({ status: item.querySelector('[data-f="status"]').value }).eq("id", id);
      Sora.setBusy(btn, false);
      if (error) { Sora.toast(dbError(error), "error"); return; }
      Sora.toast("Relato atualizado.", "ok");
    }
    LOADERS.reports(); refreshCounts();
  });
  $("reportStatus").addEventListener("change", LOADERS.reports);

  /* ---------- Feedback e bugs ---------- */
  LOADERS.feedback = async () => {
    const box = $("feedbackList");
    box.innerHTML = '<div class="skeleton" style="height:90px"></div>';
    const kind = $("feedbackKind").value;
    const isBug = kind === "bugs";
    const q = isBug
      ? client.from("bug_reports").select("id,title,message,page,severity,email,status,created_at").order("created_at", { ascending: false }).limit(200)
      : client.from("feedback").select("id,type,rating,title,message,email,status,created_at").eq("type", kind).order("created_at", { ascending: false }).limit(200);
    const { data, error } = await q;
    if (error) { box.innerHTML = empty("Não foi possível carregar."); console.warn(error); return; }
    const bugSt = { open: "Aberto", investigating: "Investigando", fixed: "Corrigido", closed: "Fechado", duplicate: "Duplicado" };
    const fbSt = { new: "Novo", reviewing: "Em análise", planned: "Planejado", resolved: "Resolvido", archived: "Arquivado" };
    const onde = { site: "Site", bot: "Bot", ponte: "Estatísticas/status" };
    const st = isBug ? bugSt : fbSt;
    box.innerHTML = (data || []).map((f) => `<article class="admin-item" data-fb="${f.id}">
      <div class="admin-item-head"><div><h3>${isBug ? esc(f.title) : kind === "rating" ? `${"★".repeat(f.rating || 0)} <span class="admin-muted">${f.rating || 0}/5</span>` : esc(f.title || "Sugestão")}</h3><div class="admin-muted">${fmt(f.created_at)}${isBug ? ` · ${esc(onde[f.page] || f.page || "")} · gravidade ${esc(f.severity)}` : ""}${f.email ? ` · ${esc(f.email)}` : ""}</div></div><span class="status-badge ${esc(f.status)}">${st[f.status] || esc(f.status)}</span></div>
      ${f.message ? `<p>${esc(f.message)}</p>` : ""}
      <div class="admin-actions"><select data-f="status" aria-label="Situação">${Object.entries(st).map(([k, v]) => `<option value="${k}" ${f.status === k ? "selected" : ""}>${v}</option>`).join("")}</select><button class="btn btn-primary btn-sm" type="button" data-act="save">Salvar</button>${f.email ? `<a class="btn btn-sm btn-ghost" href="mailto:${esc(f.email)}">Responder por e-mail</a>` : ""}</div>
    </article>`).join("") || empty("Nada por aqui ainda.");
  };
  $("feedbackList").addEventListener("click", async (e) => {
    const btn = e.target.closest('[data-act="save"]');
    if (!btn) return;
    const item = btn.closest("[data-fb]");
    const table = $("feedbackKind").value === "bugs" ? "bug_reports" : "feedback";
    Sora.setBusy(btn, true);
    const { data, error } = await client.from(table).update({ status: item.querySelector('[data-f="status"]').value }).eq("id", Number(item.dataset.fb)).select("id");
    Sora.setBusy(btn, false);
    if (error || !data?.length) { Sora.toast(error ? dbError(error) : "Sem permissão para alterar. Execute o SQL de atualização (sql-atualizacao-20260911.sql).", "error"); return; }
    Sora.toast("Situação atualizada.", "ok");
    LOADERS.feedback(); refreshCounts();
  });
  $("feedbackKind").addEventListener("change", LOADERS.feedback);

  /* ---------- Usuários ---------- */
  LOADERS.users = async () => {
    const box = $("usersList");
    box.innerHTML = '<div class="skeleton" style="height:120px"></div>';
    const btn = $("loadUsers");
    Sora.setBusy(btn, true);
    try {
      const token = await auth.getToken();
      const r = await Sora.fetchJson(`/api/admin-extra?type=users&q=${encodeURIComponent($("userSearch").value.trim())}&status=${encodeURIComponent($("userStatus").value)}`, { headers: { Authorization: `Bearer ${token}` } }, 20000);
      if (!r.ok) { box.innerHTML = empty(r.body?.message || "Não foi possível carregar os usuários."); return; }
      const rows = r.body.users || [];
      cache.users = rows;
      box.innerHTML = rows.length ? `<div class="table-wrap"><table class="admin-table"><thead><tr><th>Conta</th><th>Cadastro</th><th>E-mail</th><th>Situação</th><th></th></tr></thead><tbody>${rows.map((u) => {
        const suspenso = u.profile?.account_status === "suspended";
        return `<tr><td><strong>${esc(u.profile?.username ? "@" + u.profile.username : u.metadata?.username || "Sem usuário")}</strong>${u.profile?.role === "admin" ? ' <span class="status-badge approved">admin</span>' : ""}<br><span class="admin-muted">${esc(u.email)}</span></td><td>${fmt(u.created_at)}</td><td>${u.confirmed ? "Confirmado" : "Pendente"}</td><td><span class="status-badge ${suspenso ? "suspended" : "approved"}">${suspenso ? "Suspensa" : "Ativa"}</span></td><td>${u.id === user.id ? '<span class="admin-muted">Você</span>' : `<button class="btn btn-sm ${suspenso ? "" : "btn-danger"}" type="button" data-user="${esc(u.id)}" data-action="${suspenso ? "activate" : "suspend"}">${suspenso ? "Reativar" : "Suspender"}</button>`}</td></tr>`;
      }).join("")}</tbody></table></div>` : empty("Nenhum usuário encontrado.");
    } catch (e) {
      console.warn("[SORASAKI] Usuários:", e);
      box.innerHTML = empty("Não foi possível carregar os usuários.");
    } finally { Sora.setBusy(btn, false); }
  };
  $("usersSearchForm").addEventListener("submit", (e) => { e.preventDefault(); LOADERS.users(); });
  $("userStatus").addEventListener("change", LOADERS.users);
  $("usersList").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-user]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (!Sora.confirmTap(btn, action === "suspend" ? "Confirmar suspensão" : "Confirmar")) return;
    Sora.setBusy(btn, true);
    try {
      const token = await auth.getToken();
      const r = await Sora.fetchJson("/api/admin-extra?type=users", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ user_id: btn.dataset.user, action }) });
      if (!r.ok) { Sora.toast(r.body?.message || "Não foi possível concluir esta ação.", "error"); return; }
      Sora.toast(action === "suspend" ? "Conta suspensa." : "Conta reativada.", "ok");
      LOADERS.users();
    } catch (err) { Sora.toast(Sora.friendlyError(err), "error"); }
    finally { Sora.setBusy(btn, false); }
  });

  /* ---------- Formulários de conteúdo (helper) ---------- */
  function crud({ table, list, form, idField, title, newTitle, editTitle, saveBtn, saveLabel, resultId, order, render, fill, payload, validate, entity, afterSave }) {
    const clear = () => { $(form).reset(); $(idField).value = ""; $(title).textContent = newTitle; $(saveBtn).textContent = saveLabel; result(resultId, "", ""); };
    const load = async () => {
      const box = $(list);
      box.innerHTML = '<div class="skeleton" style="height:90px"></div>';
      let q = client.from(table).select("*");
      order.forEach(([col, asc]) => { q = q.order(col, { ascending: asc }); });
      const { data, error } = await q;
      if (error) { box.innerHTML = empty(dbError(error, "Não foi possível carregar.")); return; }
      cache[table] = data || [];
      box.innerHTML = cache[table].map(render).join("") || empty("Nada cadastrado ainda.");
    };
    $(list).addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-crud]");
      if (!btn) return;
      const id = Number(btn.closest("[data-id]").dataset.id);
      const row = cache[table]?.find((x) => x.id === id);
      if (!row) return;
      if (btn.dataset.crud === "edit") {
        fill(row);
        $(idField).value = row.id;
        $(title).textContent = `${editTitle}: ${row.name || row.title || row.code}`;
        $(saveBtn).textContent = "Salvar alterações";
        result(resultId, "info", "Editando. Salve para aplicar ou toque em Limpar para cancelar.");
        scrollToForm(form);
        return;
      }
      if (btn.dataset.crud === "delete") {
        if (!Sora.confirmTap(btn, "Confirmar exclusão")) return;
        Sora.setBusy(btn, true);
        const { error } = await client.from(table).delete().eq("id", id);
        Sora.setBusy(btn, false);
        if (error) { Sora.toast(dbError(error, "Não foi possível excluir."), "error"); return; }
        Sora.toast("Excluído.", "ok");
        if (String($(idField).value) === String(id)) clear();
        load();
        return;
      }
      if (btn.dataset.crud === "toggle") {
        Sora.setBusy(btn, true);
        const { error } = await client.from(table).update({ active: !row.active }).eq("id", id);
        Sora.setBusy(btn, false);
        if (error) { Sora.toast(dbError(error, "Não foi possível alterar."), "error"); return; }
        Sora.toast(row.active ? "Desativado." : "Ativado.", "ok");
        load();
      }
    });
    $(form).addEventListener("submit", async (e) => {
      e.preventDefault();
      const p = payload();
      const erro = validate(p);
      if (erro) { result(resultId, "error", erro); return; }
      const id = $(idField).value;
      Sora.setBusy($(saveBtn), true, "Salvando…");
      const { error } = id ? await client.from(table).update(p).eq("id", Number(id)) : await client.from(table).insert(p);
      Sora.setBusy($(saveBtn), false);
      if (error) { result(resultId, "error", dbError(error)); return; }
      Sora.toast(id ? "Alterações salvas." : "Cadastrado com sucesso.", "ok");
      clear();
      load();
      afterSave?.();
    });
    return { load, clear };
  }
  const rowActions = (extra = "", toggle = true, active = true) => `<div class="admin-actions"><button class="btn btn-sm" type="button" data-crud="edit">Editar</button>${toggle ? `<button class="btn btn-sm" type="button" data-crud="toggle">${active ? "Desativar" : "Ativar"}</button>` : ""}${extra}<button class="btn btn-sm btn-danger" type="button" data-crud="delete">Excluir</button></div>`;
  const onOff = (a) => `<span class="status-badge ${a ? "approved" : "removed"}">${a ? "Ativo" : "Inativo"}</span>`;
  const validUrl = (v) => { try { const u = new URL(v); return /^https?:$/.test(u.protocol); } catch { return false; } };

  /* ---------- Grupos oficiais ---------- */
  Object.entries(CAT).forEach(([k, v]) => $("officialCategory").insertAdjacentHTML("beforeend", `<option value="${k}">${esc(v)}</option>`));
  const official = crud({
    table: "official_groups", list: "officialList", form: "officialForm", idField: "officialId", title: "officialFormTitle", newTitle: "Novo grupo oficial", editTitle: "Editando", saveBtn: "officialSave", saveLabel: "Salvar grupo oficial", resultId: "officialResult",
    order: [["display_order", true], ["created_at", true]],
    render: (g) => `<article class="admin-item" data-id="${g.id}"><div class="admin-item-head"><div style="display:flex;gap:12px"><div class="group-icon" style="width:44px;height:44px">${Sora.safeUrl(g.image_url || g.avatar_url) ? `<img src="${esc(Sora.safeUrl(g.image_url || g.avatar_url))}" alt="">` : esc(Sora.initials(g.name))}</div><div><h3>${esc(g.name)}</h3><div class="admin-muted">${esc(CAT[g.category] || g.category)} · ordem ${g.display_order}</div></div></div>${onOff(g.active)}</div><p>${esc(g.description)}</p>${rowActions("", true, g.active)}</article>`,
    fill: (g) => { $("officialName").value = g.name; $("officialDescription").value = g.description; $("officialLink").value = g.invite_url; $("officialImage").value = g.image_url || g.avatar_url || ""; $("officialHighlight").value = g.highlight_phrase || g.highlight || ""; $("officialOrder").value = g.display_order || 0; $("officialCategory").value = g.category; },
    payload: () => {
      const image = $("officialImage").value.trim() || null;
      const destaque = $("officialHighlight").value.trim() || null;
      // image_status só aceita pending/found/not_found/error/manual.
      return { name: $("officialName").value.trim(), description: $("officialDescription").value.trim(), category: $("officialCategory").value, invite_url: $("officialLink").value.trim(), avatar_url: image, image_url: image, image_source: image ? "manual" : "fallback", image_status: image ? "manual" : "not_found", highlight: destaque, highlight_phrase: destaque, display_order: Number($("officialOrder").value) || 0 };
    },
    validate: (p) => (p.name.length < 2 ? "Informe o nome do grupo." : p.description.length < 10 ? "A descrição precisa ter pelo menos 10 caracteres." : !validUrl(p.invite_url) ? "Informe um link de convite válido (https://…)." : p.image_url && !validUrl(p.image_url) ? "O link da imagem não parece válido." : "")
  });
  LOADERS.official = official.load;
  $("officialClear").onclick = official.clear;
  $("officialDetect").onclick = async () => {
    const link = $("officialLink").value.trim();
    if (!validUrl(link)) { result("officialResult", "error", "Informe primeiro o link de convite."); return; }
    const b = $("officialDetect");
    Sora.setBusy(b, true, "Buscando…");
    try {
      const token = await auth.getToken();
      const r = await Sora.fetchJson("/api/admin-extra?type=group-preview", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ invite_url: link, entity: "official", id: Number($("officialId").value) || 0 }) }, 20000);
      const data = r.body || {};
      if (data.name && !$("officialName").value.trim()) $("officialName").value = data.name.slice(0, 100);
      if (data.description && !$("officialDescription").value.trim()) $("officialDescription").value = data.description.slice(0, 800);
      if (data.image_url) { $("officialImage").value = data.image_url; result("officialResult", "ok", "Foto encontrada e salva. Clique em salvar para aplicar."); }
      else result("officialResult", "info", data.message || "Não encontramos uma foto pública. Informe uma imagem manualmente.");
    } catch (e) { result("officialResult", "error", "Não foi possível buscar agora."); }
    finally { Sora.setBusy(b, false); }
  };

  /* ---------- Notícias ---------- */
  const news = crud({
    table: "news", list: "newsList", form: "newsForm", idField: "newsId", title: "newsFormTitle", newTitle: "Nova notícia", editTitle: "Editando", saveBtn: "newsSave", saveLabel: "Salvar notícia", resultId: "newsResult",
    order: [["publish_at", false]],
    render: (n) => {
      const agendada = n.status === "published" && new Date(n.publish_at) > new Date();
      return `<article class="admin-item" data-id="${n.id}"><div class="admin-item-head"><div><h3>${esc(n.title)}</h3><div class="admin-muted">${esc(n.category)} · ${fmt(n.publish_at)}</div></div><span class="status-badge ${n.status === "published" ? (agendada ? "pending" : "approved") : "removed"}">${n.status === "published" ? (agendada ? "Agendada" : "Publicada") : "Rascunho"}</span></div><p>${esc(n.summary || String(n.content || "").slice(0, 180))}</p>${rowActions("", false)}</article>`;
    },
    fill: (n) => { $("newsTitle").value = n.title; $("newsCategory").value = n.category; $("newsSummary").value = n.summary || ""; $("newsImage").value = n.image_url || ""; $("newsStatus").value = n.status; $("newsPublishAt").value = dtLocal(n.publish_at); $("newsContent").value = n.content; },
    payload: () => ({ title: $("newsTitle").value.trim(), summary: $("newsSummary").value.trim() || null, content: $("newsContent").value.trim(), category: $("newsCategory").value.trim() || "Novidade", image_url: $("newsImage").value.trim() || null, status: $("newsStatus").value, publish_at: fromLocal($("newsPublishAt").value) || new Date().toISOString(), created_by: user.id }),
    validate: (p) => (!p.title ? "Informe o título." : !p.content ? "Escreva o conteúdo da notícia." : p.image_url && !validUrl(p.image_url) ? "O link da imagem não parece válido." : "")
  });
  LOADERS.news = news.load;
  $("newsClear").onclick = news.clear;

  /* ---------- Avisos ---------- */
  const notices = crud({
    table: "site_notices", list: "noticesList", form: "noticeForm", idField: "noticeId", title: "noticeFormTitle", newTitle: "Novo aviso", editTitle: "Editando", saveBtn: "noticeSave", saveLabel: "Salvar aviso", resultId: "noticeResult",
    order: [["starts_at", false]],
    render: (n) => {
      const expirado = n.ends_at && new Date(n.ends_at) < new Date();
      return `<article class="admin-item" data-id="${n.id}"><div class="admin-item-head"><div><h3>${esc(n.title)}</h3><div class="admin-muted">${fmt(n.starts_at)}${n.ends_at ? " até " + fmt(n.ends_at) : ""}${n.highlighted ? " · destacado" : ""}</div></div>${expirado ? '<span class="status-badge removed">Encerrado</span>' : onOff(n.active)}</div><p>${esc(n.message)}</p>${rowActions("", true, n.active)}</article>`;
    },
    fill: (n) => { $("noticeTitle").value = n.title; $("noticeType").value = n.notice_type; $("noticeMessage").value = n.message; $("noticeStart").value = dtLocal(n.starts_at); $("noticeEnd").value = dtLocal(n.ends_at); $("noticeHighlight").value = String(n.highlighted); $("noticeActive").value = String(n.active); },
    payload: () => ({ title: $("noticeTitle").value.trim(), notice_type: $("noticeType").value, message: $("noticeMessage").value.trim(), starts_at: fromLocal($("noticeStart").value) || new Date().toISOString(), ends_at: fromLocal($("noticeEnd").value), highlighted: $("noticeHighlight").value === "true", active: $("noticeActive").value === "true", created_by: user.id }),
    validate: (p) => (!p.title ? "Informe o título." : !p.message ? "Escreva a mensagem." : p.ends_at && new Date(p.ends_at) <= new Date(p.starts_at) ? "O término precisa ser depois do início." : "")
  });
  LOADERS.notices = notices.load;
  $("noticeClear").onclick = notices.clear;

  /* ---------- Produtos ---------- */
  const slugify = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  const products = crud({
    table: "products", list: "productsList", form: "productForm", idField: "productId", title: "productFormTitle", newTitle: "Novo produto", editTitle: "Editando", saveBtn: "productSave", saveLabel: "Salvar produto", resultId: "productResult",
    order: [["display_order", true], ["created_at", true]],
    render: (p) => {
      const price = Number(p.promo_price ?? p.price);
      return `<article class="admin-item" data-id="${p.id}"><div class="admin-item-head"><div style="display:flex;gap:12px">${Sora.safeUrl(p.image_url) ? `<img class="admin-thumb" src="${esc(Sora.safeUrl(p.image_url))}" alt="">` : ""}<div><h3>${esc(p.name)} · ${fmtMoeda(price)}${p.promo_price != null ? ` <span class="catalog-old">${fmtMoeda(p.price)}</span>` : ""}</h3><div class="admin-muted">${esc(p.category || "Sem categoria")} · /${esc(p.slug)} · ordem ${p.display_order}</div></div></div>${onOff(p.active)}</div>${p.description ? `<p>${esc(p.description)}</p>` : ""}${rowActions("", true, p.active)}</article>`;
    },
    fill: (p) => { $("productName").value = p.name; $("productSlug").value = p.slug; $("productPrice").value = p.price; $("productPrevious").value = p.previous_price ?? ""; $("productPromo").value = p.promo_price ?? ""; $("productCategory").value = p.category || ""; $("productImage").value = p.image_url || ""; $("productOrder").value = p.display_order || 0; $("productActive").value = String(p.active); $("productDesc").value = p.description || ""; },
    payload: () => ({ name: $("productName").value.trim(), slug: slugify($("productSlug").value.trim() || $("productName").value), price: Number($("productPrice").value), previous_price: num($("productPrevious").value), promo_price: num($("productPromo").value), category: $("productCategory").value.trim() || null, image_url: $("productImage").value.trim() || null, display_order: Number($("productOrder").value) || 0, active: $("productActive").value === "true", description: $("productDesc").value.trim() || null }),
    validate: (p) => (!p.name ? "Informe o nome do produto." : !p.slug ? "Informe um endereço (slug) válido." : !Number.isFinite(p.price) || p.price < 0 || $("productPrice").value === "" ? "Informe um preço válido." : p.promo_price != null && (p.promo_price < 0 || p.promo_price >= p.price) ? "O preço promocional precisa ser menor que o preço normal." : p.image_url && !validUrl(p.image_url) ? "O link da imagem não parece válido." : "")
  });
  LOADERS.products = products.load;
  $("productClear").onclick = products.clear;
  $("productName").addEventListener("input", () => { if (!$("productId").value) $("productSlug").value = slugify($("productName").value); });

  /* ---------- Planos ---------- */
  async function fillCouponPlans() {
    const r = await client.from("promotion_plans").select("id,name,active").order("name");
    const s = $("couponPlan");
    s.innerHTML = '<option value="">Todos os planos</option>' + (r.data || []).map((p) => `<option value="${p.id}">${esc(p.name)}${p.active ? "" : " (inativo)"}</option>`).join("");
  }
  const plans = crud({
    table: "promotion_plans", list: "plansList", form: "planForm", idField: "planId", title: "planFormTitle", newTitle: "Novo plano", editTitle: "Editando", saveBtn: "planSave", saveLabel: "Salvar plano", resultId: "planResult",
    order: [["price", true]],
    render: (p) => `<article class="admin-item" data-id="${p.id}"><div class="admin-item-head"><div><h3>${esc(p.name)} · ${fmtMoeda(p.price)}</h3><div class="admin-muted">${p.duration_days} dias${Number(p.price) <= 0 ? " · sem preço: não aparece no site" : ""}</div></div>${onOff(p.active)}</div><p>${esc(p.description)}</p>${rowActions("", true, p.active)}</article>`,
    fill: (p) => { $("planName").value = p.name; $("planPrice").value = p.price; $("planDays").value = p.duration_days; $("planDesc").value = p.description; $("planActive").value = String(p.active); },
    payload: () => ({ name: $("planName").value.trim(), price: Number($("planPrice").value), duration_days: Math.floor(Number($("planDays").value)), description: $("planDesc").value.trim(), active: $("planActive").value === "true" }),
    validate: (p) => (!p.name ? "Informe o nome do plano." : !Number.isFinite(p.price) || p.price < 0 || $("planPrice").value === "" ? "Informe um preço válido." : !(p.duration_days > 0) ? "A duração precisa ser de pelo menos 1 dia." : !p.description ? "Escreva uma descrição." : p.active && p.price <= 0 ? "Um plano ativo precisa ter preço maior que zero." : ""),
    afterSave: fillCouponPlans
  });
  LOADERS.plans = plans.load;
  $("planClear").onclick = plans.clear;

  /* ---------- Cupons ---------- */
  const coupons = crud({
    table: "coupons", list: "couponsList", form: "couponForm", idField: "couponId", title: "couponFormTitle", newTitle: "Novo cupom", editTitle: "Editando", saveBtn: "couponSave", saveLabel: "Salvar cupom", resultId: "couponResult",
    order: [["created_at", false]],
    render: (c) => {
      const vencido = c.expires_at && new Date(c.expires_at) < new Date();
      return `<article class="admin-item" data-id="${c.id}"><div class="admin-item-head"><div><h3>${esc(c.code)} · ${c.discount_type === "percent" ? `${Number(c.discount_value)}%` : fmtMoeda(c.discount_value)}</h3><div class="admin-muted">${fmtNumero(c.uses_count || 0)}${c.max_uses ? " de " + fmtNumero(c.max_uses) : ""} usos · até ${c.max_uses_per_user} por pessoa${c.expires_at ? " · válido até " + fmt(c.expires_at) : ""}</div></div>${vencido ? '<span class="status-badge removed">Vencido</span>' : onOff(c.active)}</div>${rowActions("", true, c.active)}</article>`;
    },
    fill: (c) => { $("couponCode").value = c.code; $("couponType").value = c.discount_type; $("couponValue").value = c.discount_value; $("couponMax").value = c.max_uses ?? ""; $("couponPerUser").value = c.max_uses_per_user; $("couponStart").value = dtLocal(c.starts_at); $("couponEnd").value = dtLocal(c.expires_at); $("couponPlan").value = c.plan_id || ""; $("couponActive").value = String(c.active); },
    payload: () => ({ code: $("couponCode").value.trim().toUpperCase().replace(/\s+/g, ""), discount_type: $("couponType").value, discount_value: Number($("couponValue").value), max_uses: num($("couponMax").value), max_uses_per_user: Math.max(1, Math.floor(Number($("couponPerUser").value) || 1)), starts_at: fromLocal($("couponStart").value) || new Date().toISOString(), expires_at: fromLocal($("couponEnd").value), plan_id: num($("couponPlan").value), active: $("couponActive").value === "true" }),
    validate: (p) => (p.code.length < 3 ? "O código precisa ter pelo menos 3 caracteres." : !(p.discount_value > 0) ? "Informe o valor do desconto." : p.discount_type === "percent" && p.discount_value > 100 ? "O percentual não pode passar de 100%." : p.expires_at && new Date(p.expires_at) <= new Date(p.starts_at) ? "A validade precisa ser depois do início." : "")
  });
  LOADERS.coupons = () => { fillCouponPlans(); coupons.load(); };
  $("couponClear").onclick = coupons.clear;
  $("generateCoupon").onclick = () => { $("couponCode").value = "SORA" + Math.random().toString(36).slice(2, 8).toUpperCase(); };

  /* ---------- Histórico ---------- */
  const ACTION_LABEL = { INSERT: "Criou", UPDATE: "Alterou", DELETE: "Excluiu" };
  const ENTITY_LABEL = { groups: "divulgação", group: "divulgação", official_groups: "grupo oficial", official_group: "grupo oficial", coupons: "cupom", coupon: "cupom", products: "produto", product: "produto", news: "notícia", site_notices: "aviso", notice: "aviso", site_settings: "configuração", settings: "configurações", promotion_plans: "plano", promotion_plan: "plano", reviews: "avaliação", reports: "relato", report: "relato", user: "conta" };
  function activityItem(a) {
    const acao = ACTION_LABEL[a.action] || a.action.charAt(0) + a.action.slice(1).toLowerCase();
    return `<div class="admin-item"><strong>${esc(acao)} ${esc(ENTITY_LABEL[a.entity] || a.entity)}${a.entity_id ? ` #${esc(a.entity_id)}` : ""}</strong><div class="admin-muted">${fmt(a.created_at)}</div></div>`;
  }
  LOADERS.signups = async () => {
    const box = $("signupsList");
    box.innerHTML = '<div class="skeleton" style="height:120px"></div>';
    try {
      const token = await auth.getToken();
      const r = await Sora.fetchJson("/api/admin-extra?type=signups&limit=100", { headers: { Authorization: `Bearer ${token}` } }, 20000);
      if (!r.ok) { box.innerHTML = empty(r.body?.message || "Não foi possível carregar os cadastros."); return; }
      const rows = r.body.signups || [];
      const local = (s) => [s.city, s.region, s.country].filter(Boolean).join(", ") || "—";
      // Tudo passa por esc(): estes campos vêm de cabeçalhos e do navegador de quem se cadastrou.
      box.innerHTML = rows.length ? `<div class="table-wrap"><table class="admin-table"><thead><tr><th>Conta</th><th>Quando</th><th>Local aproximado</th><th>IP</th><th>Chegou por</th></tr></thead><tbody>${rows.map((s) => `<tr><td><strong>${esc(s.username ? "@" + s.username : "—")}</strong><br><span class="admin-muted">${esc(s.email || "")}</span></td><td>${fmt(s.created_at)}</td><td>${esc(local(s))}</td><td><code>${esc(s.ip || "—")}</code></td><td><span class="admin-muted">${esc(s.entry_page || "—")}${s.referrer ? "<br>de " + esc(s.referrer) : ""}</span></td></tr>`).join("")}</tbody></table></div>` : empty("Nenhum cadastro registrado ainda.");
    } catch (e) {
      console.warn("[SORASAKI] Cadastros:", e);
      box.innerHTML = empty("Não foi possível carregar os cadastros.");
    }
  };

  LOADERS.activity = async () => {
    const box = $("activityList");
    box.innerHTML = '<div class="skeleton" style="height:90px"></div>';
    const { data, error } = await client.from("admin_activity").select("action,entity,entity_id,created_at").order("created_at", { ascending: false }).limit(200);
    box.innerHTML = error ? empty("Não foi possível carregar o histórico.") : (data || []).map(activityItem).join("") || empty("Nenhuma atividade registrada ainda.");
  };

  /* ---------- Configurações ---------- */
  function syncMaintenanceText() {
    const on = $("settingMaintenance").checked;
    $("maintenanceStateText").textContent = on ? "Ligado — visitantes veem a tela de manutenção depois de salvar." : "Desligado — o site está aberto ao público.";
  }
  $("settingMaintenance").addEventListener("change", syncMaintenanceText);
  LOADERS.settings = async () => {
    const { data, error } = await client.from("site_settings").select("key,value");
    if (error) { result("settingsResult", "error", "Não foi possível carregar as configurações."); return; }
    const m = Object.fromEntries((data || []).map((x) => [x.key, x.value]));
    const bool = (v) => (typeof v === "boolean" ? v : ["true", "1", "yes", "on"].includes(String(v ?? "").trim().toLowerCase()));
    $("settingLimit").value = Number(m.max_group_submissions_per_24h ?? 5);
    $("settingSubmissions").checked = bool(m.community_submissions_enabled ?? true);
    $("settingMaintenance").checked = bool(m.maintenance_mode ?? false);
    $("settingStartAt").value = dtLocal(m.maintenance_start_at);
    $("settingMaintenanceTitle").value = String(m.maintenance_title ?? "Estamos em manutenção").replace(/^🔧\s*/, "");
    $("settingMaintenanceMessage").value = String(m.maintenance_message ?? "O site está passando por algumas melhorias no momento.");
    $("settingReturnAt").value = dtLocal(m.maintenance_return_at);
    syncMaintenanceText();
  };
  $("maintenancePreviewBtn").onclick = () => {
    const box = $("maintenancePreviewBox");
    box.hidden = false;
    box.innerHTML = `<div class="sorasaki-maintenance-card"><div class="sorasaki-maintenance-visual"><img src="/img/sorasaki-manutencao.webp" alt=""></div><h1>${esc($("settingMaintenanceTitle").value.trim() || "Estamos em manutenção")}</h1><p>${esc($("settingMaintenanceMessage").value.trim() || "Estamos fazendo algumas melhorias.")}</p>${$("settingReturnAt").value ? `<div class="sorasaki-maintenance-return">Previsão de retorno: ${new Date($("settingReturnAt").value).toLocaleString("pt-BR", { dateStyle: "medium", timeStyle: "short" })}</div>` : ""}<div class="sorasaki-maintenance-thanks">Obrigado pela paciência.</div></div>`;
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  $("settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const vals = {
      max_group_submissions_per_24h: Number($("settingLimit").value),
      community_submissions_enabled: $("settingSubmissions").checked,
      maintenance_mode: $("settingMaintenance").checked,
      maintenance_start_at: fromLocal($("settingStartAt").value),
      maintenance_title: $("settingMaintenanceTitle").value.trim() || "Estamos em manutenção",
      maintenance_message: $("settingMaintenanceMessage").value.trim() || "O site está passando por algumas melhorias no momento.",
      maintenance_return_at: fromLocal($("settingReturnAt").value)
    };
    if (!Number.isInteger(vals.max_group_submissions_per_24h) || vals.max_group_submissions_per_24h < 1 || vals.max_group_submissions_per_24h > 50) {
      result("settingsResult", "error", "O limite de divulgações precisa ser um número entre 1 e 50.");
      return;
    }
    const btn = $("settingsSave");
    Sora.setBusy(btn, true, "Salvando…");
    try {
      const token = await auth.getToken();
      const r = await Sora.fetchJson("/api/admin-settings", { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(vals) }, 20000);
      if (!r.ok || !r.body?.ok) { result("settingsResult", "error", r.body?.message || "Não foi possível salvar as configurações. Tente novamente."); return; }
      result("settingsResult", "ok", vals.maintenance_mode ? "Salvo. O site está em manutenção para os visitantes." : "Salvo. O site está aberto ao público.");
      logAction("CONFIGUROU", "settings", null, { maintenance_mode: vals.maintenance_mode, community_submissions_enabled: vals.community_submissions_enabled, max_group_submissions_per_24h: vals.max_group_submissions_per_24h });
    } catch (err) {
      console.error("[SORASAKI] Configurações:", err);
      result("settingsResult", "error", Sora.friendlyError(err, "Não foi possível salvar as configurações. Tente novamente."));
    } finally { Sora.setBusy(btn, false); }
  });

  /* ---------- Início ---------- */
  function start() {
    const inicial = location.hash.slice(1);
    openTab(LOADERS[inicial] ? inicial : "dashboard");
    if (inicial && inicial !== "dashboard") refreshCounts();
  }
  checkAccess();
})();
