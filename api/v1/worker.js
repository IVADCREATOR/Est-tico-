// /api/v1/worker — canal entre os workers (celular, VPS, Pterodactyl) e o painel.
// Autenticação: "Authorization: Bearer <id do worker>.<segredo>". Guardamos
// só o SHA-256 do segredo. Cada worker só enxerga as instâncias atribuídas a ele.
//
//   POST heartbeat     estado do worker e das instâncias → recebe ordens (tarefas) e regras
//   POST job-result    resultado de uma tarefa (ex.: código de pareamento gerado)
//   POST groups-sync   grupos em que o bot está → recebe a configuração desejada por grupo
//   POST settings-ack  confirma quais configurações o bot aplicou
//   POST logs          resumo de avisos/erros (já filtrados no worker; filtrados de novo aqui)
//   POST event         eventos operacionais (queda, reinício, disco cheio, limpeza...)
//
// Sessões, credenciais e QR nunca passam por aqui: ficam só no worker.
import { supabaseRequest, bearerToken, readJsonBody, sendJson, serverError, rateLimit, clientIp } from '../_supabase.js';
import {
  enc, sel, one, ins, upd, rpc, tabelaAusente, refreshAssinaturas, lerConfig, hmac, mascararTelefone, mascaraSegura,
  limparTexto, uuidValido, statusExibido, temDireito, validoAte, evento, despacharConexao, conferirSegredo, CATALOGO
} from '../_bots.js';

class Erro extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const OP_STATUS = new Set(['awaiting_connection', 'connecting', 'online', 'offline', 'maintenance', 'no_internet', 'restarting', 'auth_error', 'temporary_failure', 'disconnected', 'stopped']);
const EVENTOS_WORKER = {
  crash: { sev: 'error', vis: 'owner', msg: 'O bot parou inesperadamente e está sendo reiniciado.' },
  restarted: { sev: 'info', vis: 'owner', msg: 'Bot reiniciado.' },
  crash_loop: { sev: 'error', vis: 'owner', msg: 'O bot caiu várias vezes seguidas. Reinícios automáticos pausados por alguns minutos.' },
  conflict: { sev: 'warning', vis: 'owner', msg: 'O WhatsApp informou outra sessão ativa para este número.' },
  no_internet: { sev: 'warning', vis: 'owner', msg: 'O servidor ficou sem internet.' },
  subscription_stop: { sev: 'warning', vis: 'owner', msg: 'Bot parado: assinatura sem validade.' },
  low_disk: { sev: 'warning', vis: 'admin', msg: 'Pouco espaço em disco no worker.' },
  low_memory: { sev: 'warning', vis: 'admin', msg: 'Pouca memória livre no worker.' },
  high_temp: { sev: 'warning', vis: 'admin', msg: 'Temperatura alta no aparelho do worker.' },
  cleanup_report: { sev: 'info', vis: 'admin', msg: 'Limpeza automática concluída.' },
  backup_done: { sev: 'info', vis: 'admin', msg: 'Backup concluído.' },
  backup_failed: { sev: 'warning', vis: 'admin', msg: 'Falha no backup.' },
  duplicate_blocked: { sev: 'warning', vis: 'admin', msg: 'Tentativa de iniciar a mesma instância duas vezes foi bloqueada.' },
  worker_started: { sev: 'info', vis: 'admin', msg: 'Worker iniciado.' },
  worker_stopping: { sev: 'info', vis: 'admin', msg: 'Worker encerrando.' }
};
const CHAVES_ATUAIS = new Set(CATALOGO.map((c) => c.key));
const agoraIso = () => new Date().toISOString();

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const type = String(req.query?.type || '');
  try {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new Erro(405, 'Método não permitido.'); }
    const worker = await autenticar(req);
    const body = readJsonBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Erro(400, 'Corpo inválido.');
    const rotas = { heartbeat, 'job-result': resultadoTarefa, 'groups-sync': sincronizarGrupos, 'settings-ack': confirmarConfig,
      'broadcast-sync': sincronizarBroadcast, 'broadcast-ack': confirmarBroadcast, logs: receberLogs, event: receberEvento };
    const fn = rotas[type];
    if (!fn) throw new Erro(404, 'Ação desconhecida.');
    return sendJson(res, 200, { ok: true, ...(await fn(req, worker, body)) });
  } catch (error) {
    if (error instanceof Erro) return sendJson(res, error.status, { ok: false, message: error.message });
    if (tabelaAusente(error)) return sendJson(res, 503, { ok: false, message: 'Plataforma de bots não instalada no banco.' });
    return serverError(res, error, `v1-worker:${type}`, 'Falha ao processar.');
  }
}

