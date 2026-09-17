// /api/v1/bots — área "Conectar com bot" (usuário) e seção "Bots" do painel (admin).
// Uma única função com ?type=, para caber no limite de funções da Vercel Hobby.
//
// Usuário (Bearer do Supabase):
//   GET  status                         tudo que o dono precisa ver (só dados dele)
//   POST subscribe | change-plan | renew | cancel | resume
//   POST connect | cancel-connection | disconnect | restart | rename
//   POST group-setting
// Admin (Bearer + papel admin + AAL2 quando a conta tem 2FA):
//   GET  admin-list | admin-instance | admin-plans | admin-workers | admin-groups | admin-audit | admin-settings
//   POST admin-action | admin-plan-save | admin-worker-save | admin-worker-token | admin-group-setting | admin-settings | admin-create-main
import {
  getUserFromAccessToken, bearerToken, requireAdmin, readJsonBody, sendJson, serverError, originAllowed, rateLimit
} from '../_supabase.js';
import {
  enc, sel, one, ins, upd, del, rpc, tabelaAusente, violacaoUnica, refreshAssinaturas, lerConfig, BOT_SETTINGS_DEFAULTS,
  gatewayDisponivel, MSG_PAGAMENTO_TESTE, hmac, normalizarTelefone, mascararTelefone, limparTexto, nomeValido, uuidValido,
  contextoPedido, statusExibido, instanciaPublica, assinaturaPublica, pagamentoPublico, eventoPublico, planoPublico,
  CATALOGO, chaveValida, evento, auditar, gerarTokenWorker, atribuirWorker, criarTarefa, despacharConexao, localExecucao,
  inteiro, WORKER_TIMEOUT_MS
} from '../_bots.js';

class Erro extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const ABERTAS = ['trialing', 'pending_payment', 'active', 'past_due', 'suspended'];
const CONEXAO_ABERTA = ['pending_approval', 'approved', 'dispatched', 'code_ready'];
const agoraIso = () => new Date().toISOString();

/* ===================================================================== */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const type = String(req.query?.type || '');
  try {
    if (req.method === 'POST' && !originAllowed(req)) throw new Erro(403, 'Ação não permitida.');
    if (type.startsWith('admin-')) return await rotaAdmin(req, res, type);
    return await rotaUsuario(req, res, type);
  } catch (error) {
    if (error instanceof Erro) return sendJson(res, error.status, { ok: false, message: error.message });
    if (tabelaAusente(error)) return sendJson(res, 503, { ok: false, message: 'A plataforma de bots ainda não foi instalada no banco. Rode as migrations da plataforma.' });
    if (violacaoUnica(error)) return sendJson(res, 409, { ok: false, message: 'Isso conflita com algo que já existe (por exemplo, o mesmo número em outro bot).' });
    return serverError(res, error, `v1-bots:${type}`, 'Não foi possível concluir essa ação agora. Tente novamente em instantes.');
  }
}

function exigirMetodo(req, metodo) {
  if (req.method !== metodo) { throw new Erro(405, 'Essa ação não funciona desse jeito. Atualize a página e tente de novo.'); }
}
function corpo(req) {
  const b = readJsonBody(req);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Erro(400, 'Os dados enviados não são válidos.');
  return b;
}

/* ===================================================================== *
 *  USUÁRIO
 * ===================================================================== */
async function rotaUsuario(req, res, type) {
  const user = await getUserFromAccessToken(bearerToken(req));
  if (!user) throw new Erro(401, 'Entre na sua conta para continuar.');
  if (!rateLimit(`bots-user:${user.id}`, 60, 60_000)) throw new Erro(429, 'Muitas ações seguidas. Aguarde um instante.');
  const cfg = await lerConfig();

  if (type === 'status') { exigirMetodo(req, 'GET'); return sendJson(res, 200, await montarStatus(user, cfg)); }

  exigirMetodo(req, 'POST');
  if (!cfg.bot_platform_enabled) throw new Erro(403, 'A área de bots ainda não foi liberada.');
  if (!rateLimit(`bots-user-write:${user.id}`, 20, 60_000)) throw new Erro(429, 'Muitas alterações seguidas. Aguarde um instante.');
  const body = corpo(req);
  const acoes = {
    subscribe: acaoAssinar, 'change-plan': acaoTrocarPlano, renew: acaoRenovar, cancel: acaoCancelar, resume: acaoRetomar,
    connect: acaoConectar, 'cancel-connection': acaoCancelarConexao, disconnect: acaoDesconectar, restart: acaoReiniciar,
    rename: acaoRenomear, 'group-setting': acaoConfigGrupo
  };
  const fn = acoes[type];
  if (!fn) throw new Erro(404, 'Não achei essa ação por aqui.');
  const out = await fn({ req, user, cfg, body });
  return sendJson(res, 200, { ok: true, ...out });
}

async function planosAtivos() {
  return sel('bot_plans', 'active=eq.true&select=*&order=display_order.asc,price.asc');
}
async function minhasInstancias(userId) {
  return sel('bot_instances', `owner_id=eq.${enc(userId)}&admin_state=neq.revoked&select=*&order=created_at.asc`);
}
async function assinaturaDa(instanceId) {
  const rows = await sel('bot_subscriptions', `instance_id=eq.${enc(instanceId)}&select=*&order=created_at.desc&limit=5`);
  return rows.find((s) => ABERTAS.includes(s.status)) || rows[0] || null;
}
async function workerDe(id) {
  return id ? one('worker_nodes', `id=eq.${enc(id)}&select=id,name,kind,region,status,last_heartbeat_at`) : null;
}
// Instância do usuário (a primeira ativa). Nunca aceita id vindo do navegador
// sem conferir o dono.
async function minhaInstancia(user, body) {
  const lista = await minhasInstancias(user.id);
  if (body?.instance_id) {
    const id = uuidValido(body.instance_id);
    const inst = lista.find((i) => i.id === id);
    if (!inst) throw new Erro(404, 'Bot não encontrado.');
    return inst;
  }
  return lista[0] || null;
}

async function montarStatus(user, cfg) {
  const base = {
    ok: true, enabled: cfg.bot_platform_enabled, require_approval: cfg.bot_require_approval,
    payment_mode: cfg.bot_payment_mode, test_notice: cfg.bot_payment_mode === 'manual_test' ? MSG_PAGAMENTO_TESTE : null,
    phase_notice: 'Os bots rodam em servidores de teste e podem ficar fora do ar. Ainda não há garantia de funcionamento 24 horas.',
    catalog: CATALOGO.map(({ key, label, como }) => ({ key, label, how: como }))
  };
  const planos = await planosAtivos();
  base.plans = planos.map(planoPublico);
  if (!cfg.bot_platform_enabled) return { ...base, instance: null, subscription: null };
  try { await refreshAssinaturas(); } catch (e) { if (tabelaAusente(e)) throw e; }

  const inst = (await minhasInstancias(user.id))[0] || null;
  if (!inst) return { ...base, instance: null, subscription: null, connection: null, payments: [], events: [], groups: [] };

  const [sub, worker, conexoes] = await Promise.all([
    assinaturaDa(inst.id), workerDe(inst.worker_id),
    sel('bot_connections', `instance_id=eq.${enc(inst.id)}&select=id,status,phone_masked,decision_reason,code_expires_at,connected_at,error_message,created_at&order=created_at.desc&limit=1`)
  ]);
  const todosPlanos = sub ? await sel('bot_plans', 'select=id,code,name') : [];
  const conn = conexoes[0] || null;
  let conexao = null;
  if (conn) {
    conexao = { id: conn.id, status: conn.status, phone_masked: conn.phone_masked, reason: conn.decision_reason, error: conn.error_message, created_at: conn.created_at, connected_at: conn.connected_at };
    if (conn.status === 'code_ready' && conn.code_expires_at && new Date(conn.code_expires_at) > new Date()) {
      // Único lugar onde o código sai: para o próprio dono, enquanto vale.
      const code = await one('bot_pairing_codes', `connection_id=eq.${enc(conn.id)}&select=code,expires_at`);
      if (code) { conexao.pairing_code = code.code; conexao.code_expires_at = code.expires_at; }
    }
  }
  const [pagamentos, eventos, grupos] = await Promise.all([
    sub ? sel('bot_payments', `subscription_id=eq.${enc(sub.id)}&select=*&order=created_at.desc&limit=5`) : [],
    sel('bot_events', `user_id=eq.${enc(user.id)}&visibility=eq.owner&instance_id=eq.${enc(inst.id)}&select=id,kind,event,severity,actor_type,message,group_id,created_at&order=created_at.desc&limit=25`),
    gruposDaInstancia(inst.id)
  ]);
  return {
    ...base,
    instance: instanciaPublica(inst, sub, worker),
    subscription: assinaturaPublica(sub, todosPlanos),
    connection: conexao,
    payments: pagamentos.map(pagamentoPublico),
    events: eventos.map(eventoPublico),
    groups: grupos
  };
}

