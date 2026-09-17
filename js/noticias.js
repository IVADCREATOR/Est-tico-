// Script da página noticias.html (antes ficava inline no HTML).
// Fica em arquivo separado para o CSP não precisar de 'unsafe-inline' em scripts.
(function () {
  const $ = (id) => document.getElementById(id);
  async function load() {
    const grid = $("newsGrid");
    grid.setAttribute("aria-busy", "true");
    try {
      const r = await Sora.fetchJson("/api/public-content?type=all");
      if (!r.ok || !r.body?.ok) throw new Error("notícias indisponíveis");
      const d = r.body;
      const tipo = { info: "info", success: "success", warning: "", danger: "danger" };
      const notices = d.notices || [];
      $("notices").innerHTML = notices.map((n) => `<div class="notice-banner ${tipo[n.notice_type] ?? "info"}" role="note"><div><strong>${escapeHtml(n.title)}</strong>${escapeHtml(n.message)}</div></div>`).join("");
      $("notices").hidden = !notices.length;
      const news = d.news || [];
      grid.innerHTML = news.map((n) => {
        const resumo = n.summary || String(n.content || "").slice(0, 260);
        const temMais = n.content && n.content.trim() !== resumo.trim();
        return `<article class="panel news-card" id="noticia-${n.id}">
          ${n.image_url ? `<img src="${escapeHtml(n.image_url)}" alt="" loading="lazy">` : ""}
          <div class="news-meta">${escapeHtml(n.category || "Novidade")} · <time datetime="${escapeHtml(n.publish_at)}">${fmtData(n.publish_at)}</time></div>
          <h2>${escapeHtml(n.title)}</h2>
          <p>${escapeHtml(resumo)}</p>
          ${temMais ? `<details><summary>Ler a notícia completa</summary><p>${escapeHtml(n.content)}</p></details>` : ""}
        </article>`;
      }).join("") || Sora.emptyState("Nenhuma notícia publicada ainda.", "Quando a equipe publicar uma novidade, ela aparece aqui.");
      if (location.hash.startsWith("#noticia-")) {
        const alvo = document.querySelector(location.hash);
        if (alvo) { alvo.querySelector("details")?.setAttribute("open", ""); alvo.scrollIntoView({ block: "start" }); }
      }
    } catch (e) {
      console.warn("[SORASAKI] Notícias:", e);
      grid.innerHTML = Sora.emptyState("Não foi possível carregar as novidades.", "Verifique sua conexão e tente novamente.", { retry: true });
      grid.querySelector("[data-retry]").onclick = load;
    } finally {
      grid.setAttribute("aria-busy", "false");
    }
  }
  load();
})();
