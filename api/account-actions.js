import crypto from 'node:crypto';
import {
  supabaseRequest, getUserFromAccessToken, bearerToken, readJsonBody, sendJson, serverError,
  originAllowed, rateLimit, clientIp
} from './_supabase.js';
import { supabaseUrl, serviceRoleKey } from './_supabase.js';
import { enviarCodigoSeguranca } from './_mailer.js';

// Router: agrupa 4 ações que antes eram funções separadas (account,
// submit-review, track-signup, site-analytics), só para caber no limite de
// Serverless Functions do plano Hobby da Vercel. Cada ação abaixo mantém
// exatamente as mesmas checagens de origem/rate-limit/autenticação que tinha
// como arquivo próprio — nada na lógica de segurança mudou, só o arquivo.
// Selecionada por ?type= na URL (ver app.js/js/*.js para quem chama).

// ───────────────────────── excluir conta (era account.js) ─────────────────────────
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

async function apagarImagens(userId) {
  for (const prefix of [`${userId}/`, `groups/${userId}/`]) {
    try {
      const itens = await adminFetch('/storage/v1/object/list/group-images', { method: 'POST', body: JSON.stringify({ prefix, limit: 1000 }) });
      const nomes = (itens || []).filter((i) => i?.name && i.id).map((i) => prefix + i.name);
      if (nomes.length) await adminFetch('/storage/v1/object/group-images', { method: 'DELETE', body: JSON.stringify({ prefixes: nomes }) });
    } catch (e) { console.warn('account-actions/delete-account: imagens não removidas', prefix, e?.status || e?.message); }
  }
}

