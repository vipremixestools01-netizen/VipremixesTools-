// Netlify Function: puente seguro entre la web, Supabase (usuarios) y Cloudflare R2 (audio).
// Variables necesarias en Netlify: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
// SUPABASE_URL, SUPABASE_SERVICE_KEY. (SUPABASE_ANON_KEY es opcional.)
const crypto = require('crypto');

const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// URL prefirmada (AWS Signature V4, compatible con S3 y R2).
function signUrl({ host, path, region = 'auto', method = 'GET', expires = 3600, extra = {}, now = new Date(), accessKey, secretKey }) {
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amz.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const q = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
    ...extra,
  };
  const qs = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join('&');
  const canonical = [method, path, qs, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretKey, date), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return `https://${host}${path}?${qs}&X-Amz-Signature=${signature}`;
}

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

const ALLOWED_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'aif', 'aiff'];
const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', mp4: 'audio/mp4', aif: 'audio/aiff', aiff: 'audio/aiff' };
const ANON_FALLBACK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcGVrbGFlZ3p2bWVpaWtjbXJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0MzQ5OTUsImV4cCI6MjExMDAxMDk5NX0.Ck60KVUIhFsIa_eiC2aAfwOQHsEUUD7lkg-W6nQeCRI';

async function getUser(token) {
  const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY || ANON_FALLBACK, Authorization: `Bearer ${token}` },
  });
  return r.ok ? r.json() : null;
}

async function getProfile(id) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=is_admin,membership_expires`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY },
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

exports.signUrl = signUrl;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Método no permitido' });

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Faltan variables de entorno en Netlify (R2_* o SUPABASE_*).' });
  }

  const token = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Debes iniciar sesión.' });
  const user = await getUser(token);
  if (!user || !user.id) return json(401, { error: 'Sesión inválida. Vuelve a iniciar sesión.' });
  const profile = (await getProfile(user.id)) || {};
  const isAdmin = !!profile.is_admin;
  const isMember = isAdmin || (profile.membership_expires && new Date(profile.membership_expires) > new Date());

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Solicitud inválida.' }); }

  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const sign = (key, method, expires, extra) =>
    signUrl({ host, path: `/${R2_BUCKET}/${enc(key)}`, method, expires, extra, accessKey: R2_ACCESS_KEY_ID, secretKey: R2_SECRET_ACCESS_KEY });
  const validKey = (k) => typeof k === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(k);

  switch (body.action) {
    case 'upload': {
      if (!isAdmin) return json(403, { error: 'Solo el administrador puede subir.' });
      let ext = String(body.ext || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!ALLOWED_EXT.includes(ext)) ext = 'mp3';
      const key = `${crypto.randomUUID()}.${ext}`;
      return json(200, { key, url: sign(key, 'PUT', 3600), contentType: MIME[ext] });
    }
    case 'play': {
      if (!validKey(body.key)) return json(400, { error: 'Archivo inválido.' });
      return json(200, { url: sign(body.key, 'GET', 3600) });
    }
    case 'download': {
      if (!validKey(body.key)) return json(400, { error: 'Archivo inválido.' });
      if (!isMember) return json(403, { error: 'Necesitas una membresía activa para descargar.' });
      const name = String(body.filename || 'remix.mp3').replace(/[\\/"\u0000-\u001f]/g, '').slice(0, 150) || 'remix.mp3';
      const ascii = name.replace(/[^\x20-\x7e]/g, '_');
      const disposition = `attachment; filename="${ascii}"; filename*=UTF-8''${enc(name)}`;
      return json(200, { url: sign(body.key, 'GET', 120, { 'response-content-disposition': disposition }) });
    }
    case 'delete': {
      if (!isAdmin) return json(403, { error: 'Solo el administrador puede borrar.' });
      if (!validKey(body.key)) return json(400, { error: 'Archivo inválido.' });
      const r = await fetch(sign(body.key, 'DELETE', 60), { method: 'DELETE' });
      if (!r.ok && r.status !== 404) return json(502, { error: 'R2 respondió ' + r.status });
      return json(200, { ok: true });
    }
    default:
      return json(400, { error: 'Acción desconocida.' });
  }
};
