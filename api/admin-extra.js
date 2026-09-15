import crypto from 'node:crypto';
import {
  supabaseRequest, requireAdmin, readJsonBody, sendJson, supabaseUrl, serviceRoleKey, serverError,
  originAllowed, rateLimit, getUserFromAccessToken, bearerToken, isActiveAdmin, clientIp
} from './_supabase.js';

// Router: agrupa 3 ações administrativas/de moderação que antes eram
// funções separadas (admin-users, admin-signups, group-preview), só para
// caber no limite de Serverless Functions do plano Hobby da Vercel.
// Cada ação abaixo mantém exatamente as mesmas checagens de
// admin/autenticação/rate-limit que tinha como arquivo próprio.
// Selecionada por ?type= na URL.

// ───────────────────────── usuários (era admin-users.js) ─────────────────────────
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

async function acaoUsers(req, res) {
  if (req.method !== 'GET' && !originAllowed(req)) return sendJson(res, 403, { ok: false, message: 'Ação não permitida.' });
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
    if (!body) return sendJson(res, 400, { ok: false, message: 'Isso que foi enviado não faz sentido pra essa ação. Confira os dados e tente de novo.' });
    const id = String(body.user_id || '').trim();
    const action = String(body.action || '');
    if (!/^[0-9a-f-]{36}$/i.test(id) || !['suspend', 'activate'].includes(action)) return sendJson(res, 400, { ok: false, message: 'Isso que foi enviado não faz sentido pra essa ação. Confira os dados e tente de novo.' });
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
    }).catch((e) => console.warn('admin-extra/users: auditoria não registrada', e?.status || e?.message));
    return sendJson(res, 200, { ok: true });
  }

  res.setHeader('Allow', 'GET, POST');
  return sendJson(res, 405, { ok: false, message: 'Essa ação não funciona desse jeito. Atualize a página e tente de novo.' });
}

// ───────────────────────── cadastros (era admin-signups.js) ─────────────────────────
async function acaoSignups(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, message: 'Essa ação não funciona desse jeito. Atualize a página e tente de novo.' });
  }
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
}

// ───────────────────────── prévia de grupo (era group-preview.js) ─────────────────────────
const MAX_HTML = 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const ALLOWED_HOSTS = [
  'chat.whatsapp.com', 'www.whatsapp.com',
  't.me', 'telegram.me',
  'discord.gg', 'discord.com', 'www.discord.com'
];
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const USER_AGENT = 'SorasakiGroupPreview/1.0 (+https://sorasakiplatform.store)';

const lookupRate = new Map();
function allowLookup(userId) {
  const now = Date.now(), windowMs = 60_000, max = 12;
  const list = (lookupRate.get(userId) || []).filter((ts) => now - ts < windowMs);
  if (list.length >= max) { lookupRate.set(userId, list); return false; }
  list.push(now);
  lookupRate.set(userId, list);
  return true;
}

