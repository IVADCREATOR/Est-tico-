// Script da página estatisticas.html (antes ficava inline no HTML).
// Fica em arquivo separado para o CSP não precisar de 'unsafe-inline' em scripts.
(function () {
  const $ = (id) => document.getElementById(id);
  const hasChart = Sora.applyChartDefaults();
  const t = Sora.chartTheme();
  let dias = 7;
  let ultimo = null;
  let site = null;
  let chartDiario = null, chartHoje = null, chartSite = null;

  const setVal = (id, text) => { const el = $(id); el.textContent = text; el.classList.remove("skeleton"); };
  const diaCurto = (iso) => { const [, m, d] = String(iso).slice(0, 10).split("-"); return `${d}/${m}`; };
  function chartEmpty(id, msg) { const el = $(id); el.hidden = !msg; el.textContent = msg || ""; }

  function recorte(lista) {
    return (lista || []).slice(-dias);
  }

  function desenharDiario() {
    if (!ultimo) return;
    const diario = recorte(ultimo.historico?.diario);
    if (!diario.length) { chartEmpty("diarioEmpty", "Ainda não há histórico diário registrado."); return; }
    chartEmpty("diarioEmpty", !hasChart ? "Não foi possível exibir o gráfico agora." : "");
    if (!hasChart) return;
    const labels = diario.map((d) => diaCurto(d.dia));
    const msgs = diario.map((d) => d.mensagensProcessadas || 0);
    const cmds = diario.map((d) => d.comandosExecutados || 0);
    if (!chartDiario) {
      chartDiario = new Chart($("graficoDiario"), {
        type: "line",
        data: { labels, datasets: [
          { label: "Mensagens processadas", data: msgs, borderColor: t.accent, backgroundColor: t.accentSoft, fill: true, tension: .35, pointRadius: 3, pointHoverRadius: 5, borderWidth: 2, yAxisID: "y" },
          { label: "Comandos", data: cmds, borderColor: t.second, backgroundColor: "transparent", tension: .35, pointRadius: 3, borderWidth: 2, yAxisID: "y1" }
        ] },
        options: {
          interaction: { mode: "index", intersect: false },
          plugins: { legend: { position: "bottom" } },
          scales: {
            y: { beginAtZero: true, grid: { color: t.grid }, ticks: { precision: 0 } },
            y1: { beginAtZero: true, position: "right", grid: { display: false }, ticks: { precision: 0 } },
            x: { grid: { display: false } }
          }
        }
      });
    } else {
      chartDiario.data.labels = labels;
      chartDiario.data.datasets[0].data = msgs;
      chartDiario.data.datasets[1].data = cmds;
      chartDiario.update("none");
    }
  }

  function desenharSite() {
    if (!site) return;
    const daily = recorte(site.daily);
    if (!daily.length) { chartEmpty("siteEmpty", "Ainda não há visitas registradas."); return; }
    chartEmpty("siteEmpty", !hasChart ? "Não foi possível exibir o gráfico agora." : "");
    if (!hasChart) return;
    const labels = daily.map((d) => diaCurto(d.day));
    const data = daily.map((d) => d.visitors || 0);
    if (!chartSite) {
      chartSite = new Chart($("graficoSite"), {
        type: "bar",
        data: { labels, datasets: [{ label: "Visitantes", data, backgroundColor: t.accent, borderRadius: 4, maxBarThickness: 22 }] },
        options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid: { color: t.grid }, ticks: { precision: 0 } }, x: { grid: { display: false } } } }
      });
    } else {
      chartSite.data.labels = labels;
      chartSite.data.datasets[0].data = data;
      chartSite.update("none");
    }
  }

  document.querySelectorAll("[data-days]").forEach((b) => {
    b.onclick = () => {
      dias = Number(b.dataset.days);
      document.querySelectorAll("[data-days]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      desenharDiario();
      desenharSite();
    };
  });

  onStats((s) => {
    ultimo = s;
    setVal("valRecebidas", fmtNumero(s.mensagens?.totalGeral?.recebidas));
    setVal("valEnviadas", fmtNumero(s.mensagens?.totalGeral?.enviadas));
    setVal("valComandos", fmtNumero(s.comandos?.totalGeral));
    setVal("valComandosHoje", fmtNumero(s.comandos?.totalHoje));
    $("valMsgHoje").textContent = `${fmtNumero(s.mensagens?.hoje?.mensagensProcessadas)} mensagens hoje`;
    setVal("valUsuarios", fmtNumero(s.usuarios?.unicosTotal));
    $("valUsuariosHoje").textContent = `${fmtNumero(s.usuarios?.unicosHoje)} hoje`;

    const ranking = s.comandos?.ranking || [];
    const totalUsos = ranking.reduce((acc, c) => acc + (c.usos || 0), 0);
    const somaTempo = ranking.reduce((acc, c) => acc + (c.tempoMedioMs || 0) * (c.usos || 0), 0);
    setVal("valTempoResposta", totalUsos ? `${(somaTempo / totalUsos / 1000).toFixed(1).replace(".", ",")} s` : "—");
    $("tabelaComandos").innerHTML = ranking.length
      ? ranking.slice(0, 10).map((c) => `<tr><td>!${escapeHtml(c.nome)}</td><td class="num">${fmtNumero(c.usos)}</td><td class="num">${Number(c.taxaSucesso ?? 0).toLocaleString("pt-BR")}%</td><td class="num">${((c.tempoMedioMs || 0) / 1000).toFixed(1).replace(".", ",")} s</td></tr>`).join("")
      : '<tr><td colspan="4" class="empty">Nenhum comando executado ainda.</td></tr>';

    const porHora = s.mensagens?.hoje?.porHora || [];
    const temHora = porHora.some((n) => n > 0);
    chartEmpty("hojeEmpty", !porHora.length ? "Sem dados de hoje ainda." : !hasChart ? "Não foi possível exibir o gráfico agora." : "");
    if (hasChart && porHora.length) {
      if (!chartHoje) {
        chartHoje = new Chart($("graficoHoje"), {
          type: "bar",
          data: { labels: porHora.map((_, h) => `${h}h`), datasets: [{ label: "Mensagens", data: porHora, backgroundColor: t.second, borderRadius: 3, maxBarThickness: 14 }] },
          options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid: { color: t.grid }, ticks: { precision: 0 } }, x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 8 } } } }
        });
      } else { chartHoje.data.datasets[0].data = porHora; chartHoje.update("none"); }
    }
    if (!temHora && porHora.length) chartEmpty("hojeEmpty", "Nenhuma mensagem registrada hoje ainda.");

    desenharDiario();
    $("updatedAt").textContent = `Atualizado às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  });

  onFetchError(() => {
    if (!ultimo) {
      ["valRecebidas", "valEnviadas", "valComandos", "valComandosHoje", "valUsuarios", "valTempoResposta"].forEach((id) => setVal(id, "—"));
      $("tabelaComandos").innerHTML = '<tr><td colspan="4" class="empty">Os dados do bot estão indisponíveis agora.</td></tr>';
      chartEmpty("diarioEmpty", "Os dados do bot estão indisponíveis agora.");
      chartEmpty("hojeEmpty", "Os dados do bot estão indisponíveis agora.");
      $("updatedAt").textContent = "Tentando reconectar…";
    }
  });

  async function carregarSite() {
    $("siteError").hidden = true;
    try {
      const r = await Sora.fetchJson("/api/account-actions?type=site-analytics");
      if (!r.ok || !r.body?.website) throw new Error("estatísticas do site indisponíveis");
      site = r.body.website;
      setVal("valSiteVisitantes", fmtNumero(site.unique_visitors_total));
      setVal("valSiteViews", fmtNumero(site.page_views_total));
      setVal("valSiteVisitantesHoje", fmtNumero(site.unique_visitors_today));
      setVal("valSiteViewsHoje", fmtNumero(site.page_views_today));
      const nomes = { "/": "Início", "/grupos": "Grupos", "/catalogo": "Catálogo", "/noticias": "Notícias", "/estatisticas": "Estatísticas", "/status": "Status", "/uptime": "Disponibilidade", "/erros": "Ocorrências", "/sobre": "Sobre", "/suporte": "Suporte", "/feedback": "Avaliações e bugs", "/recursos": "Recursos", "/configuracoes": "Configurações" };
      const top = (site.top_pages || []).slice(0, 6);
      const max = Math.max(1, ...top.map((p) => p.page_views || 0));
      $("topPages").innerHTML = top.length
        ? top.map((p) => `<li><div class="row"><span>${escapeHtml(nomes[String(p.path).replace(/\.html$/, "")] || p.path)}</span><span>${fmtNumero(p.page_views)}</span></div><div class="bar-track"><div class="bar-fill" style="width:${Math.round((p.page_views / max) * 100)}%"></div></div></li>`).join("")
        : '<li class="muted">Nenhuma visita registrada ainda.</li>';
      desenharSite();
    } catch (e) {
      console.warn("[SORASAKI] Visitas do site:", e);
      ["valSiteVisitantes", "valSiteViews", "valSiteVisitantesHoje", "valSiteViewsHoje"].forEach((id) => setVal(id, "—"));
      chartEmpty("siteEmpty", "Não foi possível carregar as visitas agora.");
      $("topPages").innerHTML = '<li class="muted">Indisponível no momento.</li>';
      $("siteError").hidden = false;
      $("siteError").innerHTML = Sora.emptyState("Não foi possível carregar as visitas ao site.", "Tente novamente em alguns instantes.", { retry: true });
      $("siteError").querySelector("[data-retry]").onclick = carregarSite;
    }
  }
  carregarSite();
})();