async function acaoExcluirConta(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, message: 'Essa ação não funciona desse jeito. Atualize a página e tente de novo.' });
  }
  if (!originAllowed(req)) return sendJson(res, 403, { ok: false, message: 'Ação não permitida.' });
  if (!rateLimit(`account-ip:${clientIp(req)}`, 10, 60 * 60_000)) return sendJson(res, 429, { ok: false, message: 'Muitas tentativas. Tente novamente mais tarde.' });

  const user = await getUserFromAccessToken(bearerToken(req));
  if (!user) return sendJson(res, 401, { ok: false, message: 'Você precisa entrar na sua conta para continuar.' });
  if (!rateLimit(`account:${user.id}`, 3, 60 * 60_000)) return sendJson(res, 429, { ok: false, message: 'Muitas tentativas. Tente novamente mais tarde.' });

  const body = readJsonBody(req) || {};
  if (body.action !== 'delete') return sendJson(res, 400, { ok: false, message: 'Isso que foi enviado não faz sentido pra essa ação. Confira os dados e tente de novo.' });
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
  await adminFetch(`/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
  await supabaseRequest('/rest/v1/admin_activity', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ admin_id: null, action: 'CONTA_EXCLUIDA_PELO_USUARIO', entity: 'user', entity_id: user.id, details: {} })
  }).catch(() => {});

  return sendJson(res, 200, { ok: true, message: 'Sua conta foi excluída.' });
}

// ───────────────────────── avaliação (era submit-review.js) ─────────────────────────
function ipOuNulo(req) {
  const ip = clientIp(req);
  return /^[0-9a-f:.]{3,45}$/i.test(ip) ? ip : null;
}

async function acaoReview(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, message: 'Essa ação não funciona desse jeito. Atualize a página e tente de novo.' });
  }
  if (!originAllowed(req)) return sendJson(res, 403, { ok: false, message: 'Ação não permitida.' });
  if (!rateLimit(`review-ip:${clientIp(req)}`, 20, 60_000)) return sendJson(res, 429, { ok: false, message: 'Muitas tentativas em pouco tempo. Aguarde um instante.' });

  const user = await getUserFromAccessToken(bearerToken(req));
  if (!user) return sendJson(res, 401, { ok: false, message: 'Você precisa entrar na sua conta para avaliar.' });
  if (!rateLimit(`review:${user.id}`, 5, 60_000)) return sendJson(res, 429, { ok: false, message: 'Muitas tentativas em pouco tempo. Aguarde um instante.' });

  const body = readJsonBody(req) || {};
  const groupId = Number(body.group_id || 0);
  const rating = Number(body.rating || 0);
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 600) : null;
  if (!Number.isInteger(groupId) || groupId <= 0 || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return sendJson(res, 400, { ok: false, message: 'Escolha uma nota de 1 a 5.' });
  }

  const group = await supabaseRequest(`/rest/v1/groups?id=eq.${groupId}&status=eq.approved&select=id,owner_id&limit=1`);
  if (!group?.length) {
    return sendJson(res, 404, { ok: false, message: 'Este grupo não está disponível para avaliação no momento.' });
  }
  if (group[0].owner_id === user.id) {
    return sendJson(res, 400, { ok: false, message: 'Você não pode avaliar a sua própria divulgação.' });
  }

  try {
    await supabaseRequest('/rest/v1/reviews', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        group_id: groupId,
        user_id: user.id,
        rating,
        comment: comment || null,
        status: 'pending',
        email: user.email || null,
        ip: ipOuNulo(req),
        user_agent: String(req.headers['user-agent'] || '').slice(0, 300)
      })
    });
  } catch (error) {
    if (error?.status === 409 || error?.data?.code === '23505') {
      return sendJson(res, 409, { ok: false, message: 'Você já avaliou este grupo.' });
    }
    throw error;
  }

  return sendJson(res, 200, { ok: true, message: 'Avaliação enviada! Ela aparece publicamente depois de uma checagem rápida da equipe.' });
}

// ───────────────────────── contexto de cadastro (era track-signup.js) ─────────────────────────
function cortar(valor, max) {
  if (!valor) return null;
  return String(valor).replace(/[\u0000-\u001f]/g, '').slice(0, max);
}
function urlOuCaminho(valor) {
  const v = cortar(valor, 300);
  if (!v) return null;
  if (v.startsWith('/')) return v;
  try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? u.href.slice(0, 300) : null; } catch { return null; }
}

async function acaoTrackSignup(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, message: 'Essa ação não funciona desse jeito. Atualize a página e tente de novo.' });
  }
  if (!originAllowed(req)) return sendJson(res, 403, { ok: false });

  try {
    const user = await getUserFromAccessToken(bearerToken(req));
    if (!user?.id) return sendJson(res, 401, { ok: false, message: 'Sessão inválida.' });
    if (!rateLimit(`track:${user.id}`, 5, 60_000)) return sendJson(res, 200, { ok: true });

    const body = readJsonBody(req) || {};
    const cidadeBruta = req.headers['x-vercel-ip-city'];
    let cidade = null;
    try { cidade = cidadeBruta ? decodeURIComponent(cidadeBruta) : null; } catch { cidade = null; }
    const row = {
      user_id: user.id,
      ip: clientIp(req),
      country: cortar(req.headers['x-vercel-ip-country'], 8),
      region: cortar(req.headers['x-vercel-ip-country-region'], 16),
      city: cortar(cidade, 80),
      entry_page: urlOuCaminho(body.entry_page),
      referrer: urlOuCaminho(body.referrer)
    };

    await supabaseRequest('/rest/v1/signup_events?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify([row])
    });

    return sendJson(res, 200, { ok: true });
  } catch (error) {
    console.error('account-actions/track-signup error', error?.status || '', error?.data || error?.message || error);
    return sendJson(res, 200, { ok: true });
  }
}

// ───────────────────────── analytics do site (era site-analytics.js) ─────────────────────────
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

async function acaoSiteAnalytics(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, await readAnalytics());
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { ok: false, message: 'Essa ação não funciona desse jeito. Atualize a página e tente de novo.' });
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
}

// ───────────────────────── código de segurança por e-mail (2FA próprio) ─────────────────────────
// Sem depender do Supabase Auth nem de Resend/SendGrid pra este e-mail
// específico — vai direto por SMTP (ver api/_mailer.js). Código de 6 dígitos,
// aleatório de verdade (crypto, não Math.random), guardado só como hash
// (sha256), uso único, expira em 10 minutos, com limite de tentativas e
// cooldown entre reenvios.
const CODE_TTL_MIN = 10;
const CODE_MAX_ATTEMPTS = 5;
const PURPOSES = new Set(['enroll', 'login', 'disable', 'signup']);

function hashCodigo(codigo, userId) {
  // userId entra no hash como sal — dois usuários com o mesmo código de 6
  // dígitos nunca produzem o mesmo hash guardado no banco.
  return crypto.createHash('sha256').update(`${userId}:${codigo}`).digest('hex');
}
function gerarCodigo() {
  // 000000–999999, sorteio criptográfico (não Math.random).
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

async function acaoEmail2faSolicitar(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, message: 'Essa ação não funciona desse jeito. Atualize a página e tente de novo.' });
  }
  if (!originAllowed(req)) return sendJson(res, 403, { ok: false, message: 'Essa ação não é permitida vindo daqui.' });

  const user = await getUserFromAccessToken(bearerToken(req));
  if (!user) return sendJson(res, 401, { ok: false, message: 'Sua sessão expirou. Entre de novo.' });

  const body = readJsonBody(req) || {};
  const purpose = PURPOSES.has(body.purpose) ? body.purpose : 'enroll';

  // Cooldown de 60s entre pedidos e um teto de 5 por hora — dá pra reenviar
  // se a pessoa não recebeu, mas não dá pra usar isso como spam.
  if (!rateLimit(`email2fa-cd:${user.id}`, 1, 60_000)) {
    return sendJson(res, 429, { ok: false, message: 'Espera um minuto antes de pedir outro código.' });
  }
  if (!rateLimit(`email2fa-h:${user.id}`, 5, 60 * 60_000)) {
    return sendJson(res, 429, { ok: false, message: 'Muitos pedidos de código em pouco tempo. Tenta de novo daqui a pouco.' });
  }

  // Login e cadastro sempre exigem o código — não são mais opcionais.
  // "enroll"/"disable" continuam sendo a configuração extra opcional que já
  // existia (mantida intacta, mesmo sem botão visível na interface).
  // Só "signup" pode pedir o código com o e-mail ainda não confirmado —
  // é exatamente esse código que vai confirmar o e-mail.
  if (purpose !== 'signup' && !user.email_confirmed_at) {
    return sendJson(res, 400, { ok: false, message: 'Confirme seu e-mail antes de configurar isso.' });
  }
  if (purpose === 'disable') {
    const perfil = (await supabaseRequest(`/rest/v1/profiles?user_id=eq.${encodeURIComponent(user.id)}&select=email_mfa_enabled&limit=1`))?.[0];
    if (!perfil?.email_mfa_enabled) return sendJson(res, 400, { ok: false, message: 'Isso ainda não está ativado na sua conta.' });
  }

  const codigo = gerarCodigo();
  const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString();

  // Qualquer código anterior não usado desse mesmo propósito vira inválido —
  // só o mais recente funciona.
  await supabaseRequest(`/rest/v1/security_email_codes?user_id=eq.${user.id}&purpose=eq.${purpose}&consumed_at=is.null`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ consumed_at: new Date().toISOString() })
  }).catch(() => {});

  await supabaseRequest('/rest/v1/security_email_codes', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      user_id: user.id,
      purpose,
      code_hash: hashCodigo(codigo, user.id),
      attempts: 0,
      max_attempts: CODE_MAX_ATTEMPTS,
      expires_at: expiresAt,
      ip: clientIp(req)
    })
  });

  try {
    const perfilNome = (await supabaseRequest(`/rest/v1/profiles?user_id=eq.${encodeURIComponent(user.id)}&select=display_name,username&limit=1`))?.[0];
    await enviarCodigoSeguranca({
      to: user.email,
      nomeUsuario: perfilNome?.display_name || perfilNome?.username || null,
      codigo,
      minutosValidade: CODE_TTL_MIN,
      purpose
    });
  } catch (error) {
    console.error('account-actions/email-2fa-request: falha ao enviar e-mail', error?.message || error);
    return sendJson(res, 502, { ok: false, message: 'Não conseguimos enviar o e-mail agora. Tenta de novo em instantes.' });
  }

  // Nunca logar o código em si.
  return sendJson(res, 200, { ok: true, message: `Enviamos um código pro seu e-mail. Ele vale por ${CODE_TTL_MIN} minutos.` });
}

async function acaoEmail2faVerificar(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, message: 'Essa ação não funciona desse jeito. Atualize a página e tente de novo.' });
  }
  if (!originAllowed(req)) return sendJson(res, 403, { ok: false, message: 'Essa ação não é permitida vindo daqui.' });

  const user = await getUserFromAccessToken(bearerToken(req));
  if (!user) return sendJson(res, 401, { ok: false, message: 'Sua sessão expirou. Entre de novo.' });
  if (!rateLimit(`email2fa-verify:${user.id}`, 10, 60_000)) {
    return sendJson(res, 429, { ok: false, message: 'Muitas tentativas seguidas. Espera um pouco.' });
  }

  const body = readJsonBody(req) || {};
  const codigo = String(body.code || '').replace(/\D/g, '');
  if (codigo.length !== 6) return sendJson(res, 400, { ok: false, message: 'Digite os 6 números do código.' });

  const linhas = await supabaseRequest(
    `/rest/v1/security_email_codes?user_id=eq.${user.id}&consumed_at=is.null&order=created_at.desc&limit=1&select=id,code_hash,attempts,max_attempts,expires_at,purpose`
  );
  const linha = linhas?.[0];
  if (!linha) return sendJson(res, 400, { ok: false, message: 'Esse código expirou ou não existe. Peça um novo.' });
  if (new Date(linha.expires_at).getTime() < Date.now()) {
    await supabaseRequest(`/rest/v1/security_email_codes?id=eq.${linha.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ consumed_at: new Date().toISOString() }) });
    return sendJson(res, 400, { ok: false, message: 'Esse código expirou. Peça um novo.' });
  }
  if (linha.attempts >= linha.max_attempts) {
    return sendJson(res, 400, { ok: false, message: 'Esse código não vale mais depois de tantas tentativas erradas. Peça um novo.' });
  }

  if (hashCodigo(codigo, user.id) !== linha.code_hash) {
    await supabaseRequest(`/rest/v1/security_email_codes?id=eq.${linha.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ attempts: linha.attempts + 1 }) });
    return sendJson(res, 400, { ok: false, message: 'Código incorreto. Confira e tente de novo.' });
  }

  await supabaseRequest(`/rest/v1/security_email_codes?id=eq.${linha.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ consumed_at: new Date().toISOString() }) });

  if (linha.purpose === 'enroll') {
    await supabaseRequest(`/rest/v1/profiles?user_id=eq.${encodeURIComponent(user.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ email_mfa_enabled: true }) });
  } else if (linha.purpose === 'disable') {
    await supabaseRequest(`/rest/v1/profiles?user_id=eq.${encodeURIComponent(user.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ email_mfa_enabled: false }) });
  } else if (linha.purpose === 'signup') {
    // Marca o e-mail como confirmado de verdade (no Supabase Auth e no
    // espelho em profiles) — só depois de validar o NOSSO código, nunca
    // por causa do link nativo do Supabase (que está desligado).
    await adminFetch(`/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { method: 'PUT', body: JSON.stringify({ email_confirm: true }) });
    await supabaseRequest(`/rest/v1/profiles?user_id=eq.${encodeURIComponent(user.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ email_confirmed: true }) }).catch(() => {});
  }

  await supabaseRequest('/rest/v1/admin_activity', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ admin_id: null, action: `EMAIL_2FA_${linha.purpose.toUpperCase()}`, entity: 'user', entity_id: user.id, details: {} })
  }).catch(() => {});

  const MENSAGENS = {
    enroll: 'Código de segurança por e-mail ativado.',
    disable: 'Código de segurança por e-mail desativado.',
    signup: 'E-mail confirmado! Seu cadastro está completo.',
    login: 'Verificado.'
  };
  return sendJson(res, 200, { ok: true, purpose: linha.purpose, message: MENSAGENS[linha.purpose] || 'Verificado.' });
}


