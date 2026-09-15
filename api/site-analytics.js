import { supabaseRequest, readJsonBody, sendJson, serverError, originAllowed, rateLimit, clientIp } from './_supabase.js';

// Só páginas do próprio site entram na contagem (evita encher o banco com
// caminhos inventados).
const PAGINAS = new Set(['/', '/grupos', '/catalogo', '/noticias', '/estatisticas', '/status', '/uptime', '/erros', '/sobre', '/suporte', '/recursos', '/configuracoes', '/feedback', '/termos', '/privacidade']);
function cleanPath(v) {
  const x = String(v || '/').trim().split(/[?#]/)[0].replace(/\.html$/, '').replace(/\/+$/, '') || '/';
  return PAGINAS.has(x) ? x : null;
}
function validVisitorId(v) {
  return /^[A-Za-z0-9_-]{20,120}$/.test(String(v || ''));
}
async function readAnalytics() {
  const result = await supabaseRequest('/rest/v1/rpc/get_site_analytics', { method: 'POST', body: '{}' });
  return result && result.ok ? result : { ok: true, website: result || {} };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return sendJson(res, 200, await readAnalytics());
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return sendJson(res, 405, { ok: false, message: 'Ação não disponível.' });
    }
    if (!originAllowed(req)) return sendJson(res, 403, { ok: false });
    if (!rateLimit(`visit:${clientIp(req)}`, 60, 60_000)) return sendJson(res, 429, { ok: false });
    const body = readJsonBody(req) || {};
    const visitorId = String(body.visitor_id || '').trim();
    const path = cleanPath(body.path);
    if (!validVisitorId(visitorId) || !path) return sendJson(res, 400, { ok: false });
    await supabaseRequest('/rest/v1/rpc/record_site_visit', {
      method: 'POST',
      body: JSON.stringify({ p_visitor_id: visitorId, p_path: path })
    });
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return serverError(res, e, 'site-analytics', 'Não foi possível carregar as estatísticas agora.');
  }
}
