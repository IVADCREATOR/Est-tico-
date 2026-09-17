// Script da página feedback.html (antes ficava inline no HTML).
// Fica em arquivo separado para o CSP não precisar de 'unsafe-inline' em scripts.
(function () {
  const $ = (id) => document.getElementById(id);
  const auth = window.SorasakiAuth;
  const stars = [...document.querySelectorAll(".star-rating button")];
  const labels = { 1: "Muito ruim", 2: "Ruim", 3: "Ok", 4: "Muito bom", 5: "Excelente" };
  let rating = 0;
  document.querySelector("[data-login]").onclick = () => auth.open("login");

  stars.forEach((btn) => btn.addEventListener("click", () => {
    rating = Number(btn.dataset.rating);
    stars.forEach((s) => { s.classList.toggle("selected", Number(s.dataset.rating) <= rating); s.setAttribute("aria-checked", String(Number(s.dataset.rating) === rating)); });
    $("ratingText").textContent = `${rating} de 5 — ${labels[rating]}`;
  }));

  const emailOk = (v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

  async function enviar(tipo, payload, form, resultEl, btn) {
    await auth.ready;
    const user = auth.getUser();
    if (!user) {
      Sora.showResult(resultEl, "error", "Você precisa entrar na sua conta para enviar.");
      auth.requireLogin("Entre na sua conta para enviar avaliações, sugestões ou relatos.");
      return;
    }
    const c = auth.getClient();
    if (!c) return Sora.showResult(resultEl, "error", "Não foi possível enviar agora. Recarregue a página e tente novamente.");
    Sora.setBusy(btn, true, "Enviando…");
    Sora.showResult(resultEl, "", "");
    try {
      const result = tipo === "bug"
        ? await c.from("bug_reports").insert({ user_id: user.id, title: payload.title, message: payload.message, page: payload.page, severity: payload.severity, email: payload.email || null })
        : await c.from("feedback").insert({ user_id: user.id, type: tipo, rating: payload.rating || null, title: payload.title || null, message: payload.message || null, email: payload.email || null });
      if (result.error) {
        console.warn("[SORASAKI] Feedback:", result.error);
        const m = String(result.error.message || "").toLowerCase();
        return Sora.showResult(resultEl, "error", /limite|rate/.test(m) ? "Muitos envios em pouco tempo. Aguarde um instante e tente novamente." : Sora.friendlyError(result.error, "Não foi possível enviar agora. Tente novamente em alguns instantes."));
      }
      form.reset();
      if (tipo === "rating") { rating = 0; stars.forEach((s) => { s.classList.remove("selected"); s.setAttribute("aria-checked", "false"); }); $("ratingText").textContent = "Escolha uma nota"; }
      Sora.showResult(resultEl, "ok", tipo === "bug" ? "Relato enviado. Obrigado por avisar!" : "Enviado. Obrigado por ajudar o Sorasaki a melhorar!");
    } catch (err) {
      console.error("[SORASAKI] Feedback:", err);
      Sora.showResult(resultEl, "error", Sora.friendlyError(err, "Não foi possível enviar agora. Tente novamente em alguns instantes."));
    } finally {
      Sora.setBusy(btn, false);
    }
  }

  $("ratingForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const out = $("ratingResult");
    const email = $("ratingEmail").value.trim();
    if (!rating) return Sora.showResult(out, "error", "Escolha uma nota antes de enviar.");
    if (!emailOk(email)) return Sora.showResult(out, "error", "Confira o e-mail digitado.");
    enviar("rating", { rating, message: $("ratingComment").value.trim(), email }, $("ratingForm"), out, $("sendRating"));
  });
  $("suggestForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const out = $("suggestResult");
    const title = $("suggestTitle").value.trim(), message = $("suggestMessage").value.trim();
    if (!title || !message) return Sora.showResult(out, "error", "Preencha o título e os detalhes da sugestão.");
    enviar("suggestion", { title, message }, $("suggestForm"), out, $("sendSuggestion"));
  });
  $("bug").addEventListener("submit", (e) => {
    e.preventDefault();
    const out = $("bugResult");
    const title = $("bugTitle").value.trim(), message = $("bugMessage").value.trim(), email = $("bugEmail").value.trim();
    if (!title || !message) return Sora.showResult(out, "error", "Preencha o título e o que aconteceu.");
    if (!emailOk(email)) return Sora.showResult(out, "error", "Confira o e-mail digitado.");
    enviar("bug", { title, message, page: $("bugPage").value, severity: $("bugSeverity").value, email }, $("bug"), out, $("sendBug"));
  });
})();
