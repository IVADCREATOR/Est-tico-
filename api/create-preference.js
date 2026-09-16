import { supabaseRequest, getUserFromAccessToken, bearerToken, readJsonBody, sendJson, serverError, originAllowed, rateLimit, clientIp } from './_supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, message: 'Essa ação não funciona desse jeito. Atualize a página e tente de novo.' });
  }
  if (!originAllowed(req)) return sendJson(res, 403, { ok: false, message: 'Ação não permitida.' });
  if (!rateLimit(`pref-ip:${clientIp(req)}`, 20, 60_000)) return sendJson(res, 429, { ok: false, message: 'Muitas tentativas seguidas. Aguarde um instante.' });

  try {
    const user = await getUserFromAccessToken(bearerToken(req));
    if (!user) return sendJson(res, 401, { ok: false, message: 'Você precisa entrar na sua conta para continuar.' });
    if (!rateLimit(`pref:${user.id}`, 6, 60_000)) return sendJson(res, 429, { ok: false, message: 'Muitas tentativas seguidas. Aguarde um instante.' });

    const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (!accessToken) return sendJson(res, 503, { ok: false, message: 'O pagamento não está disponível no momento.' });

    const body = readJsonBody(req);
    if (!body) return sendJson(res, 400, { ok: false, message: 'Não foi possível iniciar esta compra.' });

    const planId = Number(body.plan_id);
    const groupId = Number(body.group_id);
    const couponCode = String(body.coupon_code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40);
    if (!Number.isInteger(planId) || !Number.isInteger(groupId)) {
      return sendJson(res, 400, { ok: false, message: 'Selecione um plano e um grupo válidos.' });
    }

    const plans = await supabaseRequest(`/rest/v1/promotion_plans?id=eq.${planId}&active=eq.true&select=id,name,description,price,duration_days`);
    const plan = plans?.[0];
    if (!plan) return sendJson(res, 404, { ok: false, message: 'Este plano não está disponível.' });

    let coupon = null;
    let discount = 0;
    if (couponCode) {
      const coupons = await supabaseRequest(`/rest/v1/coupons?code=eq.${encodeURIComponent(couponCode)}&active=eq.true&select=id,code,discount_type,discount_value,starts_at,expires_at,max_uses,uses_count,max_uses_per_user,plan_id`);
      coupon = coupons?.[0];
      if (!coupon) return sendJson(res, 400, { ok: false, message: 'Cupom inválido ou indisponível.' });
      const now = Date.now();
      if (new Date(coupon.starts_at).getTime() > now || (coupon.expires_at && new Date(coupon.expires_at).getTime() <= now)) return sendJson(res, 400, { ok: false, message: 'Este cupom não está válido neste momento.' });
      if (coupon.max_uses != null && Number(coupon.uses_count) >= Number(coupon.max_uses)) return sendJson(res, 400, { ok: false, message: 'Este cupom atingiu o limite de utilizações.' });
      if (coupon.plan_id != null && Number(coupon.plan_id) !== plan.id) return sendJson(res, 400, { ok: false, message: 'Este cupom não se aplica a este plano.' });
      const previous = await supabaseRequest(`/rest/v1/coupon_redemptions?coupon_id=eq.${coupon.id}&user_id=eq.${encodeURIComponent(user.id)}&select=id&limit=100`);
      if ((previous || []).length >= Number(coupon.max_uses_per_user || 1)) return sendJson(res, 400, { ok: false, message: 'Você já atingiu o limite deste cupom.' });
      discount = coupon.discount_type === 'percent'
        ? Number((Number(plan.price) * Number(coupon.discount_value) / 100).toFixed(2))
        : Number(coupon.discount_value);
      discount = Math.min(Number(plan.price), Math.max(0, discount));
    }
    const finalAmount = Number((Number(plan.price) - discount).toFixed(2));
    if (finalAmount <= 0) return sendJson(res, 400, { ok: false, message: 'O desconto não pode deixar o pedido sem valor.' });

    const groups = await supabaseRequest(`/rest/v1/groups?id=eq.${groupId}&owner_id=eq.${encodeURIComponent(user.id)}&select=id,name,status`);
    const group = groups?.[0];
    if (!group) return sendJson(res, 404, { ok: false, message: 'Grupo não encontrado na sua conta.' });
    if (group.status !== 'approved') return sendJson(res, 409, { ok: false, message: 'O grupo precisa estar aprovado antes de receber destaque.' });

    const orders = await supabaseRequest('/rest/v1/orders', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: user.id,
        group_id: group.id,
        plan_id: plan.id,
        amount: finalAmount,
        coupon_id: coupon?.id || null,
        discount_amount: discount,
        status: 'pending',
        payment_provider: 'mercadopago'
      })
    });
    const order = orders?.[0];
    if (!order) throw new Error('order creation failed');

    const origin = String(process.env.SITE_URL || 'https://www.sorasakiplatform.store').replace(/\/+$/, '');
    const preferencePayload = {
      items: [{
        id: String(plan.id),
        title: `Sorasaki — ${plan.name}`,
        description: plan.description,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: finalAmount
      }],
      external_reference: String(order.id),
      notification_url: `${origin}/api/mercadopago-webhook`,
      back_urls: {
        success: `${origin}/grupos?pagamento=sucesso&pedido=${order.id}`,
        pending: `${origin}/grupos?pagamento=pendente&pedido=${order.id}`,
        failure: `${origin}/grupos?pagamento=erro&pedido=${order.id}`
      },
      auto_return: 'approved',
      metadata: {
        order_id: String(order.id),
        user_id: user.id,
        group_id: String(group.id),
        plan_id: String(plan.id),
        coupon_id: coupon?.id ? String(coupon.id) : ''
      }
    };

    const mp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(preferencePayload)
    });

    const mpData = await mp.json().catch(() => ({}));
    if (!mp.ok || !mpData.id || !mpData.init_point) {
      console.error('create-preference: Mercado Pago recusou a preferência', mp.status, mpData?.message || '');
      await supabaseRequest(`/rest/v1/orders?id=eq.${order.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'cancelled' })
      }).catch(() => {});
      return sendJson(res, 502, { ok: false, message: 'Não foi possível iniciar o pagamento. Tente novamente em alguns instantes.' });
    }

    await supabaseRequest(`/rest/v1/orders?id=eq.${order.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ payment_id: String(mpData.id) })
    });

    return sendJson(res, 200, { ok: true, checkout_url: mpData.init_point });
  } catch (error) {
    return serverError(res, error, 'create-preference', 'Não foi possível iniciar o pagamento. Tente novamente.');
  }
}
