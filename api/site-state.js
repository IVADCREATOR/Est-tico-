import { supabaseRequest, sendJson } from './_supabase.js';

// Estado público do site: manutenção e se novas divulgações estão abertas.
// Nada aqui é sensível — é lido pelo middleware e pelas páginas.
const PUBLIC_KEYS = [
  'maintenance_mode', 'maintenance_title', 'maintenance_message', 'maintenance_image_url',
  'maintenance_return_at', 'maintenance_start_at',
  'community_submissions_enabled', 'max_group_submissions_per_24h'
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const rows = await supabaseRequest(`/rest/v1/site_settings?key=in.(${PUBLIC_KEYS.join(',')})&select=key,value`);
    const settings = Object.fromEntries((rows || []).map((x) => [x.key, x.value]));
    const value = (key, fallback) => (settings[key] !== undefined ? settings[key] : fallback);
    const asBool = (key, fallback = false) => {
      const raw = value(key, fallback);
      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'number') return raw !== 0;
      if (typeof raw === 'string') return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
      return Boolean(raw);
    };
    const asText = (key, fallback = '') => { const raw = value(key, fallback); return raw == null ? fallback : String(raw); };
    const limit = Number(value('max_group_submissions_per_24h', 5));
    return sendJson(res, 200, {
      ok: true,
      maintenance: asBool('maintenance_mode', false),
      title: asText('maintenance_title', 'Estamos em manutenção'),
      message: asText('maintenance_message', 'O site está passando por algumas melhorias no momento. Voltamos em breve.'),
      image_url: asText('maintenance_image_url', ''),
      return_at: value('maintenance_return_at', null),
      start_at: value('maintenance_start_at', null),
      submissions_enabled: asBool('community_submissions_enabled', true),
      max_submissions_24h: Number.isInteger(limit) && limit > 0 ? limit : 5
    });
  } catch (error) {
    console.error('site-state error', error?.status || '', error?.data || error?.message || error);
    // Nunca travar o site por falha ao consultar o estado.
    return sendJson(res, 200, { ok: true, maintenance: false, submissions_enabled: true, max_submissions_24h: 5 });
  }
}
