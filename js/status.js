// Script da página status.html (antes ficava inline no HTML).
// Fica em arquivo separado para o CSP não precisar de 'unsafe-inline' em scripts.
(function () {
  const $ = (id) => document.getElementById(id);
  const hasChart = Sora.applyChartDefaults();
  const t = Sora.chartTheme();
  let chartPing = null;
  let recebeu = false;

  const RESUMO = {
    online: "O bot está conectado e respondendo normalmente nos grupos.",
    instavel: "O bot está online, mas teve quedas rápidas nos últimos minutos. Os comandos podem demorar um pouco.",
    reconectando: "O bot perdeu a conexão por um instante e está voltando sozinho.",
    conectando: "O bot está iniciando a conexão com o WhatsApp.",
    offline: "O bot está desconectado no momento. Os comandos voltam a funcionar assim que a conexão for restabelecida."
  };

  onStats((s) => {
    recebeu = true;
    const status = statusEfetivo(s);
    $("statusResumo").textContent = RESUMO[status] || RESUMO.offline;
    $("valPing").textContent = fmtPing(s.ping?.atual);
    $("valPingMedio").textContent = fmtPing(s.ping?.medio);
    $("valSessao").textContent = s.status === "online" ? fmtUptime(s.uptime?.uptimeSessaoMs) : "—";
    $("valDisp").textContent = s.uptime?.disponibilidadePercentual != null ? `${String(s.uptime.disponibilidadePercentual).replace(".", ",")}%` : "—";
    $("updatedAt").textContent = `Atualizado às ${new Date().toLocaleTimeString("pt-BR")}`;

    const total = Number(s.comandos?.totalGeral || 0);
    const taxaErro = total > 0 ? (Number(s.comandos?.comErroGeral || 0) / total) * 100 : 0;
    const auto = s.autodisparo || {};
    const linhas = [
      { nome: "Conexão com o WhatsApp", tag: status === "online" ? ["ok", "Operando"] : status === "offline" ? ["danger", "Fora do ar"] : ["warn", statusInfo(status).curto], detalhe: statusInfo(status).texto },
      { nome: "Execução de comandos", tag: taxaErro < 5 ? ["ok", "Operando"] : ["warn", "Com falhas"], detalhe: total ? `${taxaErro.toFixed(1).replace(".", ",")}% dos comandos com falha` : "Nenhum comando executado ainda" },
      { nome: "Divulgação automática", tag: auto.status ? ["ok", "Ativa"] : ["neutral", "Pausada"], detalhe: auto.status ? (auto.proximoDisparoEm ? `Próximo envio ${fmtHora(auto.proximoDisparoEm)}` : "Aguardando o próximo ciclo") : "Desligada no momento" }
    ];
    $("tabelaServicos").innerHTML = linhas.map((l) => `<div class="service-row"><strong>${l.nome}</strong><span class="tag ${l.tag[0]}">${l.tag[1]}</span><small>${escapeHtml(l.detalhe)}</small></div>`).join("");

    const hist = s.ping?.historico || [];
    if (!hist.length) { $("pingEmpty").hidden = false; $("pingEmpty").textContent = "Ainda não há medições registradas."; return; }
    if (!hasChart) { $("pingEmpty").hidden = false; $("pingEmpty").textContent = "Não foi possível exibir o gráfico agora."; return; }
    $("pingEmpty").hidden = true;
    const labels = hist.map((p) => new Date(p.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }));
    const dados = hist.map((p) => p.ms);
    if (!chartPing) {
      chartPing = new Chart($("graficoPing"), {
        type: "line",
        data: { labels, datasets: [{ label: "Ping (ms)", data: dados, borderColor: t.accent, backgroundColor: t.accentSoft, fill: true, tension: .3, pointRadius: 0, borderWidth: 2 }] },
        options: { interaction: { mode: "index", intersect: false }, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid: { color: t.grid }, ticks: { callback: (v) => `${v} ms` } }, x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 } } } }
      });
    } else {
      chartPing.data.labels = labels;
      chartPing.data.datasets[0].data = dados;
      chartPing.update("none");
    }
  });

  onFetchError(() => {
    if (recebeu) return;
    $("statusResumo").textContent = "Não conseguimos consultar o bot agora. Isso não significa que ele esteja fora do ar — tentaremos de novo em instantes.";
    $("tabelaServicos").innerHTML = '<p class="muted">Informações indisponíveis no momento.</p>';
    $("pingEmpty").textContent = "Informações indisponíveis no momento.";
  });
})();
