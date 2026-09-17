// Script da página recursos.html (antes ficava inline no HTML).
// Fica em arquivo separado para o CSP não precisar de 'unsafe-inline' em scripts.
(function () {
  const tbody = document.getElementById("rankingComandos");
  let recebeu = false;
  onStats((s) => {
    recebeu = true;
    const r = (s.comandos?.ranking || []).slice(0, 8);
    tbody.innerHTML = r.length ? r.map((c) => `<tr><td>!${escapeHtml(c.nome)}</td><td class="num">${fmtNumero(c.usos)}</td></tr>`).join("") : '<tr><td colspan="2" class="empty">Nenhum comando executado ainda.</td></tr>';
  });
  onFetchError(() => { if (!recebeu) tbody.innerHTML = '<tr><td colspan="2" class="empty">Ranking indisponível no momento.</td></tr>'; });
})();