async function gruposDaInstancia(instanceId, { admin = false } = {}) {
  const grupos = await sel('bot_groups', `instance_id=eq.${enc(instanceId)}&status=neq.removed&select=id,ref,name,member_count,bot_is_admin,status,first_seen_at,last_seen_at,last_activity_at,commands_count,actual_settings,recent_events&order=name.asc&limit=300`);
  if (!grupos.length) return [];
  const cfgs = await sel('bot_group_commands', `instance_id=eq.${enc(instanceId)}&select=group_id,key,enabled,version,applied_version,updated_by_type,updated_at`);
  const porGrupo = new Map();
  for (const c of cfgs) {
    if (!porGrupo.has(c.group_id)) porGrupo.set(c.group_id, {});
    porGrupo.get(c.group_id)[c.key] = { enabled: c.enabled, pending: Number(c.applied_version) < Number(c.version), by: c.updated_by_type, at: c.updated_at };
  }
  return grupos.map((g) => ({
    ...(admin ? { id: g.id } : {}),
    ref: g.ref, name: g.name, member_count: g.member_count, bot_is_admin: g.bot_is_admin, status: g.status,
    first_seen_at: g.first_seen_at, last_seen_at: g.last_seen_at, last_activity_at: g.last_activity_at,
    commands_count: Number(g.commands_count || 0), actual: g.actual_settings || {},
    recent_events: Array.isArray(g.recent_events) ? g.recent_events.slice(0, 10) : [],
    settings: porGrupo.get(g.id) || {}
  }));
}

/* ---------- assinatura ---------- */
async function acaoAssinar({ user, cfg, body }) {
  const plano = await planoPorCodigo(body.plan_code);
  const lista = await minhasInstancias(user.id);
  let inst = lista[0] || null;
  if (inst) {
    const sub = await assinaturaDa(inst.id);
    if (sub && ABERTAS.includes(sub.status)) throw new Erro(409, 'Você já tem uma assinatura. Use "Trocar plano" ou "Renovar".');
    if (['blocked', 'suspended'].includes(inst.admin_state)) throw new Erro(403, 'Este bot está suspenso ou bloqueado. Fale com o suporte.');
  } else {
    if (lista.length >= cfg.bot_max_instances_per_user) throw new Erro(403, 'Você já atingiu o limite de bots desta conta.');
    const nome = nomeValido(body.instance_name) || 'Meu bot';
    inst = (await ins('bot_instances', [{ owner_id: user.id, name: nome, admin_state: cfg.bot_require_approval ? 'pending_approval' : 'approved' }]))[0];
    await evento({ instance_id: inst.id, user_id: user.id, kind: 'instance', event: 'created', actor_type: 'user', actor_id: user.id, message: 'Bot criado.' });
  }
  const jaTeve = await sel('bot_subscriptions', `user_id=eq.${enc(user.id)}&select=id&limit=1`);
  const diasTeste = Math.max(cfg.bot_trial_days, plano.trial_days || 0);
  const agora = new Date();
  if (diasTeste > 0 && !jaTeve.length) {
    const fim = new Date(agora.getTime() + diasTeste * 86400000).toISOString();
    const sub = (await ins('bot_subscriptions', [{ user_id: user.id, instance_id: inst.id, plan_id: plano.id, status: 'trialing', price: plano.price, currency: plano.currency, period: plano.period,
      started_at: agora.toISOString(), trial_ends_at: fim, last_change_by: user.id, last_change_by_type: 'user', last_change_reason: 'Teste grátis iniciado.' }]))[0];
    return { message: `Teste grátis de ${diasTeste} dia(s) iniciado. Agora conecte o número do bot.`, subscription_id: sub.id };
  }
  const gw = gatewayDisponivel(cfg.bot_payment_mode);
  if (!gw.available) throw new Erro(503, 'O pagamento ainda não está disponível. Tente mais tarde.');
  const sub = (await ins('bot_subscriptions', [{ user_id: user.id, instance_id: inst.id, plan_id: plano.id, status: 'pending_payment', price: plano.price, currency: plano.currency, period: plano.period,
    gateway: gw.gateway, last_change_by: user.id, last_change_by_type: 'user', last_change_reason: 'Assinatura solicitada.' }]))[0];
  const pay = await novaCobranca(sub, plano, 'new', user.id, gw);
  return { message: pay.checkout_url ? 'Assinatura criada. Finalize o pagamento para ativar.' : 'Assinatura criada. ' + MSG_PAGAMENTO_TESTE, subscription_id: sub.id, checkout_url: pay.checkout_url || null };
}

async function planoPorCodigo(code) {
  const c = String(code || '').toLowerCase();
  if (!/^[a-z0-9_-]{2,40}$/.test(c)) throw new Erro(400, 'Escolha um plano válido.');
  const p = await one('bot_plans', `code=eq.${enc(c)}&active=eq.true&select=*`);
  if (!p) throw new Erro(404, 'Este plano não está disponível.');
  return p;
}
async function criarCheckoutMercadoPago(pay, plano) {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  const origin = String(process.env.SITE_URL || 'https://www.sorasakiplatform.store').replace(/\/+$/, '');
  const payload = {
    items: [{
      id: String(plano.id), title: `Sorasaki — Bot ${plano.name}`, description: plano.description || undefined,
      quantity: 1, currency_id: plano.currency || 'BRL', unit_price: Number(pay.amount)
    }],
    external_reference: String(pay.id),
    notification_url: `${origin}/api/mercadopago-webhook`,
    back_urls: {
      success: `${origin}/meu-bot?pagamento=sucesso`,
      pending: `${origin}/meu-bot?pagamento=pendente`,
      failure: `${origin}/meu-bot?pagamento=erro`
    },
    auto_return: 'approved',
    metadata: { bot_payment_id: String(pay.id), kind: 'bot_subscription' }
  };
  const mp = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const data = await mp.json().catch(() => ({}));
  if (!mp.ok || !data.id || !data.init_point) {
    console.error('bots.js: Mercado Pago recusou a preferência do bot', mp.status, data?.message || '');
    return null;
  }
  return { checkout_url: data.init_point, gateway_payment_id: String(data.id) };
}

async function novaCobranca(sub, plano, kind, userId, gw) {
  await upd('bot_payments', `subscription_id=eq.${enc(sub.id)}&status=eq.pending`, { status: 'canceled' }, { returning: false });
  const pay = (await ins('bot_payments', [{ subscription_id: sub.id, user_id: userId, plan_id: plano.id, kind, amount: plano.price, currency: plano.currency,
    period_days: plano.duration_days, status: 'pending', is_test: gw.is_test, gateway: gw.gateway, expires_at: new Date(Date.now() + 7 * 86400000).toISOString() }]))[0];
  if (gw.gateway === 'mercadopago') {
    const checkout = await criarCheckoutMercadoPago(pay, plano);
    if (checkout) await upd('bot_payments', `id=eq.${enc(pay.id)}`, checkout, { returning: false });
    else await upd('bot_payments', `id=eq.${enc(pay.id)}`, { status: 'canceled' }, { returning: false });
    Object.assign(pay, checkout || {});
  }
  await evento({ instance_id: sub.instance_id, user_id: userId, subscription_id: sub.id, kind: 'payment', event: 'payment_created', actor_type: 'user', actor_id: userId,
    message: gw.is_test ? 'Cobrança de teste criada (aguardando confirmação do admin).' : 'Cobrança criada.' });
  return pay;
}
async function assinaturaAberta(user, body) {
  const inst = await minhaInstancia(user, body);
  if (!inst) throw new Erro(404, 'Você ainda não tem um bot. Escolha um plano primeiro.');
  const sub = await assinaturaDa(inst.id);
  if (!sub || !ABERTAS.includes(sub.status)) throw new Erro(404, 'Nenhuma assinatura em andamento. Escolha um plano.');
  return { inst, sub };
}