function hostAllowed(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  return ALLOWED_HOSTS.some((x) => h === x || h.endsWith('.' + x));
}
function normalizeUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (!hostAllowed(u.hostname)) return null;
    return u;
  } catch { return null; }
}
function providerFor(u) {
  const h = u.hostname.toLowerCase();
  if (h === 'chat.whatsapp.com' || h.endsWith('.whatsapp.com')) return 'whatsapp';
  if (h === 't.me' || h.endsWith('.telegram.me') || h === 'telegram.me') return 'telegram';
  if (h === 'discord.gg' || h === 'discord.com' || h === 'www.discord.com') return 'discord';
  return 'unknown';
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
function meta(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["'][^>]*>|<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i');
  const m = html.match(re);
  return decodeEntities(m?.[1] || m?.[2] || '').trim();
}
function firstImageFromJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    try {
      const value = JSON.parse(block[1]);
      const stack = Array.isArray(value) ? value : [value];
      for (const item of stack) {
        const image = item?.image;
        if (typeof image === 'string') return image;
        if (Array.isArray(image) && typeof image[0] === 'string') return image[0];
        if (image?.url) return image.url;
      }
    } catch {}
  }
  return '';
}
async function readLimited(response, limit) {
  const len = Number(response.headers.get('content-length') || 0);
  if (len > limit) throw new Error('too_large');
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try { await reader.cancel(); } catch {}
      throw new Error('too_large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
async function fetchPage(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('page_unavailable');
  const finalUrl = new URL(response.url || url);
  if (!hostAllowed(finalUrl.hostname)) throw new Error('redirect_not_allowed');
  const body = await readLimited(response, MAX_HTML);
  return { html: body.toString('utf8'), finalUrl };
}
const IMAGE_HOST_SUFFIXES = ['whatsapp.net', 'whatsapp.com', 'telegram.org', 'telesco.pe', 't.me', 'cdn-telegram.org', 'discordapp.com', 'discordapp.net', 'discord.com'];
function imageHostAllowed(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h || h === 'localhost' || /^[\d.]+$/.test(h) || h.includes(':')) return false;
  return IMAGE_HOST_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
}
async function fetchImage(imageUrl) {
  const u = new URL(imageUrl);
  if (u.protocol !== 'https:' || !imageHostAllowed(u.hostname)) throw new Error('image_host_not_allowed');
  const response = await fetch(u, {
    redirect: 'follow',
    headers: { 'user-agent': USER_AGENT, accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('image_unavailable');
  if (!imageHostAllowed(new URL(response.url || u).hostname)) throw new Error('image_host_not_allowed');
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new Error('image_type_not_allowed');
  const body = await readLimited(response, MAX_IMAGE);
  if (!body.length) throw new Error('image_empty');
  return { body, contentType };
}
function extension(type) {
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })[type] || 'bin';
}
async function uploadImage(buffer, contentType, ownerId, scope, hash) {
  const path = `${scope}/${ownerId}/${hash}.${extension(contentType)}`;
  const base = supabaseUrl();
  const key = serviceRoleKey();
  const response = await fetch(`${base}/storage/v1/object/group-images/${path}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
      'cache-control': 'public,max-age=31536000,immutable'
    },
    body: buffer
  });
  if (!response.ok) throw new Error('storage_upload_failed');
  const publicUrl = `${base}/storage/v1/object/public/group-images/${path.split('/').map(encodeURIComponent).join('/')}`;
  return { path, publicUrl };
}

async function acaoGroupPreview(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, message: 'Essa ação não funciona desse jeito. Atualize a página e tente de novo.' });
  }
  if (!originAllowed(req)) return sendJson(res, 403, { ok: false, message: 'Ação não permitida.' });
  if (!rateLimit(`preview-ip:${clientIp(req)}`, 30, 60_000)) return sendJson(res, 429, { ok: false, message: 'Muitas tentativas seguidas. Aguarde um pouco e tente novamente.' });

  try {
    const user = await getUserFromAccessToken(bearerToken(req));
    if (!user) return sendJson(res, 401, { ok: false, message: 'Sua sessão expirou. Entre novamente.' });
    if (!allowLookup(user.id)) return sendJson(res, 429, { ok: false, message: 'Muitas tentativas seguidas. Aguarde um pouco e tente novamente.' });
    const body = readJsonBody(req) || {};
    const inviteUrl = normalizeUrl(body.invite_url);
    if (!inviteUrl) return sendJson(res, 200, { ok: true, found: false, image_status: 'not_found', message: 'A foto automática funciona com convites do WhatsApp, Telegram e Discord. Você pode adicionar uma imagem manualmente.' });
    const provider = providerFor(inviteUrl);
    const { html, finalUrl } = await fetchPage(inviteUrl.toString());
    const name = meta(html, 'og:title') || meta(html, 'twitter:title') || '';
    const description = meta(html, 'og:description') || meta(html, 'twitter:description') || '';
    let image = meta(html, 'og:image') || meta(html, 'twitter:image') || firstImageFromJsonLd(html) || '';
    if (image) image = new URL(image, finalUrl).toString();

    let imageUrl = '';
    let imagePath = '';
    let imageHash = '';
    let imageStatus = 'not_found';
    let imageMessage = 'Não encontramos uma foto pública para este grupo. Você pode adicionar uma imagem manualmente.';
    if (image) {
      try {
        const fetched = await fetchImage(image);
        imageHash = crypto.createHash('sha256').update(fetched.body).digest('hex');
        const scope = body.entity === 'official' ? 'official' : 'groups';
        const uploaded = await uploadImage(fetched.body, fetched.contentType, user.id, scope, imageHash);
        imageUrl = uploaded.publicUrl;
        imagePath = uploaded.path;
        imageStatus = 'found';
        imageMessage = 'Foto pública identificada e salva.';
      } catch (error) {
        console.warn('admin-extra/group-preview: imagem não salva', error?.message);
        imageStatus = 'error';
        imageMessage = 'A foto pública não pôde ser salva. Você pode adicionar uma imagem manualmente.';
      }
    }

    const entity = body.entity === 'official' ? 'official' : 'group';
    const id = Number(body.id || 0);
    if (id > 0) {
      const mfaPendente = (user.factors || []).some((f) => f.status === 'verified') && user.aal !== 'aal2';
      const isAdmin = !mfaPendente && (await isActiveAdmin(user.id));
      let allowed = isAdmin;
      if (!allowed && entity === 'group') {
        const owned = await supabaseRequest(`/rest/v1/groups?id=eq.${id}&owner_id=eq.${encodeURIComponent(user.id)}&select=id&limit=1`);
        allowed = Boolean(owned?.length);
      }
      if (!allowed) return sendJson(res, 403, { ok: false, message: 'Você não pode alterar esta divulgação.' });
      if (imageUrl) {
        const table = entity === 'official' ? 'official_groups' : 'groups';
        const patch = entity === 'official'
          ? { image_url: imageUrl, avatar_url: imageUrl, image_source: 'auto', image_status: imageStatus, image_checked_at: new Date().toISOString(), image_hash: imageHash || null }
          : { avatar_url: imageUrl, avatar_source: 'auto', avatar_status: imageStatus, avatar_checked_at: new Date().toISOString(), avatar_hash: imageHash || null, avatar_path: imagePath || null };
        await supabaseRequest(`/rest/v1/${table}?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      }
    }

    return sendJson(res, 200, {
      ok: true, provider, found: Boolean(imageUrl), name: name.slice(0, 100), description: description.slice(0, 800),
      image_url: imageUrl, image_path: imagePath, image_hash: imageHash, image_status: imageStatus, message: imageMessage
    });
  } catch (error) {
    console.warn('admin-extra/group-preview error', error?.status || '', error?.message || error);
    const publicMessage = error?.message === 'too_large'
      ? 'Não foi possível ler este convite. Você pode adicionar uma imagem manualmente.'
      : 'Não foi possível consultar este convite agora. Você pode continuar e adicionar uma imagem manualmente.';
    return sendJson(res, 200, { ok: true, found: false, image_status: 'error', message: publicMessage });
  }
}

// ───────────────────────────────── dispatcher ─────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const type = String(req.query?.type || '');
  try {
    if (type === 'users') return await acaoUsers(req, res);
    if (type === 'signups') return await acaoSignups(req, res);
    if (type === 'group-preview') return await acaoGroupPreview(req, res);
    return sendJson(res, 404, { ok: false, message: 'Não encontramos essa ação.' });
  } catch (error) {
    return serverError(res, error, `admin-extra:${type}`);
  }
}
