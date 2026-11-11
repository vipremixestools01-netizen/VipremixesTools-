const PLANES = { '20.00': 30, '100.00': 365 };

exports.handler = async (event) => {
  const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Método no permitido' });
  const { PAYPAL_CLIENT_ID, PAYPAL_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  const base = process.env.PAYPAL_ENV === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  const sbh = { apikey: SUPABASE_SERVICE_KEY };
  try {
    const token = (event.headers.authorization || '').replace('Bearer ', '');
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + token } });
    if (!ur.ok) return json(401, { error: 'Sesión inválida' });
    const user = await ur.json();
    const { orderID } = JSON.parse(event.body || '{}');
    if (!orderID) return json(400, { error: 'Falta el número de orden' });

    const at = await (await fetch(base + '/v1/oauth2/token', { method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(PAYPAL_CLIENT_ID + ':' + PAYPAL_SECRET).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials' })).json();
    const ph = { Authorization: 'Bearer ' + at.access_token, 'Content-Type': 'application/json' };
    let r = await fetch(`${base}/v2/checkout/orders/${orderID}/capture`, { method: 'POST', headers: ph });
    if (!r.ok) r = await fetch(`${base}/v2/checkout/orders/${orderID}`, { headers: ph });
    const order = await r.json();
    const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (!cap || cap.status !== 'COMPLETED' || cap.amount.currency_code !== 'USD') return json(402, { error: 'El pago no está completado' });
    const days = PLANES[cap.amount.value];
    if (!days) return json(400, { error: 'Monto no válido' });

    const ins = await fetch(`${SUPABASE_URL}/rest/v1/payments`, { method: 'POST',
      headers: { ...sbh, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ order_id: orderID, user_id: user.id, amount: Number(cap.amount.value) }) });
    const prof = await (await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=membership_expires`, { headers: sbh })).json();
    const current = prof[0]?.membership_expires ? new Date(prof[0].membership_expires) : new Date(0);
    if (ins.status === 409) return json(200, { expires: current, already: true });
    if (!ins.ok) return json(500, { error: 'No se pudo registrar el pago' });
    const start = current > new Date() ? current : new Date();
    const expires = new Date(start.getTime() + days * 86400000).toISOString();
    const up = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, { method: 'PATCH',
      headers: { ...sbh, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ membership_expires: expires }) });
    if (!up.ok) return json(500, { error: 'Pago recibido pero no se pudo activar; el administrador lo activará' });
    return json(200, { expires });
  } catch (e) {
    return json(500, { error: 'Error del servidor' });
  }
};
