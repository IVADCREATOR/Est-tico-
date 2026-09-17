// Script da página uptime.html (antes ficava inline no HTML).
// Fica em arquivo separado para o CSP não precisar de 'unsafe-inline' em scripts.
(function () {
  const $ = (id) => document.getElementById(id);
  // Motivos em linguagem simples (sem termos técnicos da conexão).
  const MOTIVOS = {
    loggedOut: "Sessão encerrada no celular do bot",
    unauthorized: "Sessão precisou ser renovada",
    badSession: "Sessão precisou ser refeita",
    conflict: "Bot aberto em outro lugar",
    connectionFailure405: "WhatsApp recusou a conexão",
    connectionRequired: "WhatsApp pediu uma nova conexão",
    connectionLost: "Internet do servidor oscilou",
    connectionClosed: "Conexão reiniciada automaticamente",
    restartRequired: "Reinício rápido da conexão",
    timedOut: "Conexão demorou para responder",
    other: "Instabilidade momentânea",
    desconhecido: "Instabilidade momentânea"
  };
  let recebeu = false;

  onStats((s) => {
    recebeu = true;
    const u = s.uptime || {};
    $("valDisponibilidade").textContent = u.disponibilidadePercentual != null ? `${String(u.disponibilidadePercentual).replace(".", ",")}%` : "—";
    $("valUptimeSessao").textContent = s.status === "online" ? fmtUptime(u.uptimeSessaoMs) : "—";
    $("valUptimeProcesso").textContent = fmtUptime(u.uptimeProcessoMs);
    $("valQuedas").textContent = fmtNumero(u.totalQuedas);
    $("valReconexoes").textContent = `${fmtNumero(u.totalReconexoes)} reconexões automáticas`;
    $("valOfflineAcumulado").textContent = fmtUptime(u.tempoTotalOfflineMs);

    const eventos = [
      ["Conectou", u.ultimaConexao],
      ["Reconectou", u.ultimaReconexao],
      ["Caiu", u.ultimaDesconexao]
    ].filter((e) => e[1]).sort((a, b) => new Date(b[1]) - new Date(a[1]));
    $("tabelaUltimasConexoes").innerHTML = eventos.length
      ? eventos.map(([nome, ts]) => `<li><time>${fmtHora(ts)}</time><span>${nome}</span></li>`).join("")
      : '<li class="empty">Nenhum evento registrado ainda.</li>';

    const quedas = (s.historico?.quedas || []).slice().sort((a, b) => new Date(b.inicio) - new Date(a.inicio)).slice(0, 12);
    $("tabelaQuedas").innerHTML = quedas.length
      ? quedas.map((q) => `<tr><td>${fmtHora(q.inicio)}</td><td>${escapeHtml(MOTIVOS[q.motivo] || MOTIVOS.other)}</td><td class="num">${q.duracaoMs != null ? fmtUptime(q.duracaoMs) : "em andamento"}</td></tr>`).join("")
      : '<tr><td colspan="3" class="empty">Nenhuma queda registrada.</td></tr>';
  });

  onFetchError(() => {
    if (recebeu) return;
    $("tabelaUltimasConexoes").innerHTML = '<li class="empty">Informações indisponíveis no momento.</li>';
    $("tabelaQuedas").innerHTML = '<tr><td colspan="3" class="empty">Informações indisponíveis no momento.</td></tr>';
  });
})();