async function acaoTrocarPlano({ user, cfg, body }) {
  const plano = await planoPorCodigo(body.plan_code);
  const { sub } = await assinaturaAberta(user, body);
  if (plano.id === sub.plan_id && !sub.next_plan_id) throw new Erro(400, 'Esse já é o seu plano.');
  if (['pending_payment', 'trialing'].includes(sub.status)) {
    await upd('bot_subscriptions', `id=eq.${enc(sub.id)}`, { plan_id: plano.id, price: plano.price, period: plano.period, next_plan_id: null,
      last_change_by: user.id, last_change_by_type: 'user', last_change_reason: 'Plano trocado antes do pagamento.' }, { returning: false });
    if (sub.status === 'pending_payment') await novaCobranca({ ...sub, plan_id: plano.id }, plano, 'plan_change', user.id, gatewayDisponivel(cfg.bot_payment_mode));
    return { message: `Plano trocado para ${plano.name}.` };
  }
  await upd('bot_subscriptions', `id=eq.${enc(sub.id)}`, { next_plan_id: plano.id === sub.plan_id ? null : plano.id,
    last_change_by: user.id, last_change_by_type: 'user', last_change_reason: 'Troca de plano agendada.' }, { returning: false });
  return { message: plano.id === sub.plan_id ? 'Troca de plano desfeita.' : `O plano ${plano.name} começa na próxima renovação.` };
}

async function acaoRenovar({ user, cfg, body }) {
  const { sub } = await assinaturaAberta(user, body);
  if (sub.status === 'pending_payment') throw new Erro(409, 'Já existe um pagamento aguardando confirmação.');
  const pend = await sel('bot_payments', `subscription_id=eq.${enc(sub.id)}&status=eq.pending&select=id`);
  if (pend.length) return { message: 'Já existe uma renovação aguardando confirmação.' };
  const gw = gatewayDisponivel(cfg.bot_payment_mode);
  if (!gw.available) throw new Erro(503, 'O pagamento ainda não está disponível. Tente mais tarde.');
  const plano = await one('bot_plans', `id=eq.${sub.next_plan_id || sub.plan_id}&select=*`);
  const pay = await novaCobranca(sub, plano, 'renewal', user.id, gw);
  return { message: pay.checkout_url ? 'Renovação criada. Finalize o pagamento para ativar.' : 'Renovação solicitada. ' + MSG_PAGAMENTO_TESTE, checkout_url: pay.checkout_url || null };
}

async function acaoCancelar({ user, body }) {
  const { sub } = await assinaturaAberta(user, body);
  if (sub.status === 'pending_payment') {
    await upd('bot_subscriptions', `id=eq.${enc(sub.id)}`, { status: 'canceled', canceled_at: agoraIso(), last_change_by: user.id, last_change_by_type: 'user', last_change_reason: 'Cancelada antes do pagamento.' }, { returning: false });
    await upd('bot_payments', `subscription_id=eq.${enc(sub.id)}&status=eq.pending`, { status: 'canceled' }, { returning: false });
    return { message: 'Assinatura cancelada.' };
  }
  if (sub.cancel_at_period_end) return { message: 'O cancelamento já está agendado.' };
  await upd('bot_subscriptions', `id=eq.${enc(sub.id)}`, { cancel_at_period_end: true, last_change_by: user.id, last_change_by_type: 'user', last_change_reason: 'Cancelamento pedido pelo dono.' }, { returning: false });
  return { message: 'Cancelamento agendado. O bot continua até o fim do período pago.' };
}
async function acaoRetomar({ user, body }) {
  const { sub } = await assinaturaAberta(user, body);
  if (!sub.cancel_at_period_end) return { message: 'Não há cancelamento agendado.' };
  await upd('bot_subscriptions', `id=eq.${enc(sub.id)}`, { cancel_at_period_end: false, last_change_by: user.id, last_change_by_type: 'user', last_change_reason: 'Cancelamento desfeito pelo dono.' }, { returning: false });
  return { message: 'Cancelamento desfeito. A assinatura continua normalmente.' };
}

/* ---------- conexão do número ---------- */
async function acaoConectar({ req, user, body }) {
  if (!rateLimit(`bots-connect:${user.id}`, 5, 10 * 60_000)) throw new Erro(429, 'Muitos pedidos de conexão. Aguarde alguns minutos.');
  const inst = await minhaInstancia(user, body);
  if (!inst) throw new Erro(404, 'Escolha um plano antes de conectar um número.');
  if (['blocked', 'suspended', 'revoked'].includes(inst.admin_state)) throw new Erro(403, 'Este bot está suspenso ou bloqueado. Fale com o suporte.');
  const sub = await assinaturaDa(inst.id);
  if (!sub || !['trialing', 'active', 'past_due'].includes(sub.status)) {
    throw new Erro(402, sub?.status === 'pending_payment' ? 'O pagamento ainda não foi confirmado. Assim que for, você pode conectar.' : 'Sua assinatura não está ativa. Renove para conectar.');
  }
  const aberta = await sel('bot_connections', `instance_id=eq.${enc(inst.id)}&status=in.(${CONEXAO_ABERTA.join(',')})&select=id`);
  if (aberta.length) throw new Erro(409, 'Já existe um pedido de conexão em andamento.');
  if (inst.phone_hash && inst.op_status === 'online') throw new Erro(409, 'Este bot já está conectado. Desconecte antes de trocar o número.');

  const tel = normalizarTelefone(body.phone);
  if (!tel) throw new Erro(400, 'Número inválido. Use DDD e número, por exemplo 11 91234-5678 (com o código do país se não for do Brasil).');
  const h = hmac('phone:' + tel);
  const outro = await sel('bot_instances', `phone_hash=eq.${enc(h)}&id=neq.${enc(inst.id)}&select=id`);
  const pedidoOutro = await sel('bot_connections', `phone_e164=eq.${tel}&status=in.(${CONEXAO_ABERTA.join(',')})&instance_id=neq.${enc(inst.id)}&select=id`);
  if (outro.length || pedidoOutro.length) throw new Erro(409, 'Esse número já está em uso em outro bot.');

  const patch = {};
  if (body.owner_contact) {
    const dono = normalizarTelefone(body.owner_contact);
    if (!dono) throw new Erro(400, 'O número do dono é inválido.');
    if (dono === tel) throw new Erro(400, 'O número do dono precisa ser diferente do número do bot (o bot ignora mensagens dele mesmo).');
    patch.owner_contact_e164 = dono; patch.owner_contact_masked = mascararTelefone(dono);
  }
  if (Object.keys(patch).length) await upd('bot_instances', `id=eq.${enc(inst.id)}`, patch, { returning: false });

  const { ip, context } = contextoPedido(req);
  // Instância já aprovada (ou aprovação desligada) → pedido aceito na hora.
  const aprovado = inst.admin_state === 'approved';
  const conn = (await ins('bot_connections', [{ instance_id: inst.id, user_id: user.id, status: aprovado ? 'approved' : 'pending_approval',
    phone_e164: tel, phone_masked: mascararTelefone(tel), request_ip: ip, request_context: context }]))[0];
  await evento({ instance_id: inst.id, user_id: user.id, kind: 'connection', event: 'connection_requested', actor_type: 'user', actor_id: user.id,
    message: `Pedido de conexão do número ${mascararTelefone(tel)}.` });
  if (!aprovado) return { message: 'Pedido enviado. Um administrador vai aprovar a conexão; depois disso o código de pareamento aparece aqui.' };
  const d = await despacharConexao(conn, inst, { by: user.id, byType: 'user' });
  return { message: d.dispatched ? 'Preparando o código de pareamento. Ele aparece aqui em instantes.' : 'Pedido aceito. Estamos aguardando um servidor disponível para gerar o código.' };
}