async function autenticar(req) {
  const ip = clientIp(req);
  if (!rateLimit(`worker-ip:${ip}`, 300, 60_000)) throw new Erro(429, 'Muitas requisições.');
  const token = bearerToken(req);
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{40,60})$/.exec(token);
  if (!m || !uuidValido(m[1])) throw new Erro(401, 'Token inválido.');
  const cred = await one('worker_credentials', `worker_id=eq.${m[1]}&select=token_hash`);
  if (!cred || !conferirSegredo(m[2], cred.token_hash)) {
    if (!rateLimit(`worker-bad:${ip}`, 10, 10 * 60_000)) throw new Erro(429, 'Muitas tentativas.');
    throw new Erro(401, 'Token inválido.');
  }
  const worker = await one('worker_nodes', `id=eq.${m[1]}&select=id,name,kind,region,status,capacity,accepts_new`);
  if (!worker) throw new Erro(401, 'Token inválido.');
  if (worker.status === 'disabled') throw new Erro(403, 'Este worker foi desativado no painel.');
  if (!rateLimit(`worker:${worker.id}`, 240, 60_000)) throw new Erro(429, 'Muitas requisições.');
  return worker;
}

async function instanciaDoWorker(worker, id) {
  const uid = uuidValido(id);
  if (!uid) throw new Erro(400, 'Instância inválida.');
  const inst = await one('bot_instances', `id=eq.${uid}&worker_id=eq.${worker.id}&select=*`);
  if (!inst) throw new Erro(403, 'Esta instância não está atribuída a este worker.');
  return inst;
}

/* ---------- números seguros ---------- */
const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 10) / 10 : null; };
function limparMetricas(m = {}) {
  const out = {
    disk_free_mb: num(m.disk_free_mb, 0, 1e8), disk_total_mb: num(m.disk_total_mb, 0, 1e8),
    mem_free_mb: num(m.mem_free_mb, 0, 1e7), mem_total_mb: num(m.mem_total_mb, 0, 1e7),
    load1: num(m.load1, 0, 1000), temp_c: num(m.temp_c, -40, 150), battery_pct: num(m.battery_pct, 0, 100),
    charging: typeof m.charging === 'boolean' ? m.charging : null, uptime_s: num(m.uptime_s, 0, 1e9),
    instances_running: num(m.instances_running, 0, 1000),
    platform: m.platform ? limparTexto(m.platform, 40) : null, node: m.node ? limparTexto(m.node, 20) : null,
    network: ['wifi', 'mobile', 'ethernet', 'unknown'].includes(m.network) ? m.network : null
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null));
}
function dataValida(v) {
  const d = new Date(v);
  const t = d.getTime();
  return Number.isNaN(t) || t > Date.now() + 120_000 || t < Date.now() - 400 * 86400000 ? null : d.toISOString();
}
function formatarCodigo(c) {
  const s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
}

