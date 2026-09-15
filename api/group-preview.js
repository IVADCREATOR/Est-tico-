import crypto from 'node:crypto';
import {
  supabaseRequest, getUserFromAccessToken, bearerToken, readJsonBody, sendJson,
  isActiveAdmin, supabaseUrl, serviceRoleKey, originAllowed, rateLimit, clientIp
} from './_supabase.js';

const MAX_HTML = 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const ALLOWED_HOSTS = [
  'chat.whatsapp.com', 'www.whatsapp.com',
  't.me', 'telegram.me',
  'discord.gg', 'discord.com', 'www.discord.com'
];
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const USER_AGENT = 'SorasakiGroupPreview/1.0 (+https://sorasakiplatform.store)';

// Limite simples por instância para evitar abuso da consulta de convites.
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
// A foto só é baixada dos servidores de imagem das próprias plataformas.
// Isso impede que o servidor seja usado para acessar endereços internos ou
// arbitrários (SSRF) a partir de uma meta tag og:image manipulada.
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, message: 'Ação não disponível.' });
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
        console.warn('group-preview: imagem não salva', error?.message);
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
      // Só grava a imagem quando uma foi encontrada — uma falha na busca não
      // deve apagar a foto que a divulgação já tinha.
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
    console.warn('group-preview error', error?.status || '', error?.message || error);
    const publicMessage = error?.message === 'too_large'
      ? 'Não foi possível ler este convite. Você pode adicionar uma imagem manualmente.'
      : 'Não foi possível consultar este convite agora. Você pode continuar e adicionar uma imagem manualmente.';
    return sendJson(res, 200, { ok: true, found: false, image_status: 'error', message: publicMessage });
  }
}