async function acaoCancelarConexao({ user, body }) {
  const inst = await minhaInstancia(user, body);
  if (!inst) throw new Erro(404, 'Bot não encontrado.');
  const rows = await upd('bot_connections', `instance_id=eq.${enc(inst.id)}&status=in.(${CONEXAO_ABERTA.join(',')})`, { status: 'canceled', phone_e164: null });
  if (!rows?.length) return { message: 'Não havia pedido em andamento.' };
  await upd('bot_worker_jobs', `instance_id=eq.${enc(inst.id)}&type=eq.pair&status=in.(queued,sent)`, { status: 'canceled', finished_at: agoraIso() }, { returning: false });
  await evento({ instance_id: inst.id, user_id: user.id, kind: 'connection', event: 'connection_canceled', actor_type: 'user', actor_id: user.id, message: 'Pedido de conexão cancelado.' });
  return { message: 'Pedido cancelado.' };
}

async function acaoDesconectar({ user, body }) {
  const inst = await minhaInstancia(user, body);
  if (!inst) throw new Erro(404, 'Bot não encontrado.');
  if (!inst.phone_hash && !inst.phone_masked) throw new Erro(400, 'Este bot não tem número conectado.');
  if (inst.worker_id) await criarTarefa({ workerId: inst.worker_id, instanceId: inst.id, type: 'disconnect', by: user.id, byType: 'user' });
  await upd('bot_instances', `id=eq.${enc(inst.id)}`, { phone_hash: null, desired_state: 'stopped', status_reason: 'Desconectado pelo dono.',
    ...(inst.worker_id ? {} : { op_status: 'disconnected' }) }, { returning: false });
  await evento({ instance_id: inst.id, user_id: user.id, kind: 'connection', event: 'disconnect_requested', actor_type: 'user', actor_id: user.id, message: 'Desconexão pedida pelo dono.' });
  return { message: inst.worker_id ? 'Desconectando. A sessão do WhatsApp será encerrada no servidor.' : 'Número liberado.' };
}

async function acaoReiniciar({ user, body }) {
  if (!rateLimit(`bots-restart:${user.id}`, 3, 10 * 60_000)) throw new Erro(429, 'Você já reiniciou algumas vezes. Aguarde alguns minutos.');
  const inst = await minhaInstancia(user, body);
  if (!inst) throw new Erro(404, 'Bot não encontrado.');
  const sub = await assinaturaDa(inst.id);
  if (!(await rpc('bot_instance_entitled', { p_instance: inst.id }))) throw new Erro(403, sub?.status === 'suspended' ? 'A assinatura está vencida. Renove para reiniciar.' : 'Este bot não pode ser iniciado agora.');
  if (!inst.worker_id) throw new Erro(409, 'O bot ainda não está em um servidor. Conecte um número primeiro.');
  await criarTarefa({ workerId: inst.worker_id, instanceId: inst.id, type: 'restart', by: user.id, byType: 'user' });
  await upd('bot_instances', `id=eq.${enc(inst.id)}`, { desired_state: 'running' }, { returning: false });
  await evento({ instance_id: inst.id, user_id: user.id, kind: 'instance', event: 'restart_requested', actor_type: 'user', actor_id: user.id, message: 'Reinício pedido pelo dono.' });
  return { message: 'Reiniciando o bot.' };
}

async function acaoRenomear({ user, body }) {
  const inst = await minhaInstancia(user, body);
  if (!inst) throw new Erro(404, 'Bot não encontrado.');
  const nome = nomeValido(body.name);
  if (!nome) throw new Erro(400, 'O nome precisa ter entre 2 e 40 caracteres.');
  await upd('bot_instances', `id=eq.${enc(inst.id)}`, { name: nome }, { returning: false });
  return { message: 'Nome atualizado.' };
}

/* ---------- configuração por grupo (dono) ---------- */
async function acaoConfigGrupo({ user, body }) {
  if (!rateLimit(`bots-group:${user.id}`, 40, 60_000)) throw new Erro(429, 'Muitas alterações seguidas. Aguarde um instante.');
  const inst = await minhaInstancia(user, body);
  if (!inst) throw new Erro(404, 'Bot não encontrado.');
  return salvarConfigGrupo({ inst, ref: body.group_ref, key: body.key, enabled: body.enabled, actor: user.id, actorType: 'user' });
}

async function salvarConfigGrupo({ inst, ref, groupId, key, enabled, actor, actorType }) {
  if (typeof enabled !== 'boolean') throw new Erro(400, 'Valor inválido.');
  let grupo;
  if (groupId) grupo = await one('bot_groups', `id=eq.${enc(uuidValido(groupId) || '00000000-0000-0000-0000-000000000000')}&instance_id=eq.${enc(inst.id)}&select=id,ref,status`);
  else {
    if (!/^G-[0-9A-F]{10}$/.test(String(ref || ''))) throw new Erro(400, 'Grupo inválido.');
    grupo = await one('bot_groups', `ref=eq.${enc(ref)}&instance_id=eq.${enc(inst.id)}&select=id,ref,status`);
  }
  if (!grupo) throw new Erro(404, 'Grupo não encontrado neste bot.');
  if (grupo.status !== 'active') throw new Erro(409, 'O bot não está mais neste grupo.');
  const conhecidos = Array.isArray(inst.runtime_info?.commands) ? inst.runtime_info.commands : null;
  const k = chaveValida(key, conhecidos);
  if (!k) throw new Erro(400, 'Função ou comando desconhecido.');
  const atual = await one('bot_group_commands', `group_id=eq.${enc(grupo.id)}&key=eq.${enc(k)}&select=id,enabled,version`);
  if (atual) {
    if (atual.enabled === enabled) return { message: 'Nada mudou.' };
    await upd('bot_group_commands', `id=eq.${atual.id}`, { enabled, version: Number(atual.version) + 1, updated_by: actor, updated_by_type: actorType, updated_at: agoraIso() }, { returning: false });
  } else {
    await ins('bot_group_commands', [{ group_id: grupo.id, instance_id: inst.id, key: k, enabled, version: 1, updated_by: actor, updated_by_type: actorType }], { returning: false });
  }
  return { message: enabled ? 'Ligado. O bot aplica em até 1 minuto.' : 'Desligado. O bot aplica em até 1 minuto.' };
}

/* ===================================================================== *
 *  ADMIN
 * ===================================================================== */
async function rotaAdmin(req, res, type) {
  const admin = await requireAdmin(req);
  if (!admin) throw new Erro(403, 'Você não tem permissão para esta ação. Se a verificação em duas etapas estiver ativa, confirme o código no painel.');
  if (!rateLimit(`bots-admin:${admin.id}`, 120, 60_000)) throw new Erro(429, 'Muitas ações seguidas. Aguarde um instante.');
  const leituras = { 'admin-list': adminLista, 'admin-instance': adminInstancia, 'admin-plans': adminPlanos, 'admin-workers': adminWorkers,
    'admin-groups': adminGrupos, 'admin-audit': adminAuditoria, 'admin-payments': adminPagamentos };
  const escritas = { 'admin-action': adminAcao, 'admin-plan-save': adminSalvarPlano, 'admin-worker-save': adminSalvarWorker,
    'admin-worker-token': adminTokenWorker, 'admin-group-setting': adminConfigGrupo, 'admin-create-main': adminCriarPrincipal };
  if (type === 'admin-settings') {
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, settings: await lerConfig() });
    exigirMetodo(req, 'POST');
    return sendJson(res, 200, { ok: true, ...(await adminSalvarConfig(req, admin, corpo(req))) });
  }
  if (leituras[type]) { exigirMetodo(req, 'GET'); return sendJson(res, 200, { ok: true, ...(await leituras[type](req, admin)) }); }
  if (escritas[type]) {
    exigirMetodo(req, 'POST');
    if (!rateLimit(`bots-admin-write:${admin.id}`, 40, 60_000)) throw new Erro(429, 'Muitas alterações seguidas. Aguarde um instante.');
    return sendJson(res, 200, { ok: true, ...(await escritas[type](req, admin, corpo(req))) });
  }
  throw new Erro(404, 'Não achei essa ação por aqui.');
}

