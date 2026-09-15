// Script da página index.html (antes ficava inline no HTML).
// Fica em arquivo separado para o CSP não precisar de 'unsafe-inline' em scripts.
(function () {
  const $ = (id) => document.getElementById(id);

  // Bot ao vivo
  onStats((s) => {
    const status = statusEfetivo(s);
    const info = statusInfo(status);
    const ping = fmtPing(s.ping?.atual);
    const disp = s.uptime?.disponibilidadePercentual != null ? `${String(s.uptime.disponibilidadePercentual).replace(".", ",")}%` : "—";
    $("valStatus").textContent = info.curto;
    $("valPing").textContent = ping;
    $("valDisponibilidade").textContent = disp;
    $("valMensagensHoje").textContent = fmtNumero(s.mensagens?.hoje?.mensagensProcessadas);
    $("valComandosHoje").textContent = fmtNumero(s.comandos?.totalHoje);
    $("valUptimeSessao").textContent = s.status === "online" ? fmtUptime(s.uptime?.uptimeSessaoMs) : "—";
    $("heroPing").textContent = ping;
    $("heroAvailability").textContent = disp;
    $("heroCommands").textContent = fmtNumero(s.comandos?.totalHoje);

    const eventos = [];
    if (s.uptime?.ultimaReconexao) eventos.push({ ts: s.uptime.ultimaReconexao, texto: "Conexão restabelecida" });
    if (s.uptime?.ultimaDesconexao) eventos.push({ ts: s.uptime.ultimaDesconexao, texto: "Queda rápida de conexão" });
    const ultimoErro = typeof s.erros?.ultimoErro === "object" ? (s.erros.ultimoErro?.ts || s.erros.ultimoErro?.timestamp) : s.erros?.ultimoErro;
    if (ultimoErro) eventos.push({ ts: ultimoErro, texto: "Falha registrada em um comando" });
    if (s.autodisparo?.ultimoDisparoEm) eventos.push({ ts: s.autodisparo.ultimoDisparoEm, texto: "Divulgação automática enviada" });
    if (s.autodisparo?.proximoDisparoEm) eventos.push({ ts: s.autodisparo.proximoDisparoEm, texto: "Próxima divulgação automática" });
    eventos.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    $("tabelaEventos").innerHTML = eventos.length
      ? eventos.slice(0, 5).map((e) => `<li><time>${fmtHora(e.ts)}</time><span>${escapeHtml(e.texto)}</span></li>`).join("")
      : '<li class="empty">Nenhum acontecimento recente. Tudo tranquilo.</li>';
  });
  onFetchError(() => {
    if ($("tabelaEventos").textContent.includes("Carregando")) $("tabelaEventos").innerHTML = '<li class="empty">Os dados do bot aparecem aqui assim que a conexão voltar.</li>';
  });

  // Avisos, notícias e produtos
  (async () => {
    try {
      const r = await Sora.fetchJson("/api/public-content?type=all");
      if (!r.ok || !r.body?.ok) throw new Error("conteúdo público indisponível");
      const d = r.body;
      const notices = d.notices || [];
      if (notices.length) {
        const tipo = { info: "info", success: "success", warning: "", danger: "danger" };
        $("homeNoticeArea").innerHTML = notices.map((n) => `<div class="notice-banner ${tipo[n.notice_type] ?? "info"}" role="note"><div><strong>${escapeHtml(n.title)}</strong>${escapeHtml(n.message)}</div></div>`).join("");
        $("homeNoticeArea").hidden = false;
      }
      const news = d.news || [];
      if (news.length) {
        $("homeNewsGrid").innerHTML = news.slice(0, 3).map((n) => `<article class="news-row"><time datetime="${escapeHtml(n.publish_at)}">${fmtData(n.publish_at)}</time><div><div class="news-cat">${escapeHtml(n.category || "Novidade")}</div><h3>${escapeHtml(n.title)}</h3><p>${escapeHtml(n.summary || String(n.content || "").slice(0, 180))}</p></div><a class="btn btn-sm btn-ghost" href="/noticias#noticia-${n.id}">Ler</a></article>`).join("");
        $("homeNewsArea").hidden = false;
      }
      const products = d.products || [];
      if (products.length) {
        $("homeProductsGrid").innerHTML = products.slice(0, 3).map((p) => {
          const price = Number(p.promo_price ?? p.price);
          const old = p.promo_price != null ? Number(p.price) : Number(p.previous_price || 0);
          return `<article class="catalog-card">${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="" loading="lazy">` : ""}<div class="catalog-card-body">${p.category ? `<span class="catalog-category">${escapeHtml(p.category)}</span>` : ""}<h3>${escapeHtml(p.name)}</h3>${old > price ? `<span class="catalog-old">${fmtMoeda(old)}</span>` : ""}<span class="catalog-price">${fmtMoeda(price)}</span>${p.description ? `<p>${escapeHtml(p.description)}</p>` : ""}</div></article>`;
        }).join("");
        $("homeProductsArea").hidden = false;
      }
    } catch (e) {
      console.warn("[SORASAKI] Conteúdo da página inicial:", e);
    }
  })();

  // Grupos oficiais
  (async () => {
    const box = $("officialHomeGrid");
    const c = window.SorasakiAuth?.getClient?.();
    const cats = { vendas: "Compra e venda", comunidade: "Comunidade", jogos: "Jogos", freefire: "Free Fire", divulgacao: "Divulgação", amizades: "Amizades", suporte: "Suporte", estudos: "Estudos", outros: "Outros" };
    if (!c) { $("officialHomeSection").hidden = true; return; }
    try {
      const { data, error } = await c.from("official_groups").select("id,name,description,category,invite_url,image_url,avatar_url,highlight_phrase,highlight").eq("active", true).order("display_order", { ascending: true }).limit(6);
      if (error) throw error;
      if (!data?.length) { $("officialHomeSection").hidden = true; return; }
      box.innerHTML = data.map((g) => {
        const img = Sora.safeUrl(g.image_url || g.avatar_url);
        const destaque = g.highlight_phrase || g.highlight;
        return `<article class="official-card"><div class="official-card-top"><div class="official-icon">${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy">` : escapeHtml(Sora.initials(g.name))}</div><div class="group-title-block"><h3>${escapeHtml(g.name)}</h3><span>${escapeHtml(cats[g.category] || g.category)}</span></div></div>${destaque ? `<div class="official-highlight">${escapeHtml(destaque)}</div>` : ""}<p>${escapeHtml(g.description)}</p><a class="btn btn-primary" href="${escapeHtml(Sora.safeUrl(g.invite_url))}" target="_blank" rel="noopener noreferrer">Entrar no grupo <span aria-hidden="true">↗</span></a></article>`;
      }).join("");
    } catch (e) {
      console.warn("[SORASAKI] Grupos oficiais:", e);
      box.innerHTML = Sora.emptyState("Não foi possível carregar os grupos oficiais.", "Tente novamente em alguns instantes.");
    }
  })();
})();
