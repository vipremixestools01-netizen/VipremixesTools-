const PLANES = {
  '12.99': 30,
  '130.00': 365
};

exports.handler = async (event) => {
  const json = (code, obj) => ({
    statusCode: code,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(obj)
  });

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Método no permitido' });
  }

  const {
    PAYPAL_CLIENT_ID,
    PAYPAL_SECRET,
    PAYPAL_ENV,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY
  } = process.env;

  if (
    !PAYPAL_CLIENT_ID ||
    !PAYPAL_SECRET ||
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_KEY
  ) {
    return json(500, {
      error: 'Faltan configuraciones del servidor'
    });
  }

  const base = PAYPAL_ENV === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';

  const sbh = {
    apikey: SUPABASE_SERVICE_KEY
  };

  try {
    // 1. Verificar la sesión del usuario
    const authorization =
      event.headers.authorization ||
      event.headers.Authorization ||
      '';

    const token = authorization.replace(/^Bearer\s+/i, '');

    if (!token) {
      return json(401, { error: 'Sesión no válida' });
    }

    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${token}`
      }
    });

    if (!ur.ok) {
      return json(401, { error: 'Sesión inválida o expirada' });
    }

    const user = await ur.json();

    if (!user.id) {
      return json(401, { error: 'No se pudo identificar al usuario' });
    }

    // 2. Recibir el número de orden
    let body;

    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Solicitud inválida' });
    }

    const orderID = body.orderID;

    if (!orderID || typeof orderID !== 'string') {
      return json(400, { error: 'Falta el número de orden' });
    }

    // 3. Obtener acceso a PayPal
    const tokenResponse = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(
            `${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`
          ).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });

    const paypalToken = await tokenResponse.json();

    if (!tokenResponse.ok || !paypalToken.access_token) {
      return json(502, {
        error: 'No se pudo conectar con PayPal'
      });
    }

    const ph = {
      Authorization: `Bearer ${paypalToken.access_token}`,
      'Content-Type': 'application/json'
    };

    // 4. Capturar el pago
    let response = await fetch(
      `${base}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`,
      {
        method: 'POST',
        headers: ph
      }
    );

    let order = await response.json();

    // Si ya fue capturado, consultar la orden existente
    if (!response.ok) {
      const check = await fetch(
        `${base}/v2/checkout/orders/${encodeURIComponent(orderID)}`,
        { headers: ph }
      );

      order = await check.json();

      if (!check.ok) {
        return json(402, {
          error: 'No se pudo verificar el pago en PayPal'
        });
      }
    }

    // 5. Verificar que el pago esté completado
    const capture =
      order.purchase_units?.[0]?.payments?.captures?.[0];

    if (
      !capture ||
      capture.status !== 'COMPLETED' ||
      capture.amount?.currency_code !== 'USD'
    ) {
      return json(402, {
        error: 'El pago todavía no está completado'
      });
    }

    // 6. Verificar que el importe corresponda a un plan
    const amount = Number(capture.amount.value);
    const amountKey = amount.toFixed(2);
    const days = PLANES[amountKey];

    if (!days) {
      return json(400, {
        error: 'Monto no válido. Verifica el precio del plan.'
      });
    }

    // 7. Consultar si esta orden ya fue registrada
    const existingResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/payments?order_id=eq.${encodeURIComponent(orderID)}&select=order_id,user_id`,
      { headers: sbh }
    );

    if (!existingResponse.ok) {
      return json(500, {
        error: 'No se pudo verificar el registro del pago'
      });
    }

    const existingPayments = await existingResponse.json();

    if (existingPayments.length > 0) {
      if (existingPayments[0].user_id !== user.id) {
        return json(403, {
          error: 'Esta orden pertenece a otro usuario'
        });
      }

      const profileResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=membership_expires`,
        { headers: sbh }
      );

      const profiles = await profileResponse.json();

      return json(200, {
        expires: profiles[0]?.membership_expires || null,
        already: true
      });
    }

    // 8. Consultar la membresía actual
    const profileResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=membership_expires`,
      { headers: sbh }
    );

    if (!profileResponse.ok) {
      return json(500, {
        error: 'No se pudo consultar la membresía'
      });
    }

    const profiles = await profileResponse.json();

    if (!profiles || profiles.length === 0) {
      return json(404, {
        error: 'No se encontró el perfil del usuario'
      });
    }

    const current = profiles[0].membership_expires
      ? new Date(profiles[0].membership_expires)
      : new Date(0);

    const now = new Date();
    const start = current > now ? current : now;

    const expires = new Date(
      start.getTime() + days * 86400000
    ).toISOString();

    // 9. Activar la membresía
    const updateResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`,
      {
        method: 'PATCH',
        headers: {
          ...sbh,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          membership_expires: expires
        })
      }
    );

    if (!updateResponse.ok) {
      return json(500, {
        error: 'Pago recibido, pero no se pudo activar la membresía. Contacta al administrador.'
      });
    }

    // 10. Registrar el pago
    const insertResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/payments`,
      {
        method: 'POST',
        headers: {
          ...sbh,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          order_id: orderID,
          user_id: user.id,
          amount: amount
        })
      }
    );

    if (!insertResponse.ok) {
      return json(500, {
        error: 'La membresía fue actualizada, pero no se pudo guardar el registro del pago. Contacta al administrador.'
      });
    }

    // 11. Confirmar activación
    return json(200, {
      success: true,
      expires: expires,
      message: 'Pago confirmado y membresía activada correctamente'
    });

  } catch (error) {
    console.error('Error PayPal:', error);

    return json(500, {
      error: 'Error interno al procesar el pago. Intenta nuevamente.'
    });
  }
};