async function perfisPorId(ids) {
  const lista = [...new Set(ids.filter(Boolean))];
  if (!lista.length) return new Map();
  const rows = await sel('profiles', `user_id=in.(${lista.map(enc).join(',')})&select=user_id,username,display_name,email`);
  return new Map(rows.map((p) => [p.user_id, p]));
}

async function adminLista(req) {
  try { await refreshAssinaturas(); } catch (e) { if (tabelaAusente(e)) throw e; }
  const q = String(req.query?.q || '').trim().toLowerCase().slice(0, 60);
  const filtro = String(req.query?.status || 'all');
  const insts = await sel('bot_instances', 'select=*&order=created_at.desc&limit=300');
  const ids = insts.map((i) => i.id);
  const [subs, workers, planos, perfis, pendentes] = await Promise.all([
    ids.length ? sel('bot_subscriptions', `instance_id=in.(${ids.join(',')})&select=*&order=created_at.desc`) : [],
    sel('worker_nodes', 'select=id,name,kind,region,status,last_heartbeat_at'),
    sel('bot_plans', 'select=id,code,name'),
    perfisPorId(insts.map((i) => i.owner_id)),
    sel('bot_connections', `status=eq.pending_approval&select=instance_id`)
  ]);
  const subDe = new Map();
  for (const s of subs) if (!subDe.has(s.instance_id) || (ABERTAS.includes(s.status) && !ABERTAS.includes(subDe.get(s.instance_id).status))) subDe.set(s.instance_id, s);
  const wDe = new Map(workers.map((w) => [w.id, w]));
  const pend = new Set(pendentes.map((p) => p.instance_id));
  let lista = insts.map((i) => {
    const sub = subDe.get(i.id) || null;
    const w = wDe.get(i.worker_id) || null;
    const p = perfis.get(i.owner_id);
    const plano = sub ? planos.find((x) => x.id === sub.plan_id) : null;
    return {
      id: i.id, name: i.name, is_main: i.is_main, management: i.management, admin_state: i.admin_state,
      owner: i.owner_id ? { id: i.owner_id, username: p?.username || p?.display_name || null, email: p?.email || null } : null,
      phone_masked: i.phone_masked, status: statusExibido(i, sub, w), op_status: i.op_status,
      plan: plano ? plano.name : null, subscription_status: sub?.status || null,
      expires_at: sub ? (sub.status === 'trialing' ? sub.trial_ends_at : sub.current_period_end) : null,
      last_activity_at: i.last_activity_at, last_error: i.last_error_message ? { code: i.last_error_code, message: i.last_error_message, at: i.last_error_at } : null,
      created_at: i.created_at, last_connected_at: i.last_connected_at, groups_count: i.groups_count, commands_count: Number(i.commands_count || 0),
      execution_location: w ? `${w.name} · ${localExecucao(w)}` : null, pending_connection: pend.has(i.id)
    };
  });
  if (q) lista = lista.filter((x) => [x.name, x.owner?.username, x.owner?.email, x.phone_masked, x.id].some((v) => String(v || '').toLowerCase().includes(q)));
  if (filtro === 'pending') lista = lista.filter((x) => x.pending_connection || x.admin_state === 'pending_approval');
  else if (filtro !== 'all') lista = lista.filter((x) => x.status.code === filtro || x.admin_state === filtro);
  const resumo = { total: insts.length, online: lista.filter((x) => x.status.code === 'online').length, pendentes: pend.size,
    workers_online: workers.filter((w) => w.last_heartbeat_at && Date.now() - new Date(w.last_heartbeat_at).getTime() < WORKER_TIMEOUT_MS).length };
  return { instances: lista, summary: resumo };
}

async function instanciaOu404(id) {
  const uid = uuidValido(id);
  if (!uid) throw new Erro(400, 'Instância inválida.');
  const inst = await one('bot_instances', `id=eq.${uid}&select=*`);
  if (!inst) throw new Erro(404, 'Instância não encontrada.');
  return inst;
}

async function adminInstancia(req) {
  const inst = await instanciaOu404(req.query?.id);
  const [subs, pays, conns, eventos, logs, jobs, assigns, worker, planos, perfis, grupos] = await Promise.all([
    sel('bot_subscriptions', `instance_id=eq.${inst.id}&select=*&order=created_at.desc&limit=10`),
    sel('bot_subscriptions', `instance_id=eq.${inst.id}&select=id`).then((ss) => (ss.length ? sel('bot_payments', `subscription_id=in.(${ss.map((x) => x.id).join(',')})&select=*&order=created_at.desc&limit=20`) : [])),
    sel('bot_connections', `instance_id=eq.${inst.id}&select=id,status,method,phone_masked,request_ip,request_context,decided_at,decision_reason,connected_at,error_code,error_message,created_at&order=created_at.desc&limit=20`),
    sel('bot_events', `instance_id=eq.${inst.id}&select=id,kind,event,severity,visibility,actor_type,actor_id,message,details,created_at&order=created_at.desc&limit=100`),
    sel('bot_logs', `instance_id=eq.${inst.id}&select=level,message,created_at&order=created_at.desc&limit=100`),
    sel('bot_worker_jobs', `instance_id=eq.${inst.id}&select=id,type,status,requested_by_type,attempts,created_at,finished_at&order=created_at.desc&limit=20`),
    sel('instance_assignments', `instance_id=eq.${inst.id}&select=worker_id,active,assigned_at,unassigned_at,reason&order=assigned_at.desc&limit=20`),
    inst.worker_id ? one('worker_nodes', `id=eq.${inst.worker_id}&select=id,name,kind,region,status,last_heartbeat_at,metrics,agent_version`) : null,
    sel('bot_plans', 'select=id,code,name'),
    perfisPorId([inst.owner_id]),
    gruposDaInstancia(inst.id, { admin: true })
  ]);
  const sub = subs.find((s) => ABERTAS.includes(s.status)) || subs[0] || null;
  const p = perfis.get(inst.owner_id);
  return {
    instance: {
      ...instanciaPublica(inst, sub, worker), is_main: inst.is_main, management: inst.management, desired_state: inst.desired_state, op_status: inst.op_status,
      owner: inst.owner_id ? { id: inst.owner_id, username: p?.username || null, email: p?.email || null } : null,
      worker: worker ? { id: worker.id, name: worker.name, kind: worker.kind, region: worker.region, status: worker.status, last_heartbeat_at: worker.last_heartbeat_at, agent_version: worker.agent_version } : null,
      runtime: { node: inst.runtime_info?.node || null, platform: inst.runtime_info?.platform || null, rss_mb: inst.runtime_info?.rss_mb ?? null },
      last_seen_by_worker_at: inst.last_seen_by_worker_at
    },
    subscriptions: subs.map((s) => assinaturaPublica(s, planos)),
    payments: pays.map(pagamentoPublico),
    connections: conns.map((c) => ({ id: c.id, status: c.status, method: c.method, phone_masked: c.phone_masked, ip: c.request_ip || null,
      context: c.request_context || {}, decided_at: c.decided_at, reason: c.decision_reason, connected_at: c.connected_at, error: c.error_message, created_at: c.created_at })),
    events: eventos.map((e) => ({ ...eventoPublico(e), visibility: e.visibility, details: e.details })),
    logs, jobs, assignments: assigns, groups: grupos
  };
}

