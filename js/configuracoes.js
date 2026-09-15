// Script da página configuracoes.html (antes ficava inline no HTML).
// Fica em arquivo separado para o CSP não precisar de 'unsafe-inline' em scripts.
(function () {
  const motion = document.getElementById("prefMotion");
  const assistant = document.getElementById("prefAssistant");
  motion.checked = SORA_PREFS.get("motion", "auto") === "reduce";
  assistant.checked = SORA_PREFS.get("assistant", "on") !== "off";
  motion.addEventListener("change", () => {
    SORA_PREFS.set("motion", motion.checked ? "reduce" : "auto");
    document.documentElement.classList.toggle("reduce-motion", motion.checked);
    Sora.toast(motion.checked ? "Animações reduzidas." : "Animações ativadas.", "ok", 2500);
  });
  assistant.addEventListener("change", () => {
    SORA_PREFS.set("assistant", assistant.checked ? "on" : "off");
    const w = document.querySelector(".assistant-widget");
    if (assistant.checked && !w) criarAssistente();
    if (w) w.classList.toggle("is-hidden", !assistant.checked);
    Sora.toast(assistant.checked ? "Assistente ativado." : "Assistente oculto.", "ok", 2500);
  });
  const analytics = document.getElementById("prefAnalytics");
  analytics.checked = SORA_PREFS.get("analytics", "on") !== "off";
  analytics.addEventListener("change", () => {
    SORA_PREFS.set("analytics", analytics.checked ? "on" : "off");
    // Desligar vale imediatamente para o Google Analytics nesta página.
    if (!analytics.checked && window.SORASAKI_GA_ID) window["ga-disable-" + window.SORASAKI_GA_ID] = true;
    else if (window.SORASAKI_GA_ID) { window["ga-disable-" + window.SORASAKI_GA_ID] = false; iniciarConfigPublica(); }
    Sora.toast(analytics.checked ? "Estatísticas de uso ativadas." : "Estatísticas de uso desativadas neste aparelho.", "ok", 2500);
  });
  document.getElementById("prefAccount").onclick = () => (SorasakiAuth.getUser() ? SorasakiAuth.openProfile() : SorasakiAuth.open("login"));
})();
