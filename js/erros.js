// Script da página erros.html (antes ficava inline no HTML).
// Fica em arquivo separado para o CSP não precisar de 'unsafe-inline' em scripts.
(function () {
  const $ = (id) => document.getElementById(id);
  let recebeu = false;
  const nomeArea = (k) => String(k || "Geral").replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

  onStats((s) => {
    recebeu = true;
    const e = s.erros || {};
    $("valErrosHoje").textContent = fmtNumero(e.hoje);
    $("valErrosTotal").textContent = fmtNumero(e.total);
    const total = Number(s.comandos?.totalGeral || 0);
    const comErro = Number(s.comandos?.comErroGeral || 0);
    $("valTaxaErro").textContent = total ? `${((comErro / total) * 100).toFixed(1).replace(".", ",")}%` : "0%";
    $("valTaxaFoot").textContent = `${fmtNumero(comErro)} de ${fmtNumero(total)}`;
    const ultimo = e.ultimoErro && typeof e.ultimoErro === "object" ? (e.ultimoErro.ts || e.ultimoErro.timestamp || e.ultimoErro.em) : e.ultimoErro;
    $("valUltimoErro").textContent = ultimo ? fmtHora(ultimo) : "Nenhuma";

    const modulos = Object.entries(e.porModulo || {}).map(([k, v]) => [k, typeof v === "object" ? Number(v?.total || v?.count || 0) : Number(v || 0)]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 10);
    $("tabelaModulos").innerHTML = modulos.length
      ? modulos.map(([k, v]) => `<tr><td>${escapeHtml(nomeArea(k))}</td><td class="num">${fmtNumero(v)}</td></tr>`).join("")
      : '<tr><td colspan="2" class="empty">Nenhuma falha registrada.</td></tr>';

    const piores = (s.comandos?.ranking || []).filter((c) => Number(c.taxaSucesso) < 100).sort((a, b) => a.taxaSucesso - b.taxaSucesso).slice(0, 8);
    $("tabelaComandos").innerHTML = piores.length
      ? piores.map((c) => `<tr><td>!${escapeHtml(c.nome)}</td><td class="num">${fmtNumero(c.usos)}</td><td class="num">${Number(c.taxaSucesso).toLocaleString("pt-BR")}%</td></tr>`).join("")
      : '<tr><td colspan="3" class="empty">Todos os comandos estão funcionando sem falhas.</td></tr>';
  });

  onFetchError(() => {
    if (recebeu) return;
    $("tabelaModulos").innerHTML = '<tr><td colspan="2" class="empty">Informações indisponíveis no momento.</td></tr>';
    $("tabelaComandos").innerHTML = '<tr><td colspan="3" class="empty">Informações indisponíveis no momento.</td></tr>';
  });
})();