/* ---------- ações administrativas (todas auditadas) ---------- */
const ACOES_COM_MOTIVO = new Set(['suspend', 'block', 'revoke', 'disconnect', 'reject-connection', 'delete']);
async function adminAcao(req, admin, body) {
  const action = String(body.action || '');
  const reason = body.reason ? limparTexto(body.reason, 300) : null;
  const inst = await instanciaOu404(body.instance_id);
  if (ACOES_COM_MOTIVO.has(action) && (!reason || reason.length < 3)) throw new Erro(400, 'Informe o motivo desta ação.');
  const aud = (result, details = {}) => auditar(req, admin, { action: `bot.${action}`, entityId: inst.id, targetUser: inst.owner_id, targetInstance: inst.id, result, reason, details });
  const ev = (event, message, extra = {}) => evento({ instance_id: inst.id, user_id: inst.owner_id, kind: 'admin', event, actor_type: 'admin', actor_id: admin.id, message, ...extra });
  try {
    const out = await executarAcaoAdmin({ action, inst, body, reason, admin, ev });
    await aud('ok', out.audit || {});
    delete out.audit;
    return out;
  } catch (e) {
    await aud(e instanceof Erro ? 'denied' : 'error', { message: e instanceof Erro ? e.message : 'erro interno' });
    throw e;
  }
}

async function executarAcaoAdmin({ action, inst, body, reason, admin, ev }) {
  const setInst = (patch) => upd('bot_instances', `id=eq.${inst.id}`, patch, { returning: false });
  const tarefa = (type) => (inst.worker_id ? criarTarefa({ workerId: inst.worker_id, instanceId: inst.id, type, by: admin.id, byType: 'admin' }) : null);
  // Bot principal em modo monitor: o worker só observa; nada de iniciar, parar ou desconectar.
  if (inst.management === 'monitor' && ['start', 'stop', 'restart', 'disconnect', 'revoke', 'assign-worker'].includes(action)) {
    throw new Erro(409, 'Este é o bot principal em modo monitoramento: o painel não inicia, para nem desconecta ele.');
  }
  switch (action) {
    case 'approve':
    case 'reactivate': {
      if (inst.admin_state === 'revoked') throw new Erro(409, 'Instância revogada não pode ser reativada. Crie uma nova.');
      await setInst({ admin_state: 'approved', approved_at: agoraIso(), approved_by: admin.id, status_reason: null, desired_state: inst.phone_hash ? 'running' : inst.desired_state });
      if (inst.phone_hash) await tarefa('start');
      await ev(action === 'approve' ? 'approved' : 'reactivated', action === 'approve' ? 'Bot aprovado pela administração.' : 'Bot reativado pela administração.');
      return { message: action === 'approve' ? 'Instância aprovada.' : 'Instância reativada.' };
    }
    case 'accept-connection':
    case 'reject-connection': {
      const conn = await one('bot_connections', `instance_id=eq.${inst.id}&status=eq.pending_approval&select=*`);
      if (!conn) throw new Erro(404, 'Não há pedido de conexão aguardando.');
      if (action === 'reject-connection') {
        await upd('bot_connections', `id=eq.${conn.id}`, { status: 'rejected', phone_e164: null, decided_at: agoraIso(), decided_by: admin.id, decision_reason: reason }, { returning: false });
        await ev('connection_rejected', `Pedido de conexão recusado: ${reason}`);
        return { message: 'Pedido recusado.' };
      }
      if (['blocked', 'suspended', 'revoked'].includes(inst.admin_state)) throw new Erro(409, 'Reative a instância antes de aceitar a conexão.');
      if (inst.admin_state === 'pending_approval') await setInst({ admin_state: 'approved', approved_at: agoraIso(), approved_by: admin.id });
      await upd('bot_connections', `id=eq.${conn.id}`, { status: 'approved', decided_at: agoraIso(), decided_by: admin.id, decision_reason: reason }, { returning: false });
      await ev('connection_approved', 'Pedido de conexão aceito.');
      const d = await despacharConexao(conn, { ...inst, admin_state: 'approved' }, { by: admin.id, byType: 'admin', workerPreferido: uuidValido(body.worker_id) });
      return { message: d.dispatched ? 'Conexão aceita e enviada ao worker.' : 'Conexão aceita. Nenhum worker disponível agora; ela sai assim que um worker ficar online.' };
    }
    case 'suspend':
    case 'block':
    case 'revoke': {
      const estado = { suspend: 'suspended', block: 'blocked', revoke: 'revoked' }[action];
      await setInst({ admin_state: estado, status_reason: reason, ...(action === 'revoke' ? { phone_hash: null } : {}) });
      await tarefa(action === 'revoke' ? 'disconnect' : 'stop');
      await ev(estado, `${{ suspended: 'Suspenso', blocked: 'Bloqueado', revoked: 'Revogado' }[estado]} pela administração: ${reason}`, { severity: 'warning' });
      return { message: { suspended: 'Instância suspensa.', blocked: 'Instância bloqueada.', revoked: 'Instância revogada.' }[estado] };
    }
    case 'delete': {
      if (!['revoked', 'blocked'].includes(inst.admin_state)) {
        throw new Erro(409, 'Revogue ou bloqueie a instância antes de excluir — isso evita apagar por engano um bot ainda ativo.');
      }
      if (inst.worker_id) await tarefa('wipe');
      const antes = { name: inst.name, owner_id: inst.owner_id, admin_state: inst.admin_state, created_at: inst.created_at };
      await ev('deleted', `Bot excluído pela administração: ${reason}`, { severity: 'warning' });
      await del('bot_instances', `id=eq.${inst.id}`);
      return { message: 'Bot excluído.', audit: { deleted: antes } };
    }
    case 'disconnect': {
      await tarefa('disconnect');
      await setInst({ phone_hash: null, desired_state: 'stopped', status_reason: reason, ...(inst.worker_id ? {} : { op_status: 'disconnected' }) });
      await ev('disconnected_by_admin', `Número desconectado pela administração: ${reason}`, { severity: 'warning' });
      return { message: 'Desconexão enviada.' };
    }
    case 'start':
    case 'stop':
    case 'restart': {
      if (!inst.worker_id) throw new Erro(409, 'A instância não está atribuída a nenhum worker.');
      if (action !== 'stop' && !(await rpc('bot_instance_entitled', { p_instance: inst.id }))) throw new Erro(409, 'A instância não tem direito de rodar (assinatura ou situação). Ajuste antes.');
      await tarefa(action);
      await setInst({ desired_state: action === 'stop' ? 'stopped' : 'running' });
      await ev(`${action}_by_admin`, { start: 'Iniciado', stop: 'Parado', restart: 'Reiniciado' }[action] + ' pela administração.');
      return { message: 'Comando enviado ao worker.' };
    }
    case 'change-plan': {
      const plano = await one('bot_plans', `code=eq.${enc(String(body.plan_code || ''))}&select=*`);
      if (!plano) throw new Erro(404, 'Plano não encontrado.');
      const sub = await assinaturaDa(inst.id);
      if (!sub || !ABERTAS.includes(sub.status)) throw new Erro(404, 'Instância sem assinatura em andamento. Use "Conceder assinatura".');
      await upd('bot_subscriptions', `id=eq.${sub.id}`, { plan_id: plano.id, price: plano.price, period: plano.period, next_plan_id: null,
        last_change_by: admin.id, last_change_by_type: 'admin', last_change_reason: reason || 'Plano alterado pela administração.' }, { returning: false });
      return { message: `Plano alterado para ${plano.name}.`, audit: { plan: plano.code } };
    }
    case 'set-validity': {
      const fim = new Date(String(body.period_end || ''));
      if (Number.isNaN(fim.getTime())) throw new Erro(400, 'Data de validade inválida.');
      if (fim.getTime() > Date.now() + 800 * 86400000) throw new Erro(400, 'Validade longa demais.');
      const sub = await assinaturaDa(inst.id);
      if (!sub || !ABERTAS.includes(sub.status)) throw new Erro(404, 'Instância sem assinatura em andamento. Use "Conceder assinatura".');
      const patch = { current_period_end: fim.toISOString(), last_change_by: admin.id, last_change_by_type: 'admin', last_change_reason: reason || 'Validade alterada pela administração.' };
      if (fim > new Date() && ['past_due', 'suspended'].includes(sub.status)) Object.assign(patch, { status: 'active', suspended_at: null });
      if (!sub.started_at) Object.assign(patch, { started_at: agoraIso(), current_period_start: agoraIso(), status: fim > new Date() ? 'active' : sub.status });
      await upd('bot_subscriptions', `id=eq.${sub.id}`, patch, { returning: false });
      return { message: 'Validade atualizada.', audit: { period_end: fim.toISOString() } };
    }
    case 'grant-subscription': {
      const plano = await one('bot_plans', `code=eq.${enc(String(body.plan_code || ''))}&select=*`);
      if (!plano) throw new Erro(404, 'Plano não encontrado.');
      if (!inst.owner_id) throw new Erro(409, 'Instância sem dono.');
      const dias = inteiro(body.days, 1, 400, plano.duration_days);
      const aberta = await assinaturaDa(inst.id);
      if (aberta && ABERTAS.includes(aberta.status)) throw new Erro(409, 'Já existe uma assinatura em andamento. Use "Alterar validade".');
      const agora = new Date();
      await ins('bot_subscriptions', [{ user_id: inst.owner_id, instance_id: inst.id, plan_id: plano.id, status: 'active', price: plano.price, currency: plano.currency, period: plano.period,
        started_at: agora.toISOString(), current_period_start: agora.toISOString(), current_period_end: new Date(agora.getTime() + dias * 86400000).toISOString(),
        gateway: 'manual', last_change_by: admin.id, last_change_by_type: 'admin', last_change_reason: reason || `Concedida pela administração (${dias} dias).` }], { returning: false });
      return { message: `Assinatura ${plano.name} concedida por ${dias} dia(s).`, audit: { plan: plano.code, days: dias } };
    }
    case 'confirm-payment': {
      const pid = uuidValido(body.payment_id);
      if (!pid) throw new Erro(400, 'Pagamento inválido.');
      const pay = await one('bot_payments', `id=eq.${pid}&select=id,subscription_id,is_test,status`);
      const sub = pay ? await one('bot_subscriptions', `id=eq.${pay.subscription_id}&select=instance_id`) : null;
      if (!pay || sub?.instance_id !== inst.id) throw new Erro(404, 'Pagamento não encontrado nesta instância.');
      if (pay.status !== 'pending') throw new Erro(409, 'Este pagamento não está pendente.');
      const motivoPadrao = pay.is_test ? 'Pagamento de teste confirmado pela administração.' : 'Pagamento confirmado manualmente pela administração (fora do gateway).';
      const r = await rpc('bot_confirm_payment', { p_payment: pid, p_actor: admin.id, p_actor_type: 'admin', p_reason: reason || motivoPadrao });
      return { message: 'Pagamento confirmado. Assinatura ativa.', audit: { payment_id: pid, result: r } };
    }
    case 'note': {
      const texto = limparTexto(body.text, 300);
      if (!texto || texto.length < 2) throw new Erro(400, 'Escreva a observação.');
      await ev('note', texto, { visibility: 'admin' });
      return { message: 'Observação registrada (visível só para a administração).' };
    }
    case 'assign-worker': {
      const wid = uuidValido(body.worker_id);
      const w = wid ? await one('worker_nodes', `id=eq.${wid}&select=id,name,status`) : null;
      if (!w) throw new Erro(404, 'Worker não encontrado.');
      if (w.status === 'disabled') throw new Erro(409, 'Este worker está desativado.');
      if (inst.worker_id && inst.worker_id !== w.id) await tarefa('stop');
      await atribuirWorker(inst.id, w.id, { by: admin.id, reason: reason || 'Movida pela administração.' });
      if (inst.phone_hash && inst.desired_state === 'running') await criarTarefa({ workerId: w.id, instanceId: inst.id, type: 'start', by: admin.id, byType: 'admin' });
      await ev('worker_changed', 'Bot movido para outro servidor.');
      return { message: `Instância atribuída a ${w.name}. Atenção: a sessão do WhatsApp fica no servidor antigo; mova a pasta da instância ou conecte o número de novo.`, audit: { worker: w.name } };
    }
    default:
      throw new Erro(400, 'Ação desconhecida.');
  }
}

