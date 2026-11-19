// Netlify Function: entrega y gestiona audios alojados en Backblaze B2 (solo los que empiezan por "b2/").
// Las canciones antiguas siguen en Supabase y no pasan por aquí.
// Variables de entorno: B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_ENDPOINT, SUPABASE_SERVICE_ROLE_KEY
const crypto = require('crypto');

const SUPABASE_URL = 'https://' + 'hcyuwwwwwdqzxjrfqcyf' + '.supabase' + '.co';
const SUPABASE_KEY = 'sb_publishable_' + 'Y7FUvF1VdDsdbXPQpalQcA_djd2cIpU';

// Límite de descarga por usuario al mes (los administradores no tienen límite)
const LIMITE_BYTES = 10 * 1024 ** 3; // 10 GB

const PATH_RE = /^b2\/[A-Za-z0-9][A-Za-z0-9._-]*\.(mp3|wav|m4a|aac|flac|ogg|mp4)$/i;

const sha256hex = d => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = p => p.split('/').map(enc).join('/');

function signingKey(secret, date, region) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, date), region), 's3'), 'aws4_request');
}

// URL prefirmada (SigV4 en la query) para GET o PUT
function presign({ method, host, path, extraQuery = {}, accessKey, secret, region, expires, now = new Date() }) {
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amz.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const q = {
    ...extraQuery,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host'
  };
  const qs = Object.keys(q).sort().map(k => `${enc(k)}=${enc(q[k])}`).join('&');
  const canonical = [method, encPath(path), qs, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amz, scope, sha256hex(canonical)].join('\n');
  const sig = crypto.createHmac('sha256', signingKey(secret, date, region)).update(sts).digest('hex');
  return `https://${host}${encPath(path)}?${qs}&X-Amz-Signature=${sig}`;
}

// Petición firmada con cabeceras (para DELETE y HEAD desde el servidor)
async function signedRequest({ method, host, path, accessKey, secret, region }) {
  const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amz.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const payload = sha256hex('');
  const headers = `host:${host}\nx-amz-content-sha256:${payload}\nx-amz-date:${amz}\n`;
  const signed = 'host;x-amz-content-sha256;x-amz-date';
  const canonical = [method, encPath(path), '', headers, signed, payload].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amz, scope, sha256hex(canonical)].join('\n');
  const sig = crypto.createHmac('sha256', signingKey(secret, date, region)).update(sts).digest('hex');
  return fetch(`https://${host}${encPath(path)}`, {
    method,
    headers: {
      'x-amz-date': amz,
      'x-amz-content-sha256': payload,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed}, Signature=${sig}`
    }
  });
}

function b2Config() {
  const accessKey = (process.env.B2_KEY_ID || process.env.B2_APPLICATION_KEY_ID || '').trim();
  const secret = (process.env.B2_APP_KEY || process.env.B2_APPLICATION_KEY || '').trim();
  const bucket = (process.env.B2_BUCKET || '').trim();
  const host = String(process.env.B2_ENDPOINT || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');

  // Solo se muestran NOMBRES de variables, nunca sus valores.
  const missing = [];
  if (!accessKey) missing.push('B2_KEY_ID');
  if (!secret) missing.push('B2_APP_KEY');
  if (!bucket) missing.push('B2_BUCKET');
  if (!host) missing.push('B2_ENDPOINT');
  if (missing.length) throw new Error('Faltan variables de Backblaze en Netlify: ' + missing.join(', '));

  const m = host.match(/^s3\.([^.]+)\./);
  return { accessKey, secret, bucket, host, region: m ? m[1] : 'us-east-005' };
}

const reply = (status, obj) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

// Verifica la sesión de Supabase y devuelve { id, isAdmin, member }
async function getUser(event) {
  const auth = event.headers.authorization || event.headers.Authorization || '';
  if (!/^Bearer\s+\S+/.test(auth)) return null;
  const h = { apikey: SUPABASE_KEY, Authorization: auth };
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: h });
  if (!ur.ok) return null;
  const u = await ur.json();
  if (!u || !u.id) return null;
  const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=is_admin,membership_expires`, { headers: h });
  const rows = pr.ok ? await pr.json() : [];
  const p = rows[0] || {};
  const isAdmin = !!p.is_admin;
  const member = isAdmin || !!(p.membership_expires && new Date(p.membership_expires) > new Date());
  return { id: u.id, isAdmin, member };
}

// Motivo del último fallo (se muestra en el mensaje de error para poder diagnosticar)
let lastErr = '';

