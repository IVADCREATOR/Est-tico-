// Utilitários da plataforma de bots individuais (/api/v1/bots e /api/v1/worker).
// Arquivo com "_" no início: a Vercel não transforma em rota.
//
// Regras que valem para tudo aqui:
//  * Nunca devolver token, sessão, código de pareamento de outra pessoa,
//    número completo, IP (exceto para admin) ou ID real de grupo.
//  * Toda escrita é validada no servidor; o navegador nunca decide status,
//    preço, validade ou dono de nada.
import crypto from 'node:crypto';
import { supabaseRequest, serviceRoleKey, clientIp } from './_supabase.js';

/* ---------------------------------------------------------------------
 * Banco (PostgREST com service role)
 * ------------------------------------------------------------------- */
const enc = encodeURIComponent;
export { enc };

export async function sel(table, query) {
  return (await supabaseRequest(`/rest/v1/${table}?${query}`)) || [];
}
export async function one(table, query) {
  const rows = await sel(table, `${query}&limit=1`);
  return rows[0] || null;
}
export async function ins(table, rows, { returning = true, onConflict = null, merge = false } = {}) {
  const prefer = [returning ? 'return=representation' : 'return=minimal'];
  if (merge) prefer.push('resolution=merge-duplicates');
  const q = onConflict ? `?on_conflict=${enc(onConflict)}` : '';
  return supabaseRequest(`/rest/v1/${table}${q}`, { method: 'POST', headers: { Prefer: prefer.join(',') }, body: JSON.stringify(rows) });
}
export async function upd(table, filter, patch, { returning = true } = {}) {
  return supabaseRequest(`/rest/v1/${table}?${filter}`, {
    method: 'PATCH', headers: { Prefer: returning ? 'return=representation' : 'return=minimal' }, body: JSON.stringify(patch)
  });
}
export async function del(table, filter) {
  return supabaseRequest(`/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}
export async function rpc(fn, args = {}) {
  return supabaseRequest(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
}

// Tabelas ainda não criadas (migrations não rodadas) → mensagem clara.
export function tabelaAusente(error) {
  const code = String(error?.data?.code || '');
  const msg = String(error?.data?.message || '');
  if (['PGRST205', 'PGRST202', '42P01', '42883'].includes(code)) return true;
  return /relation "?public.bot_|Could not find the (table|function) 'public.(bot_|worker_)/i.test(msg);
}
export function violacaoUnica(error) {
  return String(error?.data?.code || '') === '23505';
}

// Evita recalcular vencimentos a cada requisição na mesma instância da função.
let ultimoRefresh = 0;
export async function refreshAssinaturas(force = false) {
  if (!force && Date.now() - ultimoRefresh < 60_000) return;
  ultimoRefresh = Date.now();
  try { await rpc('bot_refresh_subscriptions'); } catch (e) { ultimoRefresh = 0; throw e; }
}

/* ---------------------------------------------------------------------
 * Configurações da plataforma (site_settings)
 * ------------------------------------------------------------------- */
export const BOT_SETTINGS_DEFAULTS = {
  bot_platform_enabled: false,
  bot_require_approval: true,
  bot_trial_days: 0,
  bot_max_instances_per_user: 1,
  bot_log_retention_days: 15,
  bot_payment_mode: 'whatsapp'
};
export async function lerConfig() {
  const rows = await sel('site_settings', `key=in.(${Object.keys(BOT_SETTINGS_DEFAULTS).join(',')})&select=key,value`);
  const out = { ...BOT_SETTINGS_DEFAULTS };
  for (const r of rows) if (r.key in out) out[r.key] = r.value;
  out.bot_platform_enabled = out.bot_platform_enabled === true;
  out.bot_require_approval = out.bot_require_approval !== false;
  out.bot_trial_days = inteiro(out.bot_trial_days, 0, 30, 0);
  out.bot_max_instances_per_user = inteiro(out.bot_max_instances_per_user, 1, 10, 1);
  out.bot_log_retention_days = inteiro(out.bot_log_retention_days, 3, 90, 15);
  out.bot_payment_mode = ['whatsapp', 'manual_test', 'stripe', 'asaas'].includes(out.bot_payment_mode) ? out.bot_payment_mode : 'whatsapp';
  return out;
}
export function inteiro(v, min, max, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/* ---------------------------------------------------------------------
 * Pagamentos: a hospedagem de bots é contratada diretamente pelo WhatsApp
 * (modo padrão 'whatsapp' — sem gateway automático nenhum, o cliente escolhe
 * o plano e é direcionado pro WhatsApp da equipe pra combinar e ativar).
 * 'manual_test' continua existindo pra testes internos, sem cobrar nada.
 * Stripe/Asaas ficam como possibilidades futuras: a estrutura já prevê
 * esses valores, mas nenhum dos dois está implementado ainda.
 * ------------------------------------------------------------------- */
export function gatewayDisponivel(modo) {
  if (modo === 'manual_test') return { available: true, gateway: 'manual', is_test: true };
  if (modo === 'whatsapp') return { available: true, gateway: 'whatsapp', is_test: false };
  // Stripe / Asaas: ligar só depois de confirmar a conta e as credenciais.
  return { available: false, gateway: modo, is_test: false };
}
export const MSG_PAGAMENTO_TESTE = 'Modo de teste: nenhum valor é cobrado agora. Um administrador confirma o pagamento manualmente enquanto o meio de pagamento definitivo não é ativado.';
// Link do WhatsApp pra contratar um plano diretamente com a equipe.
export function linkWhatsAppPlano(numeroWhatsapp, plano, nomeInstancia) {
  const numero = String(numeroWhatsapp || '').replace(/\D/g, '');
  if (!numero) return null;
  const texto = `Olá! Quero contratar o plano ${plano?.name || ''} do Sorasaki${nomeInstancia ? ` pro bot "${nomeInstancia}"` : ''}.`;
  return `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
}

/* ---------------------------------------------------------------------
 * Números, textos e identificadores
 * ------------------------------------------------------------------- */
// Chave do HMAC: BOT_DATA_PEPPER (recomendado) ou derivada da service role.
function pepper() {
  const p = process.env.BOT_DATA_PEPPER;
  if (p && p.length >= 16) return p;
  return crypto.createHash('sha256').update('sorasaki-bot-pepper:' + serviceRoleKey()).digest('hex');
}
export function hmac(valor) {
  return crypto.createHmac('sha256', pepper()).update(String(valor)).digest('hex');
}

// Aceita qualquer número internacional, de qualquer país e código de área —
// "+55 (11) 99999-0000", "+56 9 4648 4169", "0044 7911 123456" etc. — desde
// que venha com o código do país (com "+" ou começando por "00"). Não existe
// mais nenhuma suposição de país por tamanho de número: antes, um número sem
// "+" com 10 ou 11 dígitos era tratado como Brasil e ganhava um "55" na
// frente, o que corrompia números estrangeiros do mesmo tamanho (ex.: um
// número do Chile virava um número brasileiro errado). Agora, sem o "+"/"00",
// o número é recusado — nada é adivinhado.
export function normalizarTelefone(entrada) {
  const bruto = String(entrada || '').trim();
  const semFormatacao = bruto.replace(/[\s()\-.]/g, '');
  const comCodigoDePais = semFormatacao.startsWith('+') || semFormatacao.startsWith('00');
  if (!comCodigoDePais) return null;
  let d = bruto.replace(/\D/g, '');
  if (semFormatacao.startsWith('00')) d = d.slice(2);
  if (!/^[1-9][0-9]{7,14}$/.test(d)) return null;
  return d;
}
export function mascararTelefone(d) {
  const s = String(d || '').replace(/\D/g, '');
  if (s.length < 8) return null;
  const fim = s.slice(-4);
  if (s.startsWith('55') && (s.length === 12 || s.length === 13)) return `+55 ${s.slice(2, 4)} •••••-${fim}`;
  return `+${s.slice(0, 2)} •••• ${fim}`;
}
// Máscara vinda do worker: só aceita o formato mascarado (nunca número inteiro).
export function mascaraSegura(v) {
  const s = String(v || '').trim();
  if (!s || s.length > 32) return null;
  if (!/^[+0-9 •*.\-()]+$/.test(s)) return null;
  if ((s.match(/[0-9]/g) || []).length > 8) return null;
  if (!/[•*]/.test(s)) return null;
  return s;
}

// Texto livre que vai para o banco/painel: tira controle, esconde números
// longos e qualquer coisa que pareça token ou chave.
export function limparTexto(v, max = 200) {
  let s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[oculto]');
  s = s.replace(/\b(?:sk|pk|rk|wk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{10,}\b/gi, '[oculto]');
  s = s.replace(/[A-Za-z0-9_\-+/=]{32,}/g, '[oculto]');
  s = s.replace(/\d[\d\s.-]{7,}\d/g, (m) => {
    const dig = m.replace(/\D/g, '');
    return dig.length >= 8 ? '•••' + dig.slice(-4) : m;
  });
  return s.slice(0, max);
}
export function nomeValido(v, min = 2, max = 40) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return s.length >= min && s.length <= max ? s : null;
}
export function uuidValido(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : null;
}

/* ---------------------------------------------------------------------
 * Contexto do pedido (país/região, navegador, sistema, aparelho).
 * Só o que a própria requisição informa — nada de rastreamento.
 * ------------------------------------------------------------------- */
export function lerUserAgent(ua) {
  const s = String(ua || '');
  if (!s) return { browser: null, os: null, device: null };
  const browser = /SamsungBrowser/i.test(s) ? 'Samsung Internet'
    : /OPR\/|Opera/i.test(s) ? 'Opera'
    : /Edg\//i.test(s) ? 'Edge'
    : /Firefox\//i.test(s) ? 'Firefox'
    : /Chrome\//i.test(s) ? 'Chrome'
    : /Safari\//i.test(s) ? 'Safari' : null;
  const os = /Android/i.test(s) ? 'Android'
    : /iPhone|iPad|iPod/i.test(s) ? 'iOS'
    : /Windows/i.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/i.test(s) ? 'macOS'
    : /CrOS/i.test(s) ? 'ChromeOS'
    : /Linux/i.test(s) ? 'Linux' : null;
  const device = /iPad|Tablet/i.test(s) ? 'tablet' : /Mobi|Android|iPhone/i.test(s) ? 'celular' : 'computador';
  return { browser, os, device };
}
export function contextoPedido(req) {
  const h = req.headers || {};
  const pais = String(h['x-vercel-ip-country'] || '').slice(0, 2).toUpperCase() || null;
  const regiao = String(h['x-vercel-ip-country-region'] || '').slice(0, 8).toUpperCase() || null;
  const ua = String(h['user-agent'] || '').slice(0, 300);
  return { ip: clientIp(req), context: { country: pais, region: regiao, user_agent: ua || null, ...lerUserAgent(ua) } };
}

/* ---------------------------------------------------------------------
 * Status exibido (o mesmo cálculo para usuário, admin e testes).
 * ------------------------------------------------------------------- */
export const STATUS_LABEL = {
  online: 'Online',
  offline: 'Offline',
  maintenance: 'Em manutenção',
  no_internet: 'Sem internet',
  awaiting_connection: 'Aguardando conexão',
  connecting: 'Conectando',
  restarting: 'Reiniciando',
  suspended: 'Suspenso',
  subscription_expired: 'Assinatura vencida',
  auth_error: 'Erro de autenticação',
  temporary_failure: 'Falha temporária',
  worker_unavailable: 'Worker indisponível',
  blocked: 'Bloqueado',
  revoked: 'Revogado',
  pending_approval: 'Aguardando aprovação',
  pending_payment: 'Aguardando pagamento',
  no_subscription: 'Sem assinatura'
};
const TOM = {
  online: 'ok', connecting: 'info', restarting: 'info', awaiting_connection: 'info', pending_approval: 'info', pending_payment: 'warn',
  offline: 'muted', maintenance: 'warn', no_internet: 'warn', temporary_failure: 'warn', worker_unavailable: 'warn',
  suspended: 'error', subscription_expired: 'error', auth_error: 'error', blocked: 'error', revoked: 'error', no_subscription: 'muted'
};
export const WORKER_TIMEOUT_MS = 120_000;

export function statusExibido(inst, sub, worker, agora = Date.now()) {
  const r = (code, extra = {}) => ({ code, label: STATUS_LABEL[code], tone: TOM[code] || 'muted', ...extra });
  if (!inst) return r('no_subscription');
  if (inst.admin_state === 'revoked') return r('revoked');
  if (inst.admin_state === 'blocked') return r('blocked');
  if (inst.admin_state === 'suspended') return r('suspended');
  if (!inst.is_main) {
    if (!sub || ['expired', 'canceled'].includes(sub.status)) return r(sub ? 'subscription_expired' : 'no_subscription');
    if (sub.status === 'suspended') return r('subscription_expired');
    if (sub.status === 'trialing' && sub.trial_ends_at && new Date(sub.trial_ends_at).getTime() <= agora) return r('subscription_expired');
    if (sub.status === 'pending_payment') return r('pending_payment');
  }
  if (inst.admin_state === 'pending_approval') return r('pending_approval');
  const aviso = sub?.status === 'past_due' ? 'Pagamento pendente: renove para o bot não ser suspenso.' : null;
  if (!inst.worker_id || !worker) {
    if (['awaiting_connection', 'disconnected'].includes(inst.op_status)) return r('awaiting_connection', { warning: aviso });
    return r('worker_unavailable', { warning: aviso });
  }
  if (worker.status === 'disabled') return r('worker_unavailable', { warning: aviso });
  if (worker.status === 'maintenance') return r('maintenance', { warning: aviso });
  const hb = worker.last_heartbeat_at ? new Date(worker.last_heartbeat_at).getTime() : 0;
  if (!hb || agora - hb > WORKER_TIMEOUT_MS) return r('worker_unavailable', { warning: aviso });
  const mapa = { online: 'online', offline: 'offline', stopped: 'offline', connecting: 'connecting', awaiting_connection: 'awaiting_connection',
    disconnected: 'awaiting_connection', maintenance: 'maintenance', no_internet: 'no_internet', restarting: 'restarting',
    auth_error: 'auth_error', temporary_failure: 'temporary_failure' };
  return r(mapa[inst.op_status] || 'offline', { warning: aviso });
}

// A instância pode rodar? (mesma regra de public.bot_instance_entitled)
export function temDireito(inst, sub, agora = Date.now()) {
  if (!inst || inst.admin_state !== 'approved') return false;
  if (inst.is_main) return true;
  if (!sub || !['trialing', 'active', 'past_due'].includes(sub.status)) return false;
  if (sub.status === 'trialing' && !(sub.trial_ends_at && new Date(sub.trial_ends_at).getTime() > agora)) return false;
  return true;
}
// Até quando o worker pode manter o bot rodando se ficar sem falar com o site.
export function validoAte(inst, sub) {
  if (inst?.is_main) return null;
  if (!sub) return new Date(0).toISOString();
  if (sub.status === 'trialing') return sub.trial_ends_at;
  if (!sub.current_period_end) return new Date(0).toISOString();
  return new Date(new Date(sub.current_period_end).getTime() + (sub.grace_days || 0) * 86400000).toISOString();
}

/* ---------------------------------------------------------------------
 * Catálogo de funções por grupo (liga/desliga no painel).
 * "como" explica como o bot aplica — o painel mostra isso ao dono.
 * ------------------------------------------------------------------- */
export const CATALOGO = [
  { key: 'feature:modo_parceria', label: 'Modo parceria', como: 'Liga o sistema de parcerias do grupo.' },
  { key: 'feature:antilink', label: 'Antilink', como: 'Apaga links enviados por quem não é admin.' },
  { key: 'feature:antilink_extremo', label: 'Antilink extremo', como: 'Versão mais rígida do antilink (modo parceria).' },
  { key: 'feature:anti_spam', label: 'Anti-spam', como: 'Limita mensagens repetidas em sequência (antiflood).' },
  { key: 'feature:boas_vindas', label: 'Boas-vindas', como: 'Mensagem para quem entra no grupo.' },
  { key: 'feature:divulgacao_automatica', label: 'Divulgação automática', como: 'Permite que este grupo receba os disparos automáticos.' },
  { key: 'feature:respostas_automaticas', label: 'Respostas automáticas', como: 'Respostas a palavras sem prefixo.' },
  { key: 'category:admin', label: 'Comandos de administração', como: 'Comandos de admin do grupo (ban, fechar grupo...).' },
  { key: 'category:member', label: 'Comandos de membros', como: 'Comandos que qualquer membro pode usar.' },
  { key: 'category:rpg', label: 'Comandos de RPG', como: 'Jogos e RPG.' },
  { key: 'category:vip', label: 'Comandos VIP', como: 'Comandos exclusivos VIP.' }
];
const CHAVES = new Set(CATALOGO.map((c) => c.key));
export function chaveValida(key, comandosConhecidos = null) {
  const k = String(key || '');
  if (CHAVES.has(k)) return k;
  const m = /^cmd:([a-z0-9_-]{2,40})$/.exec(k);
  if (!m) return null;
  if (Array.isArray(comandosConhecidos) && comandosConhecidos.length && !comandosConhecidos.includes(m[1])) return null;
  return k;
}

/* ---------------------------------------------------------------------
 * Visões seguras (o que sai para o navegador)
 * ------------------------------------------------------------------- */
const TIPO_WORKER = { phone: 'Servidor de teste (celular)', vps: 'Servidor (VPS)', pterodactyl: 'Servidor (Pterodactyl)', other: 'Servidor' };
export function localExecucao(worker) {
  if (!worker) return null;
  return [TIPO_WORKER[worker.kind] || 'Servidor', worker.region].filter(Boolean).join(' · ');
}
export function instanciaPublica(inst, sub, worker) {
  if (!inst) return null;
  return {
    id: inst.id,
    name: inst.name,
    admin_state: inst.admin_state,
    status: statusExibido(inst, sub, worker),
    status_reason: inst.status_reason || null,
    phone_masked: inst.phone_masked || null,
    owner_contact_masked: inst.owner_contact_masked || null,
    execution_location: localExecucao(worker),
    last_activity_at: inst.last_activity_at,
    last_connected_at: inst.last_connected_at,
    connected_since: inst.connected_since,
    last_error: inst.last_error_message ? { code: inst.last_error_code, message: inst.last_error_message, at: inst.last_error_at } : null,
    groups_count: inst.groups_count || 0,
    commands_count: Number(inst.commands_count || 0),
    created_at: inst.created_at
  };
}
export function assinaturaPublica(sub, planos = []) {
  if (!sub) return null;
  const plano = planos.find((p) => p.id === sub.plan_id);
  const prox = sub.next_plan_id ? planos.find((p) => p.id === sub.next_plan_id) : null;
  return {
    id: sub.id, status: sub.status, plan: plano ? { code: plano.code, name: plano.name } : null,
    next_plan: prox ? { code: prox.code, name: prox.name } : null,
    price: Number(sub.price), currency: sub.currency, period: sub.period,
    started_at: sub.started_at, current_period_end: sub.current_period_end, trial_ends_at: sub.trial_ends_at,
    grace_days: sub.grace_days, cancel_at_period_end: sub.cancel_at_period_end, canceled_at: sub.canceled_at,
    suspended_at: sub.suspended_at, created_at: sub.created_at
  };
}
export function pagamentoPublico(p) {
  return { id: p.id, kind: p.kind, amount: Number(p.amount), currency: p.currency, status: p.status, is_test: p.is_test,
    gateway: p.gateway, checkout_url: p.checkout_url || null, paid_at: p.paid_at, expires_at: p.expires_at, created_at: p.created_at };
}
export function eventoPublico(e) {
  return { id: e.id, kind: e.kind, event: e.event, severity: e.severity, actor_type: e.actor_type, message: e.message,
    group_id: e.group_id || null, created_at: e.created_at };
}
export function planoPublico(p) {
  return { id: p.id, code: p.code, name: p.name, description: p.description, period: p.period, duration_days: p.duration_days,
    price: Number(p.price), currency: p.currency, trial_days: p.trial_days, features: p.features || [], limits: p.limits || {},
    active: p.active, display_order: p.display_order };
}

/* ---------------------------------------------------------------------
 * Eventos e auditoria
 * ------------------------------------------------------------------- */
export async function evento(row) {
  try {
    await ins('bot_events', [{ ...row, message: row.message ? limparTexto(row.message, 300) : null }], { returning: false });
  } catch (e) {
    console.error('[bots] evento não registrado', e?.status || '', e?.data?.code || '');
  }
}

// Auditoria administrativa na tabela que já existe (admin_activity), com as
// colunas novas. Se o bloco 1 ainda não rodou, grava sem elas.
export async function auditar(req, admin, { action, entity = 'bot_instance', entityId = null, targetUser = null, targetInstance = null, result = 'ok', reason = null, details = {} }) {
  const base = { admin_id: admin.id, action: String(action).slice(0, 80), entity, entity_id: entityId == null ? null : String(entityId), details };
  const extra = { ip: clientIp(req), result, reason: reason ? limparTexto(reason, 300) : null, target_user_id: targetUser, target_instance_id: targetInstance };
  try {
    await ins('admin_activity', [{ ...base, ...extra }], { returning: false });
  } catch {
    try { await ins('admin_activity', [{ ...base, details: { ...details, ...extra } }], { returning: false }); } catch (e) {
      console.error('[bots] auditoria não registrada', e?.status || '');
    }
  }
}

/* ---------------------------------------------------------------------
 * Workers: token = "<uuid do worker>.<segredo>"; guardamos só SHA-256.
 * ------------------------------------------------------------------- */
export function gerarTokenWorker(workerId) {
  const segredo = crypto.randomBytes(32).toString('base64url');
  return { token: `${workerId}.${segredo}`, hash: crypto.createHash('sha256').update(segredo).digest('hex') };
}
export function conferirSegredo(segredo, hashEsperado) {
  const h = crypto.createHash('sha256').update(String(segredo)).digest();
  let esperado;
  try { esperado = Buffer.from(String(hashEsperado), 'hex'); } catch { return false; }
  return esperado.length === h.length && crypto.timingSafeEqual(h, esperado);
}

// Escolhe um worker com vaga (online, aceitando novos, abaixo da capacidade).
export async function escolherWorker(preferido = null) {
  const workers = await sel('worker_nodes', 'status=eq.online&accepts_new=eq.true&select=id,capacity,last_heartbeat_at');
  const vivos = workers.filter((w) => w.last_heartbeat_at && Date.now() - new Date(w.last_heartbeat_at).getTime() < WORKER_TIMEOUT_MS);
  if (!vivos.length) return null;
  const ids = vivos.map((w) => w.id).join(',');
  const ativas = await sel('instance_assignments', `active=eq.true&worker_id=in.(${ids})&select=worker_id`);
  const uso = new Map();
  for (const a of ativas) uso.set(a.worker_id, (uso.get(a.worker_id) || 0) + 1);
  const livres = vivos.filter((w) => (uso.get(w.id) || 0) < w.capacity);
  if (preferido && livres.some((w) => w.id === preferido)) return preferido;
  livres.sort((a, b) => (uso.get(a.id) || 0) / Math.max(1, a.capacity) - (uso.get(b.id) || 0) / Math.max(1, b.capacity));
  return livres[0]?.id || null;
}

export async function atribuirWorker(instanceId, workerId, { by = null, reason = null } = {}) {
  await upd('instance_assignments', `instance_id=eq.${enc(instanceId)}&active=eq.true`, { active: false, unassigned_at: new Date().toISOString() }, { returning: false });
  await ins('instance_assignments', [{ instance_id: instanceId, worker_id: workerId, assigned_by: by, reason }], { returning: false });
  await upd('bot_instances', `id=eq.${enc(instanceId)}`, { worker_id: workerId }, { returning: false });
}

export async function criarTarefa({ workerId, instanceId, type, connectionId = null, by = null, byType = 'system' }) {
  if (!workerId) return null;
  const rows = await ins('bot_worker_jobs', [{ worker_id: workerId, instance_id: instanceId, type, connection_id: connectionId, requested_by: by, requested_by_type: byType }]);
  return rows?.[0] || null;
}

// Pedido de conexão aprovado → procura worker e manda parear.
export async function despacharConexao(conn, inst, { by = null, byType = 'system', workerPreferido = null } = {}) {
  const workerId = await escolherWorker(workerPreferido || inst.worker_id);
  if (!workerId) return { dispatched: false };
  if (workerId !== inst.worker_id) await atribuirWorker(inst.id, workerId, { by, reason: 'Conexão de número' });
  await criarTarefa({ workerId, instanceId: inst.id, type: 'pair', connectionId: conn.id, by, byType });
  await upd('bot_connections', `id=eq.${enc(conn.id)}`, { status: 'dispatched', worker_id: workerId }, { returning: false });
  await upd('bot_instances', `id=eq.${enc(inst.id)}`, { desired_state: 'running', op_status: 'connecting' }, { returning: false });
  return { dispatched: true, workerId };
}