/* ---------- planos ---------- */
async function adminPlanos() {
  const planos = await sel('bot_plans', 'select=*&order=display_order.asc,price.asc');
  return { plans: planos.map(planoPublico) };
}
async function adminSalvarPlano(req, admin, body) {
  const code = String(body.code || '').toLowerCase();
  if (!/^[a-z0-9_-]{2,40}$/.test(code)) throw new Erro(400, 'Código do plano inválido (use letras minúsculas, números, - ou _).');
  const name = nomeValido(body.name, 2, 60);
  if (!name) throw new Erro(400, 'Nome do plano inválido.');
  const period = ['weekly', 'monthly', 'yearly'].includes(body.period) ? body.period : null;
  if (!period) throw new Erro(400, 'Período inválido.');
  const duration = inteiro(body.duration_days, 1, 400, null);
  if (!duration) throw new Erro(400, 'Duração inválida (1 a 400 dias).');
  const price = Math.round(Number(body.price) * 100) / 100;
  if (!Number.isFinite(price) || price < 0 || price > 100000) throw new Erro(400, 'Preço inválido.');
  const features = Array.isArray(body.features) ? body.features.map((f) => limparTexto(f, 120)).filter(Boolean).slice(0, 12) : [];
  const maxGroups = body.limits?.max_groups == null ? null : inteiro(body.limits.max_groups, 1, 1000, null);
  const row = { code, name, description: body.description ? limparTexto(body.description, 600) : null, period, duration_days: duration, price,
    trial_days: inteiro(body.trial_days ?? 0, 0, 30, 0), features, limits: maxGroups ? { max_groups: maxGroups } : {},
    active: body.active !== false, display_order: inteiro(body.display_order ?? 0, -1000, 1000, 0), updated_by: admin.id };
  const antes = await one('bot_plans', `code=eq.${enc(code)}&select=id,price,active`);
  const salvo = antes
    ? (await upd('bot_plans', `id=eq.${antes.id}`, row))[0]
    : (await ins('bot_plans', [row]))[0];
  await auditar(req, admin, { action: antes ? 'bot.plan_update' : 'bot.plan_create', entity: 'bot_plan', entityId: salvo.id,
    details: { code, price, old_price: antes ? Number(antes.price) : null, active: row.active } });
  return { plan: planoPublico(salvo), message: 'Plano salvo. Assinaturas atuais mantêm o preço contratado até a renovação.' };
}

/* ---------- workers ---------- */
async function adminWorkers() {
  const workers = await sel('worker_nodes', 'select=id,name,kind,region,status,capacity,accepts_new,agent_version,metrics,last_heartbeat_at,last_ip,notes,created_at&order=created_at.asc');
  const ativas = await sel('instance_assignments', 'active=eq.true&select=worker_id');
  const creds = await sel('worker_credentials', 'select=worker_id,created_at,rotated_at');
  const uso = new Map();
  for (const a of ativas) uso.set(a.worker_id, (uso.get(a.worker_id) || 0) + 1);
  return { workers: workers.map((w) => ({ ...w, online: Boolean(w.last_heartbeat_at && Date.now() - new Date(w.last_heartbeat_at).getTime() < WORKER_TIMEOUT_MS),
    instances: uso.get(w.id) || 0, has_token: creds.some((c) => c.worker_id === w.id) })) };
}
async function adminSalvarWorker(req, admin, body) {
  const name = String(body.name || '').trim();
  if (!/^[A-Za-z0-9 _.-]{2,40}$/.test(name)) throw new Erro(400, 'Nome do worker inválido (letras, números, espaço, ponto, - e _).');
  const row = { name, kind: ['phone', 'vps', 'pterodactyl', 'other'].includes(body.kind) ? body.kind : 'phone',
    region: body.region ? limparTexto(body.region, 60) : null, capacity: inteiro(body.capacity ?? 2, 0, 500, 2),
    accepts_new: body.accepts_new !== false, notes: body.notes ? limparTexto(body.notes, 500) : null };
  if (['maintenance', 'disabled', 'offline'].includes(body.status)) row.status = body.status;
  else if (body.status === 'online') row.status = 'offline'; // volta ao normal; o heartbeat marca online
  const id = uuidValido(body.id);
  const salvo = id ? (await upd('worker_nodes', `id=eq.${id}`, row))[0] : (await ins('worker_nodes', [row]))[0];
  if (!salvo) throw new Erro(404, 'Worker não encontrado.');
  await auditar(req, admin, { action: id ? 'bot.worker_update' : 'bot.worker_create', entity: 'worker_node', entityId: salvo.id, details: { name, kind: row.kind, status: row.status || null } });
  return { worker: { id: salvo.id, name: salvo.name }, message: 'Worker salvo.' };
}
async function adminTokenWorker(req, admin, body) {
  const id = uuidValido(body.worker_id);
  const w = id ? await one('worker_nodes', `id=eq.${id}&select=id,name`) : null;
  if (!w) throw new Erro(404, 'Worker não encontrado.');
  const { token, hash } = gerarTokenWorker(w.id);
  await ins('worker_credentials', [{ worker_id: w.id, token_hash: hash, rotated_at: agoraIso() }], { returning: false, onConflict: 'worker_id', merge: true });
  await auditar(req, admin, { action: 'bot.worker_token', entity: 'worker_node', entityId: w.id, details: { name: w.name } });
  // Mostrado uma única vez. Não é salvo em lugar nenhum além do hash.
  return { token, message: 'Copie o token agora: ele não será mostrado de novo. O token anterior deixou de funcionar.' };
}

