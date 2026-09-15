// Script da página grupos.html (antes ficava inline no HTML).
// Fica em arquivo separado para o CSP não precisar de 'unsafe-inline' em scripts.
(function () {
  const auth = window.SorasakiAuth;
  const client = auth?.getClient?.();
  const $ = (id) => document.getElementById(id);
  const esc = escapeHtml;
  const CAT = { vendas: "Compra e venda", comunidade: "Comunidade", jogos: "Jogos", freefire: "Free Fire", divulgacao: "Divulgação", amizades: "Amizades", suporte: "Suporte", estudos: "Estudos", outros: "Outros" };
  const STATUS = { pending: "Em análise", approved: "Publicada", rejected: "Recusada", removed: "Removida" };
  const ORDER_STATUS = { pending: "Aguardando pagamento", paid: "Pago", rejected: "Recusado", cancelled: "Cancelado", expired: "Expirado", refunded: "Estornado" };

  let groups = [];
  let filter = "todos";
  let selectedRating = 0;
  let editingGroupId = null;
  let autoImageUrl = "";
  let autoImageHash = "";
  let previewTimer = null;
  let previewBusy = false;
  let state = { submissions_enabled: true, max_submissions_24h: 5 };
  let myGroups = [];

  if (!client) {
    $("groupsLoading").hidden = true;
    $("groupsEmpty").hidden = false;
    $("groupsEmpty").innerHTML = Sora.emptyState("Não foi possível carregar as comunidades.", "Recarregue a página em alguns instantes.", { retry: true });
    $("groupsEmpty").querySelector("[data-retry]").onclick = () => location.reload();
  }

  /* ---------- Janelas ---------- */
  let modalFocus = null;
  function openModal(id) {
    const m = $(id);
    modalFocus = document.activeElement;
    m.hidden = false;
    document.body.classList.add("group-modal-open");
    setTimeout(() => m.querySelector(".group-modal-close")?.focus(), 40);
  }
  function closeModal(id) {
    const m = $(id);
    if (!m || m.hidden) return;
    m.hidden = true;
    if (![...document.querySelectorAll(".group-modal")].some((x) => !x.hidden)) document.body.classList.remove("group-modal-open");
    modalFocus?.focus?.({ preventScroll: true });
    if (id === "groupModal") resetSubmitForm();
  }
  document.querySelectorAll(".group-modal").forEach((m) => {
    m.addEventListener("click", (e) => { if (e.target.closest("[data-close-modal]")) { if (e.target.closest("a")) e.preventDefault(); closeModal(m.id); if (e.target.closest('a[href="#divulgar"]')) $("divulgar").scrollIntoView({ behavior: "smooth" }); } });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = [...document.querySelectorAll(".group-modal")].filter((m) => !m.hidden).pop();
    if (open) closeModal(open.id);
  });
  function showSubmitState(name) {
    $("groupModal").querySelectorAll("[data-state]").forEach((el) => { el.hidden = el.dataset.state !== name; });
    $("groupModal").querySelector(".group-modal-card").classList.toggle("group-submit-card", name === "form");
  }

  /* ---------- Cartões ---------- */
  function average(g) {
    const r = g.reviews || [];
    return r.length ? { score: r.reduce((s, x) => s + x.rating, 0) / r.length, count: r.length } : { score: 0, count: 0 };
  }
  function avatar(g, cls) {
    const img = Sora.safeUrl(g.avatar_url || g.image_url);
    return `<div class="${cls}">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : esc(Sora.initials(g.name))}</div>`;
  }
  function groupCard(g) {
    const r = average(g);
    const tags = String(g.tags || "").split(",").map((x) => x.trim().replace(/^#/, "").replace(/\s+/g, "")).filter(Boolean).slice(0, 5);
    const badges = [
      g.admin_badge ? `<span class="group-featured">${g.admin_badge === "oficial" ? "Oficial" : g.admin_badge === "parceiro" ? "Parceiro" : "Indicado"}</span>` : "",
      g.active_promotion ? '<span class="group-promo">Destaque</span>' : ""
    ].join("");
    const invite = Sora.safeUrl(g.invite_url);
    return `<article class="group-card ${g.featured_by_admin ? "featured" : ""}">
      <div class="group-card-top">${avatar(g, "group-icon")}<div class="group-title-block"><h3>${esc(g.name)}</h3><span class="group-category">${esc(CAT[g.category] || g.category)}${g.platform ? " · " + esc(g.platform) : ""}</span></div></div>
      ${badges ? `<div class="group-badges">${badges}</div>` : ""}
      ${g.highlight ? `<div class="group-highlight">${esc(g.highlight)}</div>` : ""}
      <p>${esc(g.description)}</p>
      ${tags.length ? `<div class="group-tags">${tags.map((t) => `<span>#${esc(t)}</span>`).join("")}</div>` : ""}
      <div class="group-meta"><span>${r.count ? `<strong>★ ${r.score.toFixed(1).replace(".", ",")}</strong> (${r.count})` : "Sem avaliações"}</span>${Number(g.member_count) ? `<span><strong>${fmtNumero(g.member_count)}</strong> membros</span>` : ""}<span><strong>${fmtNumero(g.view_count || 0)}</strong> visitas</span></div>
      <div class="group-card-actions">
        <button class="btn btn-sm" type="button" data-copy="${esc(invite)}">Copiar convite</button>
        <a class="btn btn-sm btn-primary" href="${esc(invite)}" target="_blank" rel="noopener noreferrer" data-join="${g.id}">Entrar <span aria-hidden="true">↗</span></a>
      </div>
      <div class="group-card-secondary">
        <button type="button" data-review="${g.id}">Avaliar</button>
        <button type="button" data-report="${g.id}">Relatar problema</button>
        ${g.contact_url ? `<a href="${esc(Sora.safeUrl(g.contact_url))}" target="_blank" rel="noopener noreferrer">Contato ↗</a>` : ""}
      </div>
    </article>`;
  }
  function officialCard(g) {
    return `<article class="official-card"><div class="official-card-top">${avatar(g, "official-icon")}<div class="group-title-block"><h3>${esc(g.name)}</h3><span>${esc(CAT[g.category] || g.category)}</span></div></div>${(g.highlight_phrase || g.highlight) ? `<div class="official-highlight">${esc(g.highlight_phrase || g.highlight)}</div>` : ""}<p>${esc(g.description)}</p><a class="btn btn-primary" href="${esc(Sora.safeUrl(g.invite_url))}" target="_blank" rel="noopener noreferrer">Entrar no grupo <span aria-hidden="true">↗</span></a></article>`;
  }

  function render() {
    let list = groups.filter((g) => filter === "todos" || g.category === filter);
    const q = $("groupSearch").value.trim().toLowerCase();
    if (q) list = list.filter((g) => `${g.name} ${CAT[g.category] || ""} ${g.platform || ""} ${g.description} ${g.tags || ""}`.toLowerCase().includes(q));
    const sort = $("groupSort").value;
    list.sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, "pt-BR")
      : sort === "rating" ? average(b).score - average(a).score
      : sort === "views" ? Number(b.view_count || 0) - Number(a.view_count || 0)
      : sort === "members" ? Number(b.member_count || 0) - Number(a.member_count || 0)
      : new Date(b.created_at) - new Date(a.created_at));
    // Grupos em destaque pago aparecem primeiro.
    list.sort((a, b) => Number(Boolean(b.active_promotion)) - Number(Boolean(a.active_promotion)));
    $("groupsGrid").innerHTML = list.map(groupCard).join("");
    $("groupsGrid").hidden = !list.length;
    $("groupsEmpty").hidden = Boolean(list.length);
    if (!list.length) {
      $("groupsEmpty").innerHTML = groups.length
        ? Sora.emptyState("Nenhum grupo encontrado.", "Tente outro termo ou escolha outra categoria.", { icon: "search" })
        : Sora.emptyState("A vitrine está esperando o primeiro grupo.", "Seja o primeiro a divulgar a sua comunidade.", { icon: "users" });
    }
  }

  $("groupsGrid").addEventListener("click", async (e) => {
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copy); copy.textContent = "Convite copiado"; }
      catch { copy.textContent = "Não foi possível copiar"; }
      setTimeout(() => { copy.textContent = "Copiar convite"; }, 1800);
      return;
    }
    const join = e.target.closest("[data-join]");
    if (join) {
      const id = Number(join.dataset.join), key = `sora-viewed-${id}`;
      try {
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, "1");
          client.rpc("increment_group_view", { p_group_id: id }).then(() => {}, () => {});
        }
      } catch {}
      return;
    }
    const rev = e.target.closest("[data-review]");
    if (rev) return openReview(Number(rev.dataset.review));
    const rep = e.target.closest("[data-report]");
    if (rep) return openReport(Number(rep.dataset.report));
  });

  document.querySelectorAll(".group-filter").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll(".group-filter").forEach((x) => { x.classList.toggle("active", x === b); x.setAttribute("aria-pressed", String(x === b)); });
      filter = b.dataset.filter;
      render();
    };
  });
  let searchTimer = null;
  $("groupSearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(render, 120); });
  $("groupSort").addEventListener("change", render);

  /* ---------- Carregamento ---------- */
  async function loadOfficial() {
    try {
      const { data, error } = await client.from("official_groups").select("id,name,description,category,avatar_url,image_url,invite_url,highlight,highlight_phrase,display_order,created_at").eq("active", true).order("display_order", { ascending: true }).order("created_at", { ascending: true });
      if (error) throw error;
      $("officialGrid").innerHTML = (data || []).map(officialCard).join("");
      $("officialSection").hidden = !data?.length;
    } catch (e) {
      console.warn("[SORASAKI] Grupos oficiais:", e);
      $("officialSection").hidden = true;
    }
  }

  async function loadGroups() {
    try {
      const { data, error } = await client.from("groups")
        .select("id,name,description,category,platform,avatar_url,member_count,invite_url,featured_by_admin,admin_badge,created_at,tags,contact_url,highlight,view_count")
        .eq("status", "approved").order("created_at", { ascending: false }).limit(500);
      if (error) throw error;
      groups = (data || []).map((g) => ({ ...g, reviews: [], active_promotion: false }));
      $("groupCount").textContent = fmtNumero(groups.length);
      $("memberCount").textContent = fmtNumero(groups.reduce((s, g) => s + (Number(g.member_count) || 0), 0));
      const ids = groups.map((g) => g.id);
      if (ids.length) {
        const [rr, pp] = await Promise.all([
          client.from("reviews").select("group_id,rating").in("group_id", ids).eq("status", "visible"),
          client.from("promotions").select("group_id,expires_at").in("group_id", ids).eq("active", true).gt("expires_at", new Date().toISOString())
        ]);
        const byId = new Map(groups.map((g) => [g.id, g]));
        (rr.data || []).forEach((r) => byId.get(r.group_id)?.reviews.push(r));
        (pp.data || []).forEach((p) => { const g = byId.get(p.group_id); if (g) g.active_promotion = true; });
      }
      $("groupsLoading").hidden = true;
      render();
    } catch (e) {
      console.warn("[SORASAKI] Comunidades:", e);
      $("groupsLoading").hidden = true;
      $("groupsGrid").hidden = true;
      $("groupsEmpty").hidden = false;
      $("groupsEmpty").innerHTML = Sora.emptyState("Não foi possível carregar as comunidades.", "Verifique sua conexão e tente novamente.", { retry: true });
      $("groupsEmpty").querySelector("[data-retry]").onclick = () => { $("groupsEmpty").hidden = true; $("groupsLoading").hidden = false; loadGroups(); };
    }
  }

  async function loadPlans() {
    try {
      const { data, error } = await client.from("promotion_plans").select("id,name,description,price,duration_days").eq("active", true).gt("price", 0).order("price");
      if (error) throw error;
      const plans = data || [];
      $("plansSection").hidden = !plans.length;
      $("plansGrid").innerHTML = plans.map((p) => `<article class="plan-card"><span class="plan-name">${esc(p.name)}</span><h3>${fmtMoeda(p.price)}</h3><p>${esc(p.description)}</p><span class="plan-duration">${p.duration_days} ${p.duration_days === 1 ? "dia" : "dias"} de destaque</span><button class="btn btn-primary" type="button" data-plan="${p.id}">Escolher grupo <span aria-hidden="true">→</span></button></article>`).join("");
      $("plansGrid").querySelectorAll("[data-plan]").forEach((b) => { b.onclick = () => openPlan(plans.find((p) => p.id === Number(b.dataset.plan))); });
    } catch (e) {
      console.warn("[SORASAKI] Planos:", e);
      $("plansSection").hidden = true;
    }
  }

  async function loadMine() {
    const user = auth.getUser();
    if (!user) { myGroups = []; $("myGroupsSection").hidden = true; $("myOrdersSection").hidden = true; return; }
    try {
      const { data, error } = await client.from("groups")
        .select("id,name,platform,description,category,invite_url,avatar_url,avatar_source,member_count,tags,contact_url,highlight,status,admin_note,created_at,view_count")
        .eq("owner_id", user.id).order("created_at", { ascending: false });
      if (error) throw error;
      myGroups = data || [];
      $("myGroupsSection").hidden = !myGroups.length;
      $("myGroupsList").innerHTML = myGroups.map((g) => `
        <div class="my-group-row">
          <div><strong>${esc(g.name)}</strong><span>${esc(CAT[g.category] || g.category)} · enviada em ${fmtData(g.created_at)} · ${fmtNumero(g.view_count || 0)} visitas</span>${g.admin_note && g.status !== "approved" ? `<small class="admin-note">Nota da equipe: ${esc(g.admin_note)}</small>` : ""}</div>
          <div class="my-group-actions"><span class="status-badge ${esc(g.status)}">${STATUS[g.status] || esc(g.status)}</span><button class="btn btn-sm" type="button" data-edit-group="${g.id}">Editar</button><button class="btn btn-sm btn-danger" type="button" data-delete-group="${g.id}">Remover</button></div>
        </div>`).join("");
    } catch (e) {
      console.warn("[SORASAKI] Minhas divulgações:", e);
      $("myGroupsSection").hidden = false;
      $("myGroupsList").innerHTML = Sora.emptyState("Não foi possível carregar suas divulgações.", "Tente novamente em instantes.");
    }
    try {
      const { data } = await client.from("orders").select("id,amount,status,created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(20);
      $("myOrdersSection").hidden = !data?.length;
      $("myOrdersList").innerHTML = (data || []).map((o) => `<div class="my-group-row"><div><strong>Pedido #${o.id}</strong><span>${fmtMoeda(o.amount)} · ${fmtData(o.created_at)}</span></div><div class="my-group-actions"><span class="status-badge ${esc(o.status)}">${ORDER_STATUS[o.status] || esc(o.status)}</span></div></div>`).join("");
    } catch (e) { console.warn("[SORASAKI] Pedidos:", e); }
  }

  $("myGroupsList").addEventListener("click", async (e) => {
    const edit = e.target.closest("[data-edit-group]");
    if (edit) { const g = myGroups.find((x) => x.id === Number(edit.dataset.editGroup)); if (g) startEditGroup(g); return; }
    const del = e.target.closest("[data-delete-group]");
    if (del) {
      if (!Sora.confirmTap(del, "Confirmar remoção")) return;
      Sora.setBusy(del, true);
      const { error } = await client.from("groups").delete().eq("id", Number(del.dataset.deleteGroup)).eq("owner_id", auth.getUser()?.id);
      if (error) { console.warn("[SORASAKI] Remover divulgação:", error); Sora.setBusy(del, false); Sora.toast("Não foi possível remover a divulgação. Tente novamente.", "error"); return; }
      Sora.toast("Divulgação removida.", "ok");
      loadMine(); loadGroups();
    }
  });
  document.addEventListener("sorasaki:groups-changed", () => { loadMine(); loadGroups(); });

  /* ---------- Divulgação ---------- */
  async function openSubmit() {
    await auth.ready;
    if (!auth.getUser()) {
      showSubmitState("gate");
      openModal("groupModal");
      return;
    }
    if (!editingGroupId && state.submissions_enabled === false) {
      showSubmitState("paused");
      openModal("groupModal");
      return;
    }
    showSubmitState("form");
    $("rulesCheckWrap").hidden = Boolean(editingGroupId);
    openModal("groupModal");
    updatePreview();
    updateCount();
  }
  document.querySelectorAll("[data-open-submit]").forEach((b) => { b.onclick = () => { editingGroupId = null; openSubmit(); }; });
  $("groupModal").querySelectorAll("[data-gate]").forEach((b) => {
    b.onclick = () => {
      auth.setAfterAuth(() => openSubmit());
      try { sessionStorage.setItem("sorasaki_return_to_divulgacao", "1"); } catch {}
      closeModal("groupModal");
      auth.open(b.dataset.gate, b.dataset.gate === "login" ? "Entre para continuar a sua divulgação." : "");
    };
  });
  $("successMine").onclick = () => { closeModal("groupModal"); $("myGroupsSection").hidden = false; $("myGroupsSection").scrollIntoView({ behavior: "smooth" }); };

  function startEditGroup(g) {
    editingGroupId = g.id;
    $("groupModalKicker").textContent = "Editar divulgação";
    $("groupModalTitle").textContent = g.name;
    $("groupModalIntro").textContent = "Ao salvar, a divulgação volta para análise e sai da vitrine até ser aprovada novamente.";
    $("groupSubmitBtn").innerHTML = "Salvar e reenviar para análise";
    $("groupName").value = g.name || "";
    $("groupCategory").value = g.category || "outros";
    $("groupPlatform").value = g.platform || "";
    $("groupDescription").value = g.description || "";
    $("groupMembers").value = Number(g.member_count) || "";
    $("groupLink").value = g.invite_url || "";
    $("groupAvatar").value = g.avatar_url || "";
    autoImageUrl = g.avatar_source === "auto" ? g.avatar_url || "" : "";
    $("groupTags").value = g.tags || "";
    $("groupContact").value = g.contact_url || "";
    $("groupHighlight").value = g.highlight || "";
    if (g.avatar_url || g.tags || g.contact_url || g.highlight || g.member_count) $("optionalBlock").open = true;
    openSubmit();
  }

  function resetSubmitForm() {
    editingGroupId = null;
    autoImageUrl = "";
    autoImageHash = "";
    $("groupForm").reset();
    $("optionalBlock").open = false;
    $("groupModalKicker").textContent = "Nova divulgação";
    $("groupModalTitle").textContent = "Divulgue seu grupo";
    $("groupModalIntro").textContent = "Preencha as informações abaixo. Depois do envio, a equipe revisa antes de publicar.";
    $("groupSubmitBtn").innerHTML = 'Enviar para análise <span aria-hidden="true">→</span>';
    Sora.showResult($("groupFormResult"), "", "");
    $("groupForm").querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
    setImageStatus("idle", "Foto automática", "Cole o link de convite e tentamos buscar a foto pública do grupo.");
    updatePreview();
    updateCount();
  }

  function updateCount() {
    const n = $("groupDescription").value.length;
    $("descCount").textContent = `${n}/800`;
    $("descCount").classList.toggle("near", n > 720);
  }

  function updatePreview() {
    const name = $("groupName").value.trim() || "Nome do grupo";
    const category = $("groupCategory").value;
    const platform = $("groupPlatform").value.trim();
    const desc = $("groupDescription").value.trim() || "A descrição da sua comunidade aparece aqui.";
    const members = Number($("groupMembers").value);
    const tags = $("groupTags").value.split(",").map((x) => x.trim().replace(/^#/, "").replace(/\s+/g, "")).filter(Boolean).slice(0, 5);
    const highlight = $("groupHighlight").value.trim();
    const img = Sora.safeUrl($("groupAvatar").value.trim()) || Sora.safeUrl(autoImageUrl);
    $("previewName").textContent = name;
    $("previewCategory").textContent = (CAT[category] || category) + (platform ? " · " + platform : "");
    $("previewDescription").textContent = desc;
    $("previewMembers").textContent = members > 0 ? `${fmtNumero(members)} membros` : "Membros não informados";
    $("previewHighlight").textContent = highlight;
    $("previewHighlight").hidden = !highlight;
    $("previewTags").innerHTML = tags.map((t) => `<span>#${esc(t)}</span>`).join("");
    $("previewAvatar").innerHTML = img ? `<img src="${esc(img)}" alt="">` : esc(Sora.initials(name === "Nome do grupo" ? "S" : name));
  }
  ["groupName", "groupCategory", "groupPlatform", "groupDescription", "groupMembers", "groupTags", "groupHighlight"].forEach((id) => $(id).addEventListener("input", () => { updatePreview(); $(id).removeAttribute("aria-invalid"); }));
  $("groupDescription").addEventListener("input", updateCount);
  $("groupAvatar").addEventListener("input", () => { autoImageUrl = ""; updatePreview(); });
  $("groupContact").addEventListener("input", () => $("groupContact").removeAttribute("aria-invalid"));
  $("previewToggle").onclick = () => {
    const open = $("previewWrap").classList.toggle("open");
    $("previewToggle").setAttribute("aria-expanded", String(open));
    $("previewToggle").textContent = open ? "Ocultar prévia" : "Ver prévia";
  };

  function setImageStatus(kind, title, text) {
    const box = $("groupImageStatus");
    box.dataset.kind = kind;
    box.querySelector("strong").textContent = title;
    box.querySelector("small").textContent = text;
  }
  async function identifyGroup(force = false) {
    const link = $("groupLink").value.trim();
    if (!/^https?:\/\//i.test(link)) { if (force) setImageStatus("error", "Informe o link primeiro", "Cole um link de convite completo, começando com https://"); return; }
    clearTimeout(previewTimer);
    if (previewBusy && !force) return;
    previewBusy = true;
    const btn = $("groupRefreshImage");
    Sora.setBusy(btn, true);
    setImageStatus("loading", "Buscando informações…", "Consultamos apenas o que o convite mostra publicamente.");
    try {
      const token = await auth.getToken();
      const r = await Sora.fetchJson("/api/admin-extra?type=group-preview", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ invite_url: link, entity: "group", id: editingGroupId || 0 }) }, 20000);
      const result = r.body || {};
      if (!r.ok) { setImageStatus("error", "Não foi possível buscar agora", result.message || "Você pode continuar e adicionar uma imagem nos detalhes opcionais."); return; }
      if (result.name && !$("groupName").value.trim()) $("groupName").value = result.name.slice(0, 100);
      if (result.provider && result.provider !== "unknown" && !$("groupPlatform").value.trim()) $("groupPlatform").value = { whatsapp: "WhatsApp", telegram: "Telegram", discord: "Discord" }[result.provider] || "";
      if (result.image_url) {
        autoImageUrl = result.image_url;
        autoImageHash = result.image_hash || "";
        $("groupAvatar").value = result.image_url;
        setImageStatus("found", "Foto do grupo encontrada", "Ela aparece na prévia. Você pode trocar nos detalhes opcionais.");
      } else {
        setImageStatus("error", "Foto não encontrada", result.message || "Você pode adicionar uma imagem nos detalhes opcionais.");
      }
      updatePreview();
    } catch (e) {
      console.warn("[SORASAKI] Foto automática:", e);
      setImageStatus("error", "Não foi possível buscar agora", "Você pode continuar normalmente e adicionar uma imagem depois.");
    } finally {
      previewBusy = false;
      Sora.setBusy(btn, false);
    }
  }
  $("groupLink").addEventListener("input", () => {
    $("groupLink").removeAttribute("aria-invalid");
    clearTimeout(previewTimer);
    if (/^https?:\/\/\S{6,}/i.test($("groupLink").value.trim())) previewTimer = setTimeout(() => identifyGroup(false), 900);
  });
  $("groupRefreshImage").onclick = () => identifyGroup(true);

  $("groupAvatarFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setImageStatus("error", "Imagem não aceita", "Use JPG, PNG, WEBP ou GIF de até 5 MB.");
      e.target.value = "";
      return;
    }
    const user = auth.getUser();
    if (!user) return;
    setImageStatus("loading", "Enviando imagem…", "Só um instante.");
    try {
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[file.type];
      const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // A regra do armazenamento exige que a primeira pasta seja o ID do usuário.
      const path = `${user.id}/manual-${id}.${ext}`;
      const up = await client.storage.from("group-images").upload(path, file, { contentType: file.type, cacheControl: "31536000", upsert: false });
      if (up.error) throw up.error;
      autoImageUrl = "";
      $("groupAvatar").value = client.storage.from("group-images").getPublicUrl(path).data.publicUrl;
      setImageStatus("manual", "Imagem enviada", "Ela será usada nesta divulgação.");
      updatePreview();
    } catch (err) {
      console.warn("[SORASAKI] Upload de imagem:", err);
      setImageStatus("error", "Não foi possível enviar a imagem", "Tente outra imagem ou use um link de imagem.");
    }
  });

  function validUrl(v) { try { const u = new URL(v); return /^https?:$/.test(u.protocol) && u.hostname.includes("."); } catch { return false; } }
  function submitErrorMessage(error) {
    const m = String(error?.message || "").toLowerCase();
    if (error?.code === "23505" || m.includes("duplicate")) return "Este link de convite já está cadastrado no Sorasaki.";
    if (m.includes("limite")) return `Você atingiu o limite de ${state.max_submissions_24h} divulgações em 24 horas. Tente novamente mais tarde.`;
    if (m.includes("desativadas")) return "Novas divulgações estão pausadas no momento.";
    if (m.includes("suspensa")) return "Sua conta está suspensa e não pode enviar divulgações. Fale com o suporte.";
    if (error?.code === "23514") return "Algum campo está fora do formato aceito. Confira as informações e tente novamente.";
    return Sora.friendlyError(error, "Não foi possível enviar agora. Confira os dados e tente novamente.");
  }

  $("groupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    await auth.ready;
    const user = auth.getUser();
    if (!user) { showSubmitState("gate"); return; }
    const res = $("groupFormResult");
    const v = {
      name: $("groupName").value.trim(),
      platform: $("groupPlatform").value.trim(),
      description: $("groupDescription").value.trim(),
      category: $("groupCategory").value,
      invite_url: $("groupLink").value.trim(),
      avatar_url: $("groupAvatar").value.trim() || null,
      tags: $("groupTags").value.trim() || null,
      contact_url: $("groupContact").value.trim() || null,
      highlight: $("groupHighlight").value.trim() || null,
      member_count: Math.max(0, Math.min(10000000, Math.floor(Number($("groupMembers").value) || 0)))
    };
    const erros = [];
    const marcar = (id, msg) => { $(id).setAttribute("aria-invalid", "true"); erros.push({ id, msg }); };
    if (v.name.length < 2) marcar("groupName", "Informe o nome do grupo.");
    if (v.platform.length < 2) marcar("groupPlatform", "Informe a plataforma (ex.: WhatsApp).");
    if (v.description.length < 10) marcar("groupDescription", "A descrição precisa ter pelo menos 10 caracteres.");
    if (!validUrl(v.invite_url) || v.invite_url.length < 10) marcar("groupLink", "Informe um link de convite válido, começando com https://");
    if (v.avatar_url && !validUrl(v.avatar_url)) { $("optionalBlock").open = true; marcar("groupAvatar", "O link da imagem não parece válido."); }
    if (v.contact_url && !validUrl(v.contact_url)) { $("optionalBlock").open = true; marcar("groupContact", "O link de contato não parece válido."); }
    if (!editingGroupId && !$("groupRules").checked) erros.push({ id: "groupRules", msg: "Confirme que leu as regras de divulgação." });
    if (erros.length) {
      Sora.showResult(res, "error", erros.map((x) => x.msg).join(" "));
      $(erros[0].id).focus();
      return;
    }
    const avatar_source = v.avatar_url ? (autoImageUrl && v.avatar_url === autoImageUrl ? "auto" : "manual") : "fallback";
    const payload = {
      ...v,
      avatar_source,
      // O banco só aceita pending/found/not_found/error/manual aqui ("fallback" quebrava o envio sem foto).
      avatar_status: v.avatar_url ? (avatar_source === "auto" ? "found" : "manual") : "not_found",
      avatar_checked_at: avatar_source === "auto" ? new Date().toISOString() : null,
      avatar_hash: avatar_source === "auto" ? autoImageHash || null : null,
      status: "pending"
    };
    const btn = $("groupSubmitBtn");
    Sora.setBusy(btn, true, editingGroupId ? "Salvando…" : "Enviando…");
    Sora.showResult(res, "", "");
    try {
      const wasEditing = Boolean(editingGroupId);
      const result = wasEditing
        ? await client.from("groups").update({ ...payload, featured_by_admin: false, admin_badge: null, admin_note: null, approved_at: null }).eq("id", editingGroupId).eq("owner_id", user.id).select("id")
        : await client.from("groups").insert({ ...payload, owner_id: user.id }).select("id");
      if (result.error) {
        console.warn("[SORASAKI] Envio de divulgação:", result.error);
        Sora.showResult(res, "error", submitErrorMessage(result.error));
        return;
      }
      if (wasEditing && !result.data?.length) { Sora.showResult(res, "error", "Não encontramos esta divulgação na sua conta."); return; }
      try { sessionStorage.removeItem("sorasaki_return_to_divulgacao"); } catch {}
      $("successTitle").textContent = wasEditing ? "Alterações enviadas para análise" : "Divulgação enviada para análise";
      $("successText").textContent = wasEditing ? "A divulgação saiu da vitrine e volta assim que a equipe aprovar as alterações." : "Recebemos o seu grupo. Ele ainda não aparece na vitrine.";
      editingGroupId = null;
      $("groupForm").reset();
      showSubmitState("success");
      loadMine();
      loadGroups();
    } catch (err) {
      console.error("[SORASAKI] Envio de divulgação:", err);
      Sora.showResult(res, "error", submitErrorMessage(err));
    } finally {
      Sora.setBusy(btn, false);
    }
  });

  /* ---------- Avaliar e relatar ---------- */
  function groupName(id) { return groups.find((g) => g.id === id)?.name || ""; }
  function openReview(id) {
    if (!auth.requireLogin("Entre na sua conta para avaliar um grupo.")) return;
    $("reviewForm").reset();
    $("reviewGroupId").value = id;
    $("reviewGroupName").textContent = groupName(id);
    selectedRating = 0;
    document.querySelectorAll("#ratingPicker button").forEach((b) => { b.classList.remove("selected"); b.setAttribute("aria-checked", "false"); });
    Sora.showResult($("reviewResult"), "", "");
    openModal("reviewModal");
  }
  document.querySelectorAll("#ratingPicker button").forEach((b) => {
    b.setAttribute("role", "radio");
    b.onclick = () => {
      selectedRating = Number(b.dataset.rating);
      document.querySelectorAll("#ratingPicker button").forEach((x) => { const on = Number(x.dataset.rating) <= selectedRating; x.classList.toggle("selected", on); x.setAttribute("aria-checked", String(Number(x.dataset.rating) === selectedRating)); });
    };
  });
  $("reviewForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!auth.requireLogin("Entre na sua conta para avaliar um grupo.")) return;
    const res = $("reviewResult");
    if (!selectedRating) return Sora.showResult(res, "error", "Escolha uma nota de 1 a 5 estrelas.");
    const btn = $("reviewSubmit");
    Sora.setBusy(btn, true, "Enviando…");
    try {
      const token = await auth.getToken();
      const r = await Sora.fetchJson("/api/account-actions?type=review", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ group_id: Number($("reviewGroupId").value), rating: selectedRating, comment: $("reviewComment").value.trim() || null }) });
      const ok = r.ok && r.body?.ok;
      Sora.showResult(res, ok ? "ok" : "error", r.body?.message || (ok ? "Avaliação enviada." : "Não foi possível enviar agora. Tente novamente."));
      if (ok) setTimeout(() => closeModal("reviewModal"), 1600);
    } catch (err) {
      console.warn("[SORASAKI] Avaliação:", err);
      Sora.showResult(res, "error", Sora.friendlyError(err, "Não foi possível enviar agora. Tente novamente."));
    } finally { Sora.setBusy(btn, false); }
  });

  function openReport(id) {
    if (!auth.requireLogin("Entre na sua conta para relatar um problema.")) return;
    $("reportForm").reset();
    $("reportGroupId").value = id;
    Sora.showResult($("reportResult"), "", "");
    openModal("reportModal");
  }
  $("reportForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = auth.getUser();
    if (!user) return auth.requireLogin("Entre na sua conta para relatar um problema.");
    const res = $("reportResult");
    const btn = $("reportSubmit");
    Sora.setBusy(btn, true, "Enviando…");
    try {
      const { error } = await client.from("reports").insert({ group_id: Number($("reportGroupId").value), reporter_id: user.id, reason: $("reportReason").value, description: $("reportDescription").value.trim() || null });
      if (error) {
        console.warn("[SORASAKI] Relato:", error);
        const m = String(error.message || "").toLowerCase();
        return Sora.showResult(res, "error", error.code === "23505" ? "Você já relatou este grupo. A equipe está analisando." : m.includes("limite") ? "Você enviou muitos relatos hoje. Tente novamente amanhã." : Sora.friendlyError(error, "Não foi possível enviar o relato agora."));
      }
      Sora.showResult(res, "ok", "Relato enviado. Obrigado por ajudar a manter a vitrine confiável.");
      setTimeout(() => closeModal("reportModal"), 1500);
    } catch (err) {
      Sora.showResult(res, "error", Sora.friendlyError(err, "Não foi possível enviar o relato agora."));
    } finally { Sora.setBusy(btn, false); }
  });

  /* ---------- Planos ---------- */
  async function openPlan(plan) {
    if (!plan || !auth.requireLogin("Entre na sua conta para comprar um plano.")) return;
    $("planKicker").textContent = plan.name;
    $("planInfo").textContent = `${fmtMoeda(plan.price)} por ${plan.duration_days} ${plan.duration_days === 1 ? "dia" : "dias"} de destaque. Escolha qual grupo aprovado vai receber o destaque.`;
    $("checkoutCoupon").value = "";
    Sora.showResult($("planResult"), "", "");
    $("planGroupList").innerHTML = '<div class="skeleton" style="height:52px"></div>';
    openModal("planModal");
    const { data, error } = await client.from("groups").select("id,name").eq("owner_id", auth.getUser().id).eq("status", "approved").order("name");
    if (error) { $("planGroupList").innerHTML = Sora.emptyState("Não foi possível carregar seus grupos.", "Tente novamente em instantes."); return; }
    if (!data?.length) { $("planGroupList").innerHTML = Sora.emptyState("Você ainda não tem um grupo aprovado.", "O destaque só pode ser aplicado depois que a equipe aprovar a divulgação."); return; }
    $("planGroupList").innerHTML = data.map((g) => `<button class="select-group-option" type="button" data-group-buy="${g.id}"><strong>${esc(g.name)}</strong><span>Continuar →</span></button>`).join("");
    $("planGroupList").querySelectorAll("[data-group-buy]").forEach((b) => {
      b.onclick = async () => {
        Sora.setBusy(b, true, "Abrindo pagamento…");
        try {
          const token = await auth.getToken();
          const r = await Sora.fetchJson("/api/create-preference", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ plan_id: plan.id, group_id: Number(b.dataset.groupBuy), coupon_code: $("checkoutCoupon").value.trim() }) }, 20000);
          if (r.ok && r.body?.checkout_url) { location.href = r.body.checkout_url; return; }
          Sora.showResult($("planResult"), "error", r.body?.message || "Não foi possível iniciar o pagamento. Tente novamente.");
        } catch (err) {
          console.warn("[SORASAKI] Pagamento:", err);
          Sora.showResult($("planResult"), "error", Sora.friendlyError(err, "Não foi possível iniciar o pagamento. Tente novamente."));
        }
        Sora.setBusy(b, false);
      };
    });
  }

  /* ---------- Início ---------- */
  function showPaymentReturn() {
    const s = new URLSearchParams(location.search).get("pagamento");
    if (!s) return;
    const box = $("payNotice");
    const map = {
      sucesso: ["success", "Pagamento recebido.", "O destaque é liberado assim que o Mercado Pago confirmar — normalmente em poucos minutos."],
      pendente: ["info", "Pagamento pendente.", "Assim que for confirmado, o destaque é aplicado automaticamente."],
      erro: ["danger", "O pagamento não foi concluído.", "Nenhum valor foi cobrado. Você pode tentar novamente quando quiser."]
    };
    const [tipo, titulo, texto] = map[s] || map.erro;
    box.className = `notice-banner ${tipo}`;
    box.innerHTML = `<div><strong>${titulo}</strong>${texto}</div>`;
    box.hidden = false;
  }

  function handleHash() {
    if (location.hash === "#divulgar") { editingGroupId = null; openSubmit(); }
  }
  window.addEventListener("hashchange", handleHash);

  auth.onAuthChange((user, event) => {
    if (event === "INITIAL") return;
    loadMine();
    if (user && !$("groupModal").hidden && !$("groupModal").querySelector('[data-state="gate"]').hidden) openSubmit();
  });

  if (client) {
    Sora.siteState().then((s) => {
      state = { ...state, ...s };
      $("rulesLimit").textContent = state.max_submissions_24h;
      $("submissionsPaused").hidden = state.submissions_enabled !== false;
    });
    showPaymentReturn();
    loadOfficial();
    loadGroups();
    loadPlans();
    auth.ready.then(async () => {
      await loadMine();
      const params = new URLSearchParams(location.search);
      let voltar = false;
      try { voltar = sessionStorage.getItem("sorasaki_return_to_divulgacao") === "1"; } catch {}
      if (params.get("editar") && auth.getUser()) {
        const id = Number(params.get("editar"));
        const g = myGroups.find((x) => x.id === id);
        if (g) startEditGroup(g); else Sora.toast("Não encontramos esta divulgação na sua conta.", "error");
      } else if (auth.getUser() && voltar) {
        try { sessionStorage.removeItem("sorasaki_return_to_divulgacao"); } catch {}
        openSubmit();
      } else {
        handleHash();
      }
    });
  }
})();