// ───────────────────────── redefinir senha por código (sem sessão) ─────────────────────────
// Diferente do fluxo acima: aqui a pessoa ainda NÃO está logada (esqueceu a
// senha), então não existe access token pra usar. A identificação é só pelo
// e-mail, e por isso a resposta de "solicitar" é sempre genérica — nunca diz
// se aquele e-mail tem conta ou não, pra não vazar essa informação pra quem
// estiver tentando descobrir e-mails cadastrados.
function validEmailFormat(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
}

async function acharUserIdPorEmail(email) {
  const linhas = await supabaseRequest(`/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=user_id&limit=1`);
  return linhas?.[0]?.user_id || null;
}

async function acaoPasswordResetSolicitar(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, message: 'Essa ação não funciona desse jeito. Atualize a página e tente de novo.' });
  }
  if (!originAllowed(req)) return sendJson(res, 403, { ok: false, message: 'Ação não permitida.' });
  if (!rateLimit(`pwreset-ip:${clientIp(req)}`, 10, 60 * 60_000)) return sendJson(res, 429, { ok: false, message: 'Muitas tentativas. Tente novamente mais tarde.' });

  const body = readJsonBody(req) || {};
  const email = String(body.email || '').trim().toLowerCase();
  const RESPOSTA_GENERICA = { ok: true, message: 'Se esse e-mail tiver uma conta no Sorasaki, enviamos um código pra ele.' };
  if (!validEmailFormat(email)) return sendJson(res, 200, RESPOSTA_GENERICA);
  if (!rateLimit(`pwreset-email:${email}`, 3, 60 * 60_000)) return sendJson(res, 200, RESPOSTA_GENERICA);

  try {
    const userId = await acharUserIdPorEmail(email);
    if (userId) {
      const codigo = gerarCodigo();
      const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString();
      await supabaseRequest(`/rest/v1/security_email_codes?user_id=eq.${userId}&purpose=eq.password-reset&consumed_at=is.null`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ consumed_at: new Date().toISOString() })
      }).catch(() => {});
      await supabaseRequest('/rest/v1/security_email_codes', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ user_id: userId, purpose: 'password-reset', code_hash: hashCodigo(codigo, userId), attempts: 0, max_attempts: CODE_MAX_ATTEMPTS, expires_at: expiresAt, ip: clientIp(req) })
      });
      const perfilNome = (await supabaseRequest(`/rest/v1/profiles?user_id=eq.${userId}&select=display_name,username&limit=1`))?.[0];
      await enviarCodigoSeguranca({ to: email, nomeUsuario: perfilNome?.display_name || perfilNome?.username || null, codigo, minutosValidade: CODE_TTL_MIN, purpose: 'password-reset' });
    }
  } catch (error) {
    // Mesmo se der erro, a resposta continua genérica — o erro só vai pro log.
    console.error('account-actions/password-reset-request', error?.status || '', error?.data || error?.message || error);
  }

  return sendJson(res, 200, RESPOSTA_GENERICA);
}