/* ---------- grupos (admin) ---------- */
async function adminGrupos(req) {
  const id = uuidValido(req.query?.instance_id);
  if (id) {
    const inst = await instanciaOu404(id);
    return { groups: await gruposDaInstancia(inst.id, { admin: true }), instance: { id: inst.id, name: inst.name, is_main: inst.is_main } };
  }
  const grupos = await sel('bot_groups', 'status=eq.active&select=id,ref,name,member_count,instance_id,last_activity_at,last_seen_at,commands_count&order=last_seen_at.desc&limit=300');
  const insts = await sel('bot_instances', 'select=id,name,is_main');
  const nome = new Map(insts.map((i) => [i.id, i]));
  return { groups: grupos.map((g) => ({ ...g, instance_name: nome.get(g.instance_id)?.name || '—', is_main: Boolean(nome.get(g.instance_id)?.is_main) })) };
}
async function adminConfigGrupo(req, admin, body) {
  const inst = await instanciaOu404(body.instance_id);
  const out = await salvarConfigGrupo({ inst, groupId: body.group_id, key: body.key, enabled: body.enabled, actor: admin.id, actorType: 'admin' });
  await auditar(req, admin, { action: 'bot.group_setting', entity: 'bot_group', entityId: body.group_id, targetUser: inst.owner_id, targetInstance: inst.id,
    details: { key: String(body.key || '').slice(0, 50), enabled: body.enabled } });
  return out;
}

async function adminAuditoria(req) {
  const limite = inteiro(req.query?.limit ?? 100, 1, 300, 100);
  const rows = await sel('admin_activity', `or=(action.like.bot.*,target_instance_id.not.is.null)&select=*&order=created_at.desc&limit=${limite}`)
    .catch(() => sel('admin_activity', `action=like.bot.*&select=*&order=created_at.desc&limit=${limite}`));
  const perfis = await perfisPorId(rows.map((r) => r.admin_id));
  return { audit: rows.map((r) => ({ id: r.id, admin: perfis.get(r.admin_id)?.username || perfis.get(r.admin_id)?.email || r.admin_id, action: r.action,
    instance_id: r.target_instance_id || null, user_id: r.target_user_id || null, ip: r.ip || r.details?.ip || null,
    result: r.result || r.details?.result || null, reason: r.reason || r.details?.reason || null, details: r.details, created_at: r.created_at })) };
}

async function adminPagamentos(req) {
  const status = String(req.query?.status || 'pending');
  const limite = inteiro(req.query?.limit ?? 100, 1, 300, 100);
  const filtroStatus = ['pending', 'approved', 'rejected', 'canceled', 'expired', 'refunded'].includes(status) ? status : 'pending';
  const rows = await sel('bot_payments', `status=eq.${enc(filtroStatus)}&select=*&order=created_at.desc&limit=${limite}`);
  const perfis = await perfisPorId(rows.map((r) => r.user_id));
  const planos = await sel('bot_plans', 'select=id,code,name');
  const nomePlano = new Map(planos.map((p) => [p.id, p.name]));
  const subIds = [...new Set(rows.map((r) => r.subscription_id).filter(Boolean))];
  const subs = subIds.length ? await sel('bot_subscriptions', `id=in.(${subIds.map(enc).join(',')})&select=id,instance_id`) : [];
  const instanciaDaSub = new Map(subs.map((s) => [s.id, s.instance_id]));
  return {
    payments: rows.map((p) => ({
      id: p.id, subscription_id: p.subscription_id, instance_id: instanciaDaSub.get(p.subscription_id) || null,
      kind: p.kind, amount: Number(p.amount), currency: p.currency,
      status: p.status, gateway: p.gateway, gateway_status: p.gateway_status || null, is_test: p.is_test,
      plan: nomePlano.get(p.plan_id) || null,
      user: perfis.get(p.user_id)?.username || perfis.get(p.user_id)?.email || p.user_id || 'desconhecido',
      created_at: p.created_at, paid_at: p.paid_at, expires_at: p.expires_at
    }))
  };
}

async function adminSalvarConfig(req, admin, body) {
  const rows = [];
  for (const [key, value] of Object.entries(body)) {
    if (!(key in BOT_SETTINGS_DEFAULTS)) continue;
    let v = value;
    if (['bot_platform_enabled', 'bot_require_approval'].includes(key)) { if (typeof v !== 'boolean') throw new Erro(400, 'Valor inválido.'); }
    else if (key === 'bot_trial_days') v = inteiro(v, 0, 30, null);
    else if (key === 'bot_max_instances_per_user') v = inteiro(v, 1, 10, null);
    else if (key === 'bot_log_retention_days') v = [3, 7, 15, 30].includes(Number(v)) ? Number(v) : null;
    else if (key === 'bot_payment_mode') {
      if (!['manual_test', 'mercadopago'].includes(v)) throw new Erro(400, 'Modo de pagamento inválido.');
      if (v === 'mercadopago' && !gatewayDisponivel('mercadopago').available) throw new Erro(400, 'Configure MERCADOPAGO_ACCESS_TOKEN e MERCADOPAGO_WEBHOOK_SECRET na Vercel antes de ativar o Mercado Pago.');
    }
    if (v === null || v === undefined) throw new Erro(400, `Valor inválido para ${key}.`);
    rows.push({ key, value: v });
  }
  if (!rows.length) throw new Erro(400, 'Nenhuma alteração foi enviada.');
  await ins('site_settings', rows, { returning: false, onConflict: 'key', merge: true });
  await auditar(req, admin, { action: 'bot.settings', entity: 'site_settings', details: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
  return { settings: await lerConfig(), message: 'Configurações salvas.' };
}

// Registra o bot principal só para monitoramento (o worker nunca inicia,
// para ou limpa o bot principal).
async function adminCriarPrincipal(req, admin, body) {
  const existe = await one('bot_instances', 'is_main=eq.true&select=id');
  if (existe) throw new Erro(409, 'O bot principal já está registrado.');
  const wid = uuidValido(body.worker_id);
  const nome = nomeValido(body.name) || 'SORASAKI (principal)';
  const inst = (await ins('bot_instances', [{ owner_id: admin.id, name: nome, is_main: true, management: 'monitor', admin_state: 'approved',
    approved_at: agoraIso(), approved_by: admin.id, desired_state: 'running', op_status: 'offline' }]))[0];
  if (wid) await atribuirWorker(inst.id, wid, { by: admin.id, reason: 'Bot principal (monitoramento).' });
  await auditar(req, admin, { action: 'bot.create_main', entityId: inst.id, targetInstance: inst.id });
  return { instance_id: inst.id, message: 'Bot principal registrado em modo monitoramento. Configure o worker com esse ID (modo "monitor").' };
}
