// Script da página suporte.html (antes ficava inline no HTML).
// Fica em arquivo separado para o CSP não precisar de 'unsafe-inline' em scripts.
(function () {
  const c = window.SORASAKI_CONTACT || {};
  const wa = String(c.whatsapp || "").replace(/\D/g, "");
  if (wa) { document.getElementById("contactWhats").href = `https://wa.me/${wa}`; document.getElementById("contactWhatsLabel").textContent = c.whatsappLabel || `+${wa}`; }
  if (c.email) { document.getElementById("contactMail").href = `mailto:${c.email}`; document.getElementById("contactMailLabel").textContent = c.email; }
  document.getElementById("faqList").innerHTML = SORASAKI_FAQ.map((f) => `<details><summary>${escapeHtml(f.pergunta)}</summary><p>${escapeHtml(f.resposta)}</p></details>`).join("");
})();
