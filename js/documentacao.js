(() => {
  const botoes = document.querySelectorAll("[data-tab]");
  const vistas = document.querySelectorAll("[data-view]");
  function abrir(nome) {
    botoes.forEach((b) => { const ativo = b.dataset.tab === nome; b.classList.toggle("active", ativo); b.setAttribute("aria-selected", String(ativo)); });
    vistas.forEach((v) => { const ativo = v.dataset.view === nome; v.classList.toggle("active", ativo); v.hidden = !ativo; });
    try { history.replaceState(null, "", `#${nome}`); } catch {}
  }
  botoes.forEach((b) => { b.onclick = () => { abrir(b.dataset.tab); b.scrollIntoView({ block: "nearest", inline: "center" }); }; });
  const inicial = location.hash.replace("#", "");
  if (inicial && [...botoes].some((b) => b.dataset.tab === inicial)) abrir(inicial);
})();
