// Middleware de borda (Vercel Edge) — roda ANTES de qualquer página ser
// entregue ao navegador. É isso que torna a manutenção "de verdade":
// o aviso em app.js só reage depois que a página carregou; isto aqui
// impede a página real de sair do servidor.
//
// Roda no runtime de Edge (sem Node.js), por isso usa só fetch/Request/Response.

export const config = {
  matcher: ['/((?!api/|controle-8f4c2e91|_vercel|.*\\.[\\w]+$).*)']
};

// Nunca segurar o site por mais que isto esperando o estado da manutenção.
const TEMPO_MAXIMO_MS = 1500;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function paginaManutencao(state) {
  const titulo = escapeHtml(state.title || 'Estamos em manutenção');
  const mensagem = escapeHtml(state.message || 'O site está passando por algumas melhorias no momento.');
  let retorno = '';
  if (state.return_at) {
    const d = new Date(state.return_at);
    if (!Number.isNaN(d.getTime())) {
      retorno = `<p class="eta">Previsão de retorno: ${escapeHtml(d.toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }))}</p>`;
    }
  }
  return `<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#0c0b10">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${titulo} — Sorasaki</title>
<style>
@font-face{font-family:"Bricolage Grotesque";src:url("/fonts/bricolage-grotesque.woff2") format("woff2");font-weight:200 800;font-display:swap}
@font-face{font-family:"Geist";src:url("/fonts/geist.woff2") format("woff2");font-weight:100 900;font-display:swap}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;font-family:Geist,system-ui,-apple-system,sans-serif;background:#0c0b10;color:#f2f0f6;-webkit-font-smoothing:antialiased}
.card{width:min(560px,100%);padding:clamp(20px,4vw,32px);text-align:center;border:1px solid rgba(255,255,255,.075);border-radius:20px;background:#15141b}
.card img{display:block;width:100%;max-height:420px;object-fit:cover;object-position:top;border-radius:14px;margin-bottom:22px}
h1{margin:0 0 10px;font-family:"Bricolage Grotesque",system-ui,sans-serif;font-weight:650;letter-spacing:-.03em;font-size:clamp(26px,5vw,36px);line-height:1.1}
p{margin:0;color:#bdb9c8;font-size:15.5px;line-height:1.65;white-space:pre-line}
.eta{margin-top:14px;color:#f2f0f6;font-weight:550}
.thanks{margin-top:14px;color:#8d899b;font-size:14px}
</style></head><body><main class="card"><img src="/img/sorasaki-manutencao.webp" alt=""><h1>${titulo}</h1><p>${mensagem}</p>${retorno}<p class="thanks">Obrigado pela paciência.</p></main></body></html>`;
}

export default async function middleware(request) {
  const url = new URL(request.url);
  try {
    const stateRes = await fetch(`${url.origin}/api/site-state`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TEMPO_MAXIMO_MS)
    });
    if (!stateRes.ok) return;
    const state = await stateRes.json();
    const maintenance = state?.maintenance === true || ['true', '1', 'yes', 'on'].includes(String(state?.maintenance || '').trim().toLowerCase());
    if (!maintenance) return;
    if (state.start_at) {
      const start = new Date(state.start_at).getTime();
      if (!Number.isNaN(start) && Date.now() < start) return;
    }
    return new Response(paginaManutencao(state), {
      status: 503,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'retry-after': '120',
        'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        // A página de manutenção não tem JavaScript: nenhum script é permitido.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'strict-transport-security': 'max-age=63072000; includeSubDomains',
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()'
      }
    });
  } catch {
    // Se a checagem falhar ou demorar, o site segue normal — nunca travar
    // o site inteiro por causa do estado da manutenção.
    return;
  }
}