async function acaoPasswordResetConfirmar(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, message: 'Essa ação não funciona desse jeito. Atualize a página e tente de novo.' });
  }
  if (!originAllowed(req)) return sendJson(res, 403, { ok: false, message: 'Ação não permitida.' });
  if (!rateLimit(`pwreset-confirm-ip:${clientIp(req)}`, 20, 60_000)) return sendJson(res, 429, { ok: false, message: 'Muitas tentativas seguidas. Espera um pouco.' });

  const body = readJsonBody(req) || {};
  const email = String(body.email || '').trim().toLowerCase();
  const codigo = String(body.code || '').replace(/\D/g, '');
  const novaSenha = String(body.newPassword || '');
  const MSG_INVALIDO = { ok: false, message: 'Código inválido ou expirado. Peça um novo.' };
  if (!validEmailFormat(email) || codigo.length !== 6) return sendJson(res, 400, MSG_INVALIDO);
  if (novaSenha.length < 8) return sendJson(res, 400, { ok: false, message: 'A senha precisa ter pelo menos 8 caracteres.' });
  if (!rateLimit(`pwreset-confirm-email:${email}`, 10, 60_000)) return sendJson(res, 429, { ok: false, message: 'Muitas tentativas seguidas. Espera um pouco.' });

  const userId = await acharUserIdPorEmail(email);
  if (!userId) return sendJson(res, 400, MSG_INVALIDO);

  const linhas = await supabaseRequest(
    `/rest/v1/security_email_codes?user_id=eq.${userId}&purpose=eq.password-reset&consumed_at=is.null&order=created_at.desc&limit=1&select=id,code_hash,attempts,max_attempts,expires_at`
  );
  const linha = linhas?.[0];
  if (!linha) return sendJson(res, 400, MSG_INVALIDO);
  if (new Date(linha.expires_at).getTime() < Date.now()) {
    await supabaseRequest(`/rest/v1/security_email_codes?id=eq.${linha.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ consumed_at: new Date().toISOString() }) });
    return sendJson(res, 400, { ok: false, message: 'Esse código expirou. Peça um novo.' });
  }
  if (linha.attempts >= linha.max_attempts) {
    return sendJson(res, 400, { ok: false, message: 'Esse código não vale mais depois de tantas tentativas erradas. Peça um novo.' });
  }
  if (hashCodigo(codigo, userId) !== linha.code_hash) {
    await supabaseRequest(`/rest/v1/security_email_codes?id=eq.${linha.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ attempts: linha.attempts + 1 }) });
    return sendJson(res, 400, { ok: false, message: 'Código incorreto. Confira e tente de novo.' });
  }

  await supabaseRequest(`/rest/v1/security_email_codes?id=eq.${linha.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ consumed_at: new Date().toISOString() }) });
  await adminFetch(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'PUT', body: JSON.stringify({ password: novaSenha }) });
  await supabaseRequest('/rest/v1/admin_activity', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ admin_id: null, action: 'SENHA_REDEFINIDA_POR_CODIGO', entity: 'user', entity_id: userId, details: {} })
  }).catch(() => {});

  return sendJson(res, 200, { ok: true, message: 'Senha redefinida! Já pode entrar com a nova senha.' });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const type = String(req.query?.type || '');
  try {
    if (type === 'delete-account') return await acaoExcluirConta(req, res);
    if (type === 'review') return await acaoReview(req, res);
    if (type === 'track-signup') return await acaoTrackSignup(req, res);
    if (type === 'site-analytics') return await acaoSiteAnalytics(req, res);
    if (type === 'email-2fa-request') return await acaoEmail2faSolicitar(req, res);
    if (type === 'email-2fa-verify') return await acaoEmail2faVerificar(req, res);
    if (type === 'password-reset-request') return await acaoPasswordResetSolicitar(req, res);
    if (type === 'password-reset-confirm') return await acaoPasswordResetConfirmar(req, res);
    return sendJson(res, 404, { ok: false, message: 'Não achei essa ação por aqui.' });
  } catch (error) {
    return serverError(res, error, `account-actions:${type}`, 'Não foi possível concluir essa ação agora. Tente novamente em instantes.');
  }
}
