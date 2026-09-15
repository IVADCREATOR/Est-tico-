import { supabaseRequest, requireAdmin, sendJson, serverError } from './_supabase.js';

// Lista os registros de contexto de cadastro (IP, localização, página de
// entrada, data). Só admin ativo acessa — validado no servidor com a
// service role, igual aos outros endpoints administrativos.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, message: 'Ação não disponível.' });
  }
  try {
    const admin = await requireAdmin(req);
    if (!admin) return sendJson(res, 403, { ok: false, message: 'Você não tem permissão para esta ação. Se a verificação em duas etapas estiver ativa, confirme o código no painel.' });

    const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 200);
    const rows = await supabaseRequest(
      `/rest/v1/signup_events?select=user_id,ip,country,region,city,entry_page,referrer,created_at&order=created_at.desc&limit=${limit}`
    );
    const ids = [...new Set((rows || []).map((r) => r.user_id))];
    let perfis = [];
    if (ids.length) {
      perfis = await supabaseRequest(`/rest/v1/profiles?user_id=in.(${ids.join(',')})&select=user_id,username,email`).catch(() => []);
    }
    const byId = Object.fromEntries((perfis || []).map((p) => [p.user_id, p]));
    return sendJson(res, 200, { ok: true, signups: (rows || []).map((r) => ({ ...r, username: byId[r.user_id]?.username || null, email: byId[r.user_id]?.email || null })) });
  } catch (error) {
    return serverError(res, error, 'admin-signups', 'Não foi possível carregar os cadastros agora.');
  }
}
