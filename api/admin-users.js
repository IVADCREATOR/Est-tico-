import { supabaseRequest, requireAdmin, readJsonBody, sendJson, supabaseUrl, serviceRoleKey, serverError, originAllowed, rateLimit } from './_supabase.js';

// Chamadas à API administrativa do Supabase Auth (somente no servidor).
async function adminAuth(path, options = {}) {
  const key = serviceRoleKey();
  const r = await fetch(`${supabaseUrl()}${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) { const e = new Error('admin operation failed'); e.status = r.status; e.data = data; throw e; }
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && !originAllowed(req)) return sendJson(res, 403, { ok: false, message: 'Ação não permitida.' });
  try {
    const admin = await requireAdmin(req);
    if (!admin) return sendJson(res, 401, { ok: false, message: 'Você não tem permissão para esta ação. Se a verificação em duas etapas estiver ativa, confirme o código no painel.' });
    if (!rateLimit(`admin-users:${admin.id}`, 60, 60_000)) return sendJson(res, 429, { ok: false, message: 'Muitas requisições seguidas. Aguarde um instante.' });

    if (req.method === 'GET') {
      const q = String(req.query?.q || '').trim().toLowerCase().slice(0, 120);
      const requestedStatus = String(req.query?.status || 'all');
      const status = ['all', 'active', 'suspended'].includes(requestedStatus) ? requestedStatus : 'all';
      const users = await adminAuth('/auth/v1/admin/users?per_page=1000&page=1');
      const authUsers = users?.users || [];
      const ids = authUsers.map((u) => u.id).filter(Boolean);
      let profiles = [];
      if (ids.length) {
        profiles = await supabaseRequest(`/rest/v1/profiles?user_id=in.(${ids.join(',')})&select=user_id,display_name,username,email,role,account_status,created_at`);
      }
      const byId = Object.fromEntries((profiles || []).map((p) => [p.user_id, p]));
      const list = authUsers
        .map((u) => {
          const p = byId[u.id] || {};
          return {
            id: u.id,
            email: u.email || '',
            created_at: u.created_at,
            last_sign_in_at: u.last_sign_in_at || null,
            confirmed: Boolean(u.email_confirmed_at),
            metadata: u.user_metadata || {},
            profile: { ...p, account_status: p.account_status || 'active' }
          };
        })
        .filter((u) => status === 'all' || u.profile?.account_status === status)
        .filter((u) => !q || `${u.email} ${u.profile?.username || ''} ${u.profile?.display_name || ''} ${u.metadata?.username || ''} ${u.metadata?.display_name || ''} ${u.id}`.toLowerCase().includes(q))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return sendJson(res, 200, { ok: true, users: list });
    }

    if (req.method === 'POST') {
      const body = readJsonBody(req);
      if (!body) return sendJson(res, 400, { ok: false, message: 'Ação inválida.' });
      const id = String(body.user_id || '').trim();
      const action = String(body.action || '');
      if (!/^[0-9a-f-]{36}$/i.test(id) || !['suspend', 'activate'].includes(action)) return sendJson(res, 400, { ok: false, message: 'Ação inválida.' });
      if (id === admin.id) return sendJson(res, 400, { ok: false, message: 'Você não pode alterar o próprio acesso por aqui.' });
      const account_status = action === 'suspend' ? 'suspended' : 'active';
      await supabaseRequest(`/rest/v1/profiles?user_id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ account_status })
      });
      await adminAuth(`/auth/v1/admin/users/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ ban_duration: action === 'suspend' ? '876000h' : 'none' })
      });
      await supabaseRequest('/rest/v1/admin_activity', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ admin_id: admin.id, action: action === 'suspend' ? 'SUSPENDEU' : 'REATIVOU', entity: 'user', entity_id: id, details: { source: 'admin_panel' } })
      }).catch((e) => console.warn('admin-users: auditoria não registrada', e?.status || e?.message));
      return sendJson(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { ok: false, message: 'Ação não disponível.' });
  } catch (err) {
    return serverError(res, err, 'admin-users');
  }
}
