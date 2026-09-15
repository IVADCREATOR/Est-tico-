import {
  supabaseRequest, getUserFromAccessToken, bearerToken, readJsonBody, sendJson, serverError,
  originAllowed, rateLimit, clientIp, supabaseUrl, serviceRoleKey
} from './_supabase.js';

// Ações da própria conta que exigem a chave de serviço (nunca exposta ao navegador).
// Hoje: excluir a conta, como prometido nos Termos e na Política de Privacidade.
//
// Travas:
//  - só o dono da sessão exclui a própria conta, digitando "EXCLUIR";
//  - com verificação em duas etapas ativa, a sessão precisa estar confirmada (AAL2);
//  - contas de administrador não se excluem por aqui (evita trancar o painel);
//  - contas com compra paga ficam com o suporte, para preservar o registro fiscal.

async function adminFetch(path, options = {}) {
  const key = serviceRoleKey();
  const r = await fetch(`${supabaseUrl()}${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) { const e = new Error('admin request failed'); e.status = r.status; e.data = await r.text().catch(() => ''); throw e; }
  const text = await r.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

// Apaga as imagens enviadas pela pessoa. Melhor esforço: uma falha aqui não
// impede a exclusão da conta.
async function apagarImagens(userId) {
  for (const prefix of [`${userId}/`, `groups/${userId}/`]) {
    try {
      const itens = await adminFetch('/storage/v1/object/list/group-images', { method: 'POST', body: JSON.stringify({ prefix, limit: 1000 }) });
      const nomes = (itens || []).filter((i) => i?.name && i.id).map((i) => prefix + i.name);
      if (nomes.length) await adminFetch('/storage/v1/object/group-images', { method: 'DELETE', body: JSON.stringify({ prefixes: nomes }) });
    } catch (e) { console.warn('account: imagens não removidas', prefix, e?.status || e?.message); }
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, message: 'Ação não disponível.' });
  }
  if (!originAllowed(req)) return sendJson(res, 403, { ok: false, message: 'Ação não permitida.' });
  if (!rateLimit(`account-ip:${clientIp(req)}`, 10, 60 * 60_000)) return sendJson(res, 429, { ok: false, message: 'Muitas tentativas. Tente novamente mais tarde.' });

  try {
    const user = await getUserFromAccessToken(bearerToken(req));
    if (!user) return sendJson(res, 401, { ok: false, message: 'Você precisa entrar na sua conta para continuar.' });
    if (!rateLimit(`account:${user.id}`, 3, 60 * 60_000)) return sendJson(res, 429, { ok: false, message: 'Muitas tentativas. Tente novamente mais tarde.' });

    const body = readJsonBody(req) || {};
    if (body.action !== 'delete') return sendJson(res, 400, { ok: false, message: 'Ação inválida.' });
    if (String(body.confirm || '').trim().toUpperCase() !== 'EXCLUIR') {
      return sendJson(res, 400, { ok: false, message: 'Digite EXCLUIR para confirmar.' });
    }
    if ((user.factors || []).some((f) => f.status === 'verified') && user.aal !== 'aal2') {
      return sendJson(res, 403, { ok: false, code: 'mfa_required', message: 'Confirme o código da verificação em duas etapas antes de excluir a conta.' });
    }

    const perfil = (await supabaseRequest(`/rest/v1/profiles?user_id=eq.${encodeURIComponent(user.id)}&select=role&limit=1`))?.[0];
    if (perfil?.role === 'admin') {
      return sendJson(res, 403, { ok: false, message: 'Contas da equipe não podem ser excluídas por aqui. Fale com outro administrador.' });
    }
    const pagos = await supabaseRequest(`/rest/v1/orders?user_id=eq.${encodeURIComponent(user.id)}&status=in.(paid,refunded)&select=id&limit=1`);
    if (pagos?.length) {
      return sendJson(res, 409, { ok: false, message: 'Sua conta tem compras registradas. Para excluí-la, fale com o Suporte — precisamos guardar o registro da compra por exigência legal.' });
    }

    await apagarImagens(user.id);
    // Remove o usuário do Supabase Auth. As tabelas ligadas a ele (perfil,
    // divulgações, avaliações, relatos, feedback) são apagadas em cascata.
    await adminFetch(`/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
    await supabaseRequest('/rest/v1/admin_activity', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ admin_id: null, action: 'CONTA_EXCLUIDA_PELO_USUARIO', entity: 'user', entity_id: user.id, details: {} })
    }).catch(() => {});

    return sendJson(res, 200, { ok: true, message: 'Sua conta foi excluída.' });
  } catch (error) {
    return serverError(res, error, 'account', 'Não foi possível excluir a conta agora. Tente novamente ou fale com o Suporte.');
  }
}
