// Script da página catalogo.html (antes ficava inline no HTML).
// Fica em arquivo separado para o CSP não precisar de 'unsafe-inline' em scripts.
(function () {
  const $ = (id) => document.getElementById(id);
  const whatsapp = String(window.SORASAKI_CONTACT?.whatsapp || "").replace(/\D/g, "");
  let produtos = [];
  let categoria = "todas";

  function card(p) {
    const price = Number(p.promo_price ?? p.price);
    const old = p.promo_price != null ? Number(p.price) : Number(p.previous_price || 0);
    const texto = encodeURIComponent(`Olá! Vi no catálogo do Sorasaki e tenho interesse em: ${p.name} (${fmtMoeda(price)}).`);
    return `<article class="catalog-card">
      ${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name)}" loading="lazy">` : ""}
      <div class="catalog-card-body">
        ${p.category ? `<span class="catalog-category">${escapeHtml(p.category)}</span>` : ""}
        <h2>${escapeHtml(p.name)}</h2>
        <div>${old > price ? `<span class="catalog-old">${fmtMoeda(old)}</span> ` : ""}<span class="catalog-price">${fmtMoeda(price)}</span></div>
        ${p.description ? `<p>${escapeHtml(p.description)}</p>` : ""}
        ${whatsapp ? `<a class="btn btn-primary" style="margin-top:6px" href="https://wa.me/${whatsapp}?text=${texto}" target="_blank" rel="noopener noreferrer">Tenho interesse <span aria-hidden="true">↗</span></a>` : ""}
      </div>
    </article>`;
  }

  function render() {
    const lista = produtos.filter((p) => categoria === "todas" || (p.category || "Outros") === categoria);
    $("catalogGrid").innerHTML = lista.map(card).join("") || Sora.emptyState("Nenhum produto nesta categoria.", "Escolha outra categoria acima.", { icon: "search" });
    $("catalogCount").textContent = `${lista.length} ${lista.length === 1 ? "item" : "itens"}`;
  }

  async function load() {
    const box = $("catalogGrid");
    box.setAttribute("aria-busy", "true");
    try {
      const r = await Sora.fetchJson("/api/public-content?type=products");
      if (!r.ok || !r.body?.ok) throw new Error("catálogo indisponível");
      produtos = r.body.products || [];
      if (!produtos.length) {
        box.innerHTML = Sora.emptyState("Nenhum produto publicado no momento.", "Novidades aparecem aqui assim que a equipe cadastrar. Enquanto isso, fale com a gente pelo Suporte.");
        return;
      }
      const cats = [...new Set(produtos.map((p) => p.category || "Outros"))];
      if (cats.length > 1) {
        $("catalogToolbar").hidden = false;
        $("catalogFilters").innerHTML = ["todas", ...cats].map((c) => `<button class="chip ${c === "todas" ? "active" : ""}" type="button" data-cat="${escapeHtml(c)}" aria-pressed="${c === "todas"}">${c === "todas" ? "Todas" : escapeHtml(c)}</button>`).join("");
        $("catalogFilters").querySelectorAll("[data-cat]").forEach((b) => {
          b.onclick = () => {
            categoria = b.dataset.cat;
            $("catalogFilters").querySelectorAll("[data-cat]").forEach((x) => { x.classList.toggle("active", x === b); x.setAttribute("aria-pressed", String(x === b)); });
            render();
          };
        });
      }
      render();
    } catch (e) {
      console.warn("[SORASAKI] Catálogo:", e);
      box.innerHTML = Sora.emptyState("Não foi possível carregar o catálogo.", "Verifique sua conexão e tente novamente.", { retry: true });
      box.querySelector("[data-retry]").onclick = load;
    } finally {
      box.setAttribute("aria-busy", "false");
    }
  }
  load();
})();
