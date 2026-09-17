import { supabaseRequest, sendJson, serverError } from './_supabase.js';

function safeUrl(value) {
  if (!value) return null;
  try {
    const u = new URL(String(value), 'https://sorasakiplatform.store');
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.href;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return sendJson(res, 405, { ok: false, message: 'Essa ação não funciona desse jeito. Atualize a página e tente de novo.' });
    }
    const raw = String(req.query?.type || 'all').toLowerCase();
    const type = ['all', 'products', 'news', 'notices'].includes(raw) ? raw : 'all';
    const out = { ok: true, products: [], news: [], notices: [] };
    const now = encodeURIComponent(new Date().toISOString());
    const jobs = [];
    if (type === 'all' || type === 'products') {
      jobs.push(supabaseRequest('/rest/v1/products?active=eq.true&select=id,name,slug,description,price,previous_price,promo_price,image_url,category,display_order,created_at&order=display_order.asc,created_at.desc&limit=100')
        .then((rows) => { out.products = (rows || []).map((p) => ({ ...p, image_url: safeUrl(p.image_url) })); }));
    }
    if (type === 'all' || type === 'news') {
      jobs.push(supabaseRequest(`/rest/v1/news?status=eq.published&publish_at=lte.${now}&select=id,title,summary,content,category,image_url,publish_at&order=publish_at.desc&limit=30`)
        .then((rows) => { out.news = (rows || []).map((n) => ({ ...n, image_url: safeUrl(n.image_url) })); }));
    }
    if (type === 'all' || type === 'notices') {
      jobs.push(supabaseRequest(`/rest/v1/site_notices?active=eq.true&starts_at=lte.${now}&or=(ends_at.is.null,ends_at.gt.${now})&select=id,title,message,notice_type,highlighted,starts_at,ends_at&order=highlighted.desc,starts_at.desc&limit=10`)
        .then((rows) => { out.notices = rows || []; }));
    }
    await Promise.all(jobs);
    return sendJson(res, 200, out);
  } catch (error) {
    return serverError(res, error, 'public-content', 'Não foi possível carregar o conteúdo agora.');
  }
}