// Tamaño del archivo en bytes. Primero HEAD firmado; si falla, GET firmado pidiendo solo 1 byte.
// Devuelve 0 si no se pudo saber.
async function tamanoArchivo(base) {
  try {
    const r = await signedRequest({ ...base, method: 'HEAD' });
    if (r.ok) {
      const n = parseInt(r.headers.get('content-length') || '0', 10) || 0;
      if (n) return n;
    } else { lastErr = 'Backblaze HEAD ' + r.status; console.error('[audio]', lastErr, base.path); }
  } catch (e) { lastErr = 'Backblaze HEAD error: ' + e.message; console.error('[audio]', lastErr); }
  try {
    const url = presign({ ...base, method: 'GET', expires: 60 });
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    const cr = r.headers.get('content-range') || ''; // "bytes 0-0/12345"
    const m = cr.match(/\/(\d+)\s*$/);
    if (m) return parseInt(m[1], 10) || 0;
    const n = parseInt(r.headers.get('content-length') || '0', 10) || 0;
    if (r.ok && r.status === 200 && n) return n;
    lastErr = 'Backblaze GET ' + r.status;
    console.error('[audio]', lastErr, base.path);
  } catch (e) { lastErr = 'Backblaze GET error: ' + e.message; console.error('[audio]', lastErr); }
  return 0;
}

// Descuenta bytes del cupo mensual del usuario. Devuelve true (permitido), false (cupo agotado) o null (error).
async function consumirCupo(userId, bytes) {
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!key) { lastErr = 'falta SUPABASE_SERVICE_ROLE_KEY'; console.error('[audio] ' + lastErr); return null; }
  try {
    const headers = { apikey: key, 'Content-Type': 'application/json' };
    if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`; // solo llaves JWT antiguas
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/consume_download`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_user: userId, p_bytes: bytes, p_limit: LIMITE_BYTES })
    });
    if (!r.ok) { lastErr = 'Supabase ' + r.status + ' ' + (await r.text()).slice(0, 120); console.error('[audio]', lastErr); return null; }
    return (await r.json()) === true;
  } catch (e) { lastErr = 'Supabase error: ' + e.message; console.error('[audio]', lastErr); return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Método no permitido' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Solicitud inválida' }); }
  const { action, path, filename } = body;

  if (!PATH_RE.test(String(path || '')) || String(path).includes('..')) return reply(400, { error: 'Ruta no válida' });

  let user;
  try { user = await getUser(event); } catch (e) { return reply(502, { error: 'No se pudo verificar la sesión (' + e.message + ')' }); }
  if (!user) return reply(401, { error: 'Debes iniciar sesión.' });

  let cfg;
  try { cfg = b2Config(); } catch (e) { console.error('[audio] ' + e.message); return reply(500, { error: e.message }); }
  const objPath = `/${cfg.bucket}/${path}`;
  const base = { host: cfg.host, path: objPath, accessKey: cfg.accessKey, secret: cfg.secret, region: cfg.region };

  if (action === 'play') {
    return reply(200, { url: presign({ ...base, method: 'GET', expires: 3600 }) });
  }
  if (action === 'download') {
    if (!user.member) return reply(403, { error: 'Necesitas una membresía activa para descargar.' });

    // Límite mensual por usuario (el administrador no tiene límite)
    if (!user.isAdmin) {
      const bytes = await tamanoArchivo(base);
      if (!bytes) {
        console.error('[audio] No se pudo leer el tamaño; se permite la descarga sin contar cupo. ' + lastErr);
      } else {
        const permitido = await consumirCupo(user.id, bytes);
        if (permitido === null) console.error('[audio] Cupo no disponible; se permite la descarga. ' + lastErr);
        else if (!permitido) return reply(429, { error: 'Llegaste a tu límite de 10 GB de descargas este mes. Se reinicia el día 1.' });
      }
    }

    const safe = String(filename || path.split('/').pop()).replace(/[\r\n"\\\/]/g, '_').slice(0, 180);
    const cd = `attachment; filename="${safe.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${enc(safe)}`;
    return reply(200, { url: presign({ ...base, method: 'GET', expires: 120, extraQuery: { 'response-content-disposition': cd } }) });
  }
  if (action === 'upload') {
    if (!user.isAdmin) return reply(403, { error: 'Solo el administrador puede subir.' });
    return reply(200, { url: presign({ ...base, method: 'PUT', expires: 3600 }) });
  }
  if (action === 'delete') {
    if (!user.isAdmin) return reply(403, { error: 'Solo el administrador puede borrar.' });
    try {
      const r = await signedRequest({ ...base, method: 'DELETE' });
      if (!r.ok && r.status !== 404) return reply(502, { error: 'Backblaze respondió ' + r.status });
    } catch (e) { return reply(502, { error: 'No se pudo contactar a Backblaze' }); }
    return reply(200, { ok: true });
  }
  return reply(400, { error: 'Acción no válida' });
};

exports._presign = presign;