/* ===================================================================== */
async function heartbeat(req, worker, body) {
  const statusWorker = worker.status === 'maintenance' ? 'maintenance' : 'online';
  await upd('worker_nodes', `id=eq.${worker.id}`, {
    status: statusWorker, metrics: limparMetricas(body.metrics || {}), last_heartbeat_at: agoraIso(),
    agent_version: body.agent_version ? limparTexto(body.agent_version, 40) : null, last_ip: clientIp(req)
  }, { returning: false });

  let insts = await sel('bot_instances', `worker_id=eq.${worker.id}&select=*`);
  const meus = new Map(insts.map((i) => [i.id, i]));
  const relatos = Array.isArray(body.instances) ? body.instances.slice(0, 200) : [];
  const orfas = [];
  for (const r of relatos) {
    const id = uuidValido(r?.id);
    if (!id) continue;
    const inst = meus.get(id);
    if (!inst) { orfas.push(id); continue; }
    await aplicarRelato(inst, r);
  }

  try { await refreshAssinaturas(); } catch (e) { console.error('[worker] refresh', e?.status || ''); }

  // Pedidos aprovados que ainda não têm worker: este worker pega, se tiver vaga.
  if (statusWorker === 'online' && worker.accepts_new) {
    const semWorker = await sel('bot_connections', 'status=eq.approved&worker_id=is.null&select=*&order=created_at.asc&limit=3');
    for (const c of semWorker) {
      const inst = await one('bot_instances', `id=eq.${c.instance_id}&select=*`);
      if (inst && inst.admin_state === 'approved') await despacharConexao(c, inst, { workerPreferido: worker.id });
    }
  }

  insts = await sel('bot_instances', `worker_id=eq.${worker.id}&select=*`);
  const ids = insts.map((i) => i.id);
  const [subs, versoes, jobsBrutos] = await Promise.all([
    ids.length ? sel('bot_subscriptions', `instance_id=in.(${ids.join(',')})&status=in.(trialing,pending_payment,active,past_due,suspended)&select=*`) : [],
    ids.length ? sel('bot_group_commands', `instance_id=in.(${ids.join(',')})&select=instance_id,version`) : [],
    statusWorker === 'online' ? rpc('bot_claim_jobs', { p_worker: worker.id, p_limit: 10 }) : []
  ]);
  const subDe = new Map(subs.map((s) => [s.instance_id, s]));
  const versaoDe = new Map();
  for (const v of versoes) versaoDe.set(v.instance_id, (versaoDe.get(v.instance_id) || 0) + Number(v.version));

  const jobs = [];
  for (const j of jobsBrutos || []) {
    const payload = {};
    if (j.type === 'pair') {
      const c = j.connection_id ? await one('bot_connections', `id=eq.${j.connection_id}&select=id,instance_id,status,phone_e164`) : null;
      if (!c || c.instance_id !== j.instance_id || !['approved', 'dispatched'].includes(c.status) || !c.phone_e164) {
        await upd('bot_worker_jobs', `id=eq.${j.id}`, { status: 'canceled', finished_at: agoraIso() }, { returning: false });
        continue;
      }
      payload.phone = c.phone_e164; // entregue só ao worker responsável, só enquanto o pedido está aberto
    }
    jobs.push({ id: j.id, type: j.type, instance_id: j.instance_id, payload });
  }

  const cfg = await lerConfig();
  if (Math.random() < 0.03) { try { await rpc('bot_purge_old_logs', { p_days: cfg.bot_log_retention_days }); } catch {} }

  const wInfo = { ...worker, status: statusWorker, last_heartbeat_at: agoraIso() };
  return {
    server_time: agoraIso(),
    worker_status: statusWorker,
    instances: insts.map((i) => {
      const sub = subDe.get(i.id) || null;
      const pode = temDireito(i, sub);
      return {
        id: i.id, name: i.name, is_main: i.is_main, management: i.management, admin_state: i.admin_state,
        desired_state: pode && i.desired_state === 'running' ? 'running' : 'stopped',
        allowed: pode, valid_until: validoAte(i, sub), display_status: statusExibido(i, sub, wInfo).code,
        owner_contact: i.owner_contact_e164 || null, settings_version: versaoDe.get(i.id) || 0
      };
    }),
    orphans: orfas,
    jobs,
    config: { heartbeat_s: 30, log_retention_days: cfg.bot_log_retention_days }
  };
}

