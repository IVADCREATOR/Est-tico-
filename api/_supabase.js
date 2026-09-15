// Utilitários compartilhados pelas funções da pasta /api.
// Arquivos com "_" no início não viram rota na Vercel.
//
// O projeto usa "type": "module" no package.json, então todas as funções
// precisam ser ES Modules (import/export). Misturar require/module.exports
// aqui derruba a função inteira na hora de carregar (FUNCTION_INVOCATION_FAILED).

import crypto from 'node:crypto';

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export function assertServerConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const error = new Error('server configuration missing');
    error.code = 'CONFIG';
    throw error;
  }
}

export function supabaseUrl() {
  assertServerConfig();
  return SUPABASE_URL;
}

export function serviceRoleKey() {
  assertServerConfig();
  return SUPABASE_SERVICE_ROLE_KEY;
}

export async function supabaseRequest(path, options = {}) {
  assertServerConfig();
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const response = await fetch(`${SUPABASE_URL}${path}`, { ...options, headers, signal: options.signal || AbortSignal.timeout(10000) });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const error = new Error('database request failed');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

// Lê as declarações do JWT *depois* que o Supabase validou o token em
// /auth/v1/user — por isso é seguro confiar no conteúdo aqui.
function claimsOf(accessToken) {
  try { return JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString('utf8')); }
  catch { return {}; }
}

export async function getUserFromAccessToken(accessToken) {
  assertServerConfig();
  if (!accessToken || accessToken.length > 4096) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) return null;
  const user = await response.json();
  if (!user?.id) return null;
  Object.defineProperty(user, 'aal', { value: claimsOf(accessToken).aal || 'aal1', enumerable: false });
  return user;
}

export function bearerToken(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

// A Vercel normalmente já entrega req.body como objeto quando o
// Content-Type é JSON, mas isso não é garantido em todos os casos.
export function readJsonBody(req) {
  const body = req.body;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    try { return JSON.parse(String(body) || '{}'); } catch { return null; }
  }
  return {};
}

// IP do visitante. Na Vercel, x-real-ip é preenchido pela própria plataforma
// (não pelo navegador); x-forwarded-for fica só como reserva.
export function clientIp(req) {
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real.slice(0, 64);
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.socket?.remoteAddress || 'desconhecido').slice(0, 64);
}

// Limite de frequência em memória, por instância da função. Não substitui os
// limites do banco e do Supabase Auth — é uma primeira barreira barata contra
// rajadas de requisições.
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const list = (buckets.get(key) || []).filter((ts) => now - ts < windowMs);
  if (list.length >= max) { buckets.set(key, list); return false; }
  list.push(now);
  buckets.set(key, list);
  if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k);
  return true;
}

// Requisições que alteram dados só são aceitas quando vêm do próprio site
// (ou sem cabeçalho Origin, como chamadas servidor-a-servidor). Complementa
// a autenticação por token: nenhuma rota usa cookies, então não há CSRF
// clássico, mas isso bloqueia formulários e scripts de outros domínios.
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    const allowed = [req.headers.host, 'www.sorasakiplatform.store', 'sorasakiplatform.store'];
    return allowed.includes(host) || /^localhost(:\d+)?$/.test(host);
  } catch { return false; }
}

// Conta administradora ativa, validada no servidor com a service role.
export async function isActiveAdmin(userId) {
  if (!userId) return false;
  const rows = await supabaseRequest(`/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}&select=role,account_status&limit=1`);
  const profile = rows?.[0];
  return profile?.role === 'admin' && (profile?.account_status || 'active') === 'active';
}

// Admin só vale com a sessão em AAL2 quando a conta tem verificação em duas
// etapas ativada — a mesma regra de public.is_admin() no banco.
export async function requireAdmin(req) {
  const user = await getUserFromAccessToken(bearerToken(req));
  if (!user?.id) return null;
  if (!(await isActiveAdmin(user.id))) return null;
  const hasMfa = (user.factors || []).some((f) => f.status === 'verified');
  if (hasMfa && user.aal !== 'aal2') return null;
  return user;
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// Erro inesperado: o detalhe técnico vai só para o log, junto com um código
// curto que o visitante pode informar ao suporte para localizarmos o problema.
export function newErrorId() {
  return 'ERR-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}
export function serverError(res, error, context, message = 'Algo deu errado do nosso lado. Tenta de novo daqui a pouco?') {
  const errorId = newErrorId();
  console.error(`[${context}] ${errorId}`, error?.status || '', error?.code || '', error?.data || error?.message || error);
  return sendJson(res, 500, { ok: false, message, error_id: errorId });
}