async function aplicarRelato(inst, r) {
  const patch = { last_seen_by_worker_at: agoraIso() };
  const op = OP_STATUS.has(r.op_status) ? r.op_status : null;
  if (op) patch.op_status = op;
  const ativ = r.last_activity_at ? dataValida(r.last_activity_at) : null;
  if (ativ) patch.last_activity_at = ativ;
  if (Number.isInteger(r.groups_count) && r.groups_count >= 0 && r.groups_count < 10000) patch.groups_count = r.groups_count;
  if (Number.isInteger(r.commands_count) && r.commands_count >= 0) patch.commands_count = r.commands_count;
  const masc = mascaraSegura(r.phone_masked);
  if (masc) patch.phone_masked = masc;
  if (r.error && typeof r.error === 'object') {
    const code = String(r.error.code || '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40);
    patch.last_error_code = code || null;
    patch.last_error_message = limparTexto(r.error.message || code || 'Erro', 200);
    patch.last_error_at = agoraIso();
  }
  if (r.runtime && typeof r.runtime === 'object') {
    const cmds = Array.isArray(r.runtime.commands) ? r.runtime.commands.filter((c) => /^[a-z0-9_-]{2,40}$/.test(c)).slice(0, 400) : undefined;
    patch.runtime_info = { node: r.runtime.node ? limparTexto(r.runtime.node, 20) : null, platform: r.runtime.platform ? limparTexto(r.runtime.platform, 40) : null,
      rss_mb: num(r.runtime.rss_mb, 0, 100000), ...(cmds ? { commands: cmds } : { commands: inst.runtime_info?.commands || [] }) };
  }
  if (op === 'online' && inst.op_status !== 'online') { patch.connected_since = agoraIso(); patch.last_connected_at = agoraIso(); }
  if (op && op !== 'online' && inst.op_status === 'online') patch.connected_since = null;

  // Conectou: fecha o pedido aberto, grava o hash do número e apaga o número completo.
  if (op === 'online') {
    const conn = await one('bot_connections', `instance_id=eq.${inst.id}&status=in.(dispatched,code_ready,approved)&select=id,phone_e164`);
    if (conn) {
      if (conn.phone_e164) { patch.phone_hash = hmac('phone:' + conn.phone_e164); patch.phone_masked = masc || mascararTelefone(conn.phone_e164); }
      patch.status_reason = null;
      await upd('bot_connections', `id=eq.${conn.id}`, { status: 'connected', connected_at: agoraIso(), phone_e164: null }, { returning: false });
      await supabaseDelete('bot_pairing_codes', `connection_id=eq.${conn.id}`);
      await evento({ instance_id: inst.id, user_id: inst.owner_id, kind: 'connection', event: 'connected', actor_type: 'worker', message: 'Número conectado com sucesso.' });
    }
  }
  // Sessão encerrada pelo WhatsApp: precisa parear de novo.
  if (op === 'auth_error' && inst.op_status !== 'auth_error') {
    patch.phone_hash = null;
    patch.desired_state = 'stopped';
    await evento({ instance_id: inst.id, user_id: inst.owner_id, kind: 'connection', event: 'auth_error', severity: 'error', actor_type: 'worker',
      message: 'O WhatsApp encerrou a sessão deste bot. Conecte o número de novo.' });
  }
  try {
    await upd('bot_instances', `id=eq.${inst.id}`, patch, { returning: false });
  } catch (e) {
    if (String(e?.data?.code) === '23505') {
      delete patch.phone_hash;
      await upd('bot_instances', `id=eq.${inst.id}`, { ...patch, last_error_code: 'duplicate_number', last_error_message: 'Este número já está em outro bot.', last_error_at: agoraIso() }, { returning: false });
    } else throw e;
  }
}

async function supabaseDelete(table, filter) {
  return supabaseRequest(`/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

/* ===================================================================== */
async function resultadoTarefa(req, worker, body) {
  const id = Number(body.job_id);
  if (!Number.isInteger(id) || id <= 0) throw new Erro(400, 'Tarefa inválida.');
  const job = await one('bot_worker_jobs', `id=eq.${id}&worker_id=eq.${worker.id}&select=*`);
  if (!job) throw new Erro(404, 'Tarefa não encontrada.');
  if (!['sent', 'queued'].includes(job.status)) return { message: 'Tarefa já finalizada.' };
  const st = body.status === 'done' ? 'done' : 'failed';
  const r = body.result && typeof body.result === 'object' ? body.result : {};
  const resumo = { message: r.message ? limparTexto(r.message, 200) : null, error_code: r.error_code ? String(r.error_code).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40) : null };
  const inst = job.instance_id ? await one('bot_instances', `id=eq.${job.instance_id}&select=id,owner_id`) : null;

  if (job.type === 'pair' && job.connection_id) {
    const conn = await one('bot_connections', `id=eq.${job.connection_id}&select=id,status`);
    if (conn && ['approved', 'dispatched', 'code_ready'].includes(conn.status)) {
      const code = st === 'done' ? formatarCodigo(r.pairing_code) : null;
      if (code) {
        const segundos = Math.max(30, Math.min(300, Number(r.expires_in_s) || 160));
        const expira = new Date(Date.now() + segundos * 1000).toISOString();
        await ins('bot_pairing_codes', [{ connection_id: conn.id, code, expires_at: expira }], { returning: false, onConflict: 'connection_id', merge: true });
        await upd('bot_connections', `id=eq.${conn.id}`, { status: 'code_ready', code_expires_at: expira }, { returning: false });
        await evento({ instance_id: job.instance_id, user_id: inst?.owner_id, kind: 'connection', event: 'pairing_code_ready', actor_type: 'worker',
          message: 'Código de pareamento gerado. Ele aparece na sua página por poucos minutos.' });
      } else {
        await upd('bot_connections', `id=eq.${conn.id}`, { status: 'failed', phone_e164: null, error_code: resumo.error_code, error_message: resumo.message || 'Não foi possível gerar o código.' }, { returning: false });
        await upd('bot_instances', `id=eq.${job.instance_id}`, { op_status: 'awaiting_connection', last_error_code: resumo.error_code || 'pair_failed', last_error_message: resumo.message || 'Falha no pareamento.', last_error_at: agoraIso() }, { returning: false });
        await evento({ instance_id: job.instance_id, user_id: inst?.owner_id, kind: 'connection', event: 'pairing_failed', severity: 'warning', actor_type: 'worker',
          message: 'Não foi possível gerar o código de pareamento. Tente conectar de novo.' });
      }
    }
  }
  if (job.type === 'disconnect' && st === 'done') {
    await upd('bot_instances', `id=eq.${job.instance_id}`, { op_status: 'disconnected', phone_masked: null, phone_hash: null, connected_since: null }, { returning: false });
    await evento({ instance_id: job.instance_id, user_id: inst?.owner_id, kind: 'connection', event: 'disconnected', actor_type: 'worker', message: 'Sessão do WhatsApp encerrada no servidor.' });
  }
  if (job.type === 'broadcast_now') {
    const s = statsValidos(r.stats);
    if (s) { try { await upd('bot_broadcast_settings', `instance_id=eq.${job.instance_id}`, s, { returning: false }); } catch (e) { if (!tabelaAusente(e)) throw e; } }
    await evento({ instance_id: job.instance_id, user_id: inst?.owner_id, kind: 'broadcast', event: st === 'done' ? 'broadcast_sent' : 'broadcast_failed',
      severity: st === 'done' ? 'info' : 'warning', actor_type: 'worker', message: resumo.message || (st === 'done' ? 'Disparo concluído.' : 'Falha ao disparar.') });
  }
  // O código de pareamento nunca é guardado no resultado da tarefa.
  await upd('bot_worker_jobs', `id=eq.${job.id}`, { status: st, finished_at: agoraIso(), result: resumo }, { returning: false });
  return { message: 'Registrado.' };
}

/* ===================================================================== */
async function sincronizarGrupos(req, worker, body) {
  const inst = await instanciaDoWorker(worker, body.instance_id);
  const lista = Array.isArray(body.groups) ? body.groups.slice(0, 500) : [];
  const rows = [];
  const hashes = new Set();
  for (const g of lista) {
    const jid = String(g?.jid || '');
    if (!/^[0-9-]{5,40}@g\.us$/.test(jid)) continue;
    const h = hmac(`group:${inst.id}:${jid}`);
    if (hashes.has(h)) continue;
    hashes.add(h);
    const actual = {};
    if (g.actual && typeof g.actual === 'object') for (const [k, v] of Object.entries(g.actual)) if (CHAVES_ATUAIS.has(k) && typeof v === 'boolean') actual[k] = v;
    const recentes = Array.isArray(g.recent) ? g.recent.slice(0, 10).map((e) => ({ at: dataValida(e?.at), event: limparTexto(e?.event, 80) })).filter((e) => e.at && e.event) : [];
    rows.push({
      instance_id: inst.id, jid, jid_hash: h, ref: 'G-' + hmac(`ref:${inst.id}:${jid}`).slice(0, 10).toUpperCase(),
      name: g.name ? limparTexto(g.name, 120) : null,
      member_count: Number.isInteger(g.size) && g.size >= 0 && g.size < 100000 ? g.size : null,
      bot_is_admin: typeof g.bot_admin === 'boolean' ? g.bot_admin : null,
      status: 'active', last_seen_at: agoraIso(),
      last_activity_at: g.last_activity_at ? dataValida(g.last_activity_at) : null,
      commands_count: Number.isInteger(g.commands_count) && g.commands_count >= 0 ? g.commands_count : 0,
      actual_settings: actual, recent_events: recentes
    });
  }
  if (rows.length) await ins('bot_groups', rows, { returning: false, onConflict: 'instance_id,jid_hash', merge: true });
  if (body.complete === true) {
    const ativos = await sel('bot_groups', `instance_id=eq.${inst.id}&status=eq.active&select=id,jid_hash`);
    const sairam = ativos.filter((g) => !hashes.has(g.jid_hash)).map((g) => g.id);
    if (sairam.length) await upd('bot_groups', `id=in.(${sairam.join(',')})`, { status: 'left' }, { returning: false });
    await upd('bot_instances', `id=eq.${inst.id}`, { groups_count: rows.length }, { returning: false });
  }
  const [desejado, grupos] = await Promise.all([
    sel('bot_group_commands', `instance_id=eq.${inst.id}&select=group_id,key,enabled,version`),
    sel('bot_groups', `instance_id=eq.${inst.id}&status=eq.active&select=id,jid,ref`)
  ]);
  const g = new Map(grupos.map((x) => [x.id, x]));
  return {
    settings: desejado.filter((d) => g.has(d.group_id))
      .map((d) => ({ jid: g.get(d.group_id).jid, ref: g.get(d.group_id).ref, key: d.key, enabled: d.enabled, version: Number(d.version) }))
  };
}

async function confirmarConfig(req, worker, body) {
  const inst = await instanciaDoWorker(worker, body.instance_id);
  const aplicados = Array.isArray(body.applied) ? body.applied.slice(0, 500) : [];
  if (!aplicados.length) return { updated: 0 };
  const grupos = await sel('bot_groups', `instance_id=eq.${inst.id}&select=id,ref`);
  const idDe = new Map(grupos.map((g) => [g.ref, g.id]));
  let n = 0;
  for (const a of aplicados) {
    const gid = idDe.get(String(a?.ref || ''));
    const v = Number(a?.version);
    if (!gid || !Number.isInteger(v) || v < 1 || !/^(feature|cmd|category):[a-z0-9_-]{2,40}$/.test(String(a?.key || ''))) continue;
    const r = await upd('bot_group_commands', `group_id=eq.${gid}&key=eq.${enc(a.key)}&version=gte.${v}&applied_version=lt.${v}`, { applied_version: v, applied_at: agoraIso() });
    n += r?.length || 0;
  }
  return { updated: n };
}

/* ===================================================================== *
 * Autodisparo: o worker chama "broadcast-sync" de tempos em tempos (ex.:
 * junto com o heartbeat, ou no intervalo configurado) pra saber a config
 * atual e, no mesmo passo, entregar as métricas mais recentes que leu do
 * storage/autoresponder.json do bot. Confirma que aplicou com "broadcast-ack".
 * ===================================================================== */
function statsValidos(s) {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  if (Number.isInteger(s.total_sent) && s.total_sent >= 0) out.total_sent = Math.min(s.total_sent, 10_000_000);
  if (Number.isInteger(s.total_cycles) && s.total_cycles >= 0) out.total_cycles = Math.min(s.total_cycles, 1_000_000);
  const at = s.last_dispatch_at ? dataValida(s.last_dispatch_at) : null;
  if (at) out.last_dispatch_at = at;
  return Object.keys(out).length ? out : null;
}
async function sincronizarBroadcast(req, worker, body) {
  const inst = await instanciaDoWorker(worker, body.instance_id);
  const stats = statsValidos(body.stats);
  if (stats) {
    try { await upd('bot_broadcast_settings', `instance_id=eq.${inst.id}`, stats, { returning: false }); } catch (e) { if (!tabelaAusente(e)) throw e; }
  }
  const grupos = await sel('bot_groups', `instance_id=eq.${inst.id}&status=eq.active&select=jid,ref`);
  const jidPorRef = new Map(grupos.map((g) => [g.ref, g.jid]));
  const cfg = await one('bot_broadcast_settings', `instance_id=eq.${inst.id}&select=*`);
  if (!cfg) return { settings: null };
  const jids = (Array.isArray(cfg.group_refs) ? cfg.group_refs : []).map((r) => jidPorRef.get(r)).filter(Boolean);
  return {
    settings: {
      enabled: !!cfg.enabled, message: cfg.message || '', interval_minutes: cfg.interval_minutes || 60,
      mode: cfg.mode || 'todos', image_url: cfg.image_url || null,
      group_jids: cfg.mode === 'selecionados' ? jids : [],
      version: Number(cfg.version || 0)
    }
  };
}
async function confirmarBroadcast(req, worker, body) {
  const inst = await instanciaDoWorker(worker, body.instance_id);
  const v = Number(body.version);
  if (!Number.isInteger(v) || v < 1) throw new Erro(400, 'Versão inválida.');
  const r = await upd('bot_broadcast_settings', `instance_id=eq.${inst.id}&version=gte.${v}&applied_version=lt.${v}`, { applied_version: v, applied_at: agoraIso() });
  return { updated: r?.length || 0 };
}

async function receberLogs(req, worker, body) {
  if (!rateLimit(`worker-logs:${worker.id}`, 20, 60_000)) throw new Erro(429, 'Muitos logs.');
  const entradas = Array.isArray(body.entries) ? body.entries.slice(0, 50) : [];
  let instId = null;
  if (body.instance_id) instId = (await instanciaDoWorker(worker, body.instance_id)).id;
  const rows = entradas
    .filter((e) => ['info', 'warn', 'error'].includes(e?.level) && e?.message)
    .map((e) => ({ instance_id: instId, worker_id: worker.id, level: e.level, message: limparTexto(e.message, 500), created_at: dataValida(e.at) || agoraIso() }));
  if (rows.length) await ins('bot_logs', rows, { returning: false });
  return { stored: rows.length };
}

async function receberEvento(req, worker, body) {
  const tipo = String(body.event || '');
  const def = EVENTOS_WORKER[tipo];
  if (!def) throw new Erro(400, 'Evento desconhecido.');
  let inst = null;
  if (body.instance_id) inst = await instanciaDoWorker(worker, body.instance_id);
  const detalhes = {};
  if (body.details && typeof body.details === 'object') {
    for (const [k, v] of Object.entries(body.details).slice(0, 12)) {
      if (!/^[a-z_]{2,30}$/.test(k)) continue;
      detalhes[k] = typeof v === 'number' || typeof v === 'boolean' ? v : limparTexto(v, 120);
    }
  }
  await evento({ instance_id: inst?.id || null, user_id: inst?.owner_id || null, kind: 'worker', event: tipo, severity: def.sev,
    visibility: inst ? def.vis : 'admin', actor_type: 'worker', message: def.msg, details: { worker: worker.name, ...detalhes } });
  if (inst && ['crash_loop', 'conflict'].includes(tipo)) {
    // Só registra o erro. O estado (online/offline...) vem apenas do heartbeat, para um
    // evento atrasado não sobrescrever um estado mais novo.
    await upd('bot_instances', `id=eq.${inst.id}`, { last_error_code: tipo, last_error_message: def.msg, last_error_at: agoraIso() }, { returning: false });
  }
  return { message: 'Registrado.' };
}
