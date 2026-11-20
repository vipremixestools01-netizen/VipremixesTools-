// Netlify Function: busca en Internet el género de una canción (iTunes, Deezer y MusicBrainz)
// y lo traduce a la lista de géneros del portal. Solo el administrador puede usarla.
// No necesita variables de entorno ni claves de API (las tres fuentes son públicas).
//
// MB_USER_AGENT lleva el correo de contacto del portal; MusicBrainz lo pide para identificar la aplicación.
const SUPABASE_URL = 'https://' + 'hcyuwwwwwdqzxjrfqcyf' + '.supabase' + '.co';
const SUPABASE_KEY = 'sb_publishable_' + 'Y7FUvF1VdDsdbXPQpalQcA_djd2cIpU';
const MB_USER_AGENT = 'VIPREMIXESTOOLS/1.0 ( vipremixestools01@gmail.com )';

const reply = (status, obj) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

// Verifica la sesión de Supabase y devuelve { id, isAdmin } (misma lógica que audio.js)
async function getUser(event) {
  const auth = event.headers.authorization || event.headers.Authorization || '';
  if (!/^Bearer\s+\S+/.test(auth)) return null;
  const h = { apikey: SUPABASE_KEY, Authorization: auth };
  const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: h });
  if (!ur.ok) return null;
  const u = await ur.json();
  if (!u || !u.id) return null;
  const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=is_admin`, { headers: h });
  const rows = pr.ok ? await pr.json() : [];
  return { id: u.id, isAdmin: !!(rows[0] && rows[0].is_admin) };
}

// ---------- Utilidades de texto ----------
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const toks = s => norm(s).split(' ').filter(w => w.length > 1);
function similar(q, r) {
  const a = toks(q), b = new Set(toks(r));
  if (!a.length || !b.size) return false;
  return a.filter(w => b.has(w)).length / a.length >= 0.6;
}
const either = (x, y) => similar(x, y) || similar(y, x);
// "Bad Bunny & Jhay Cortez ft. X" -> "Bad Bunny"
const firstArtist = a => String(a || '').split(/\s*(?:&|,|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bx\b|\by\b|\band\b|\+)\s*/i)[0] || '';
const clean = s => String(s || '').replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

async function getJson(url, ms = 3500, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', ...headers } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// ---------- Traducción de etiquetas externas a la lista de géneros del portal ----------
// strength: 'exact' = nombra el género directamente; 'broad' = es una pista más general (p. ej. "Latin Urban").
// "Latino" nunca se devuelve: si solo hay etiquetas genéricas (Pop latino, Música latina), la canción sigue pendiente.
const RULES = [
  [/afro\s*house/, 'Afro House', 'exact'],
  [/tech\s*house/, 'Tech House', 'exact'],
  [/latin\s*house/, 'Latin House', 'exact'],
  [/amapian/, 'Amapiano', 'exact'],
  [/moombah/, 'Moombahton', 'exact'],
  [/bachata/, 'Bachata', 'exact'],
  [/cubaton/, 'Cubatón', 'exact'],
  [/cumbia/, 'Cumbia', 'exact'],
  [/dancehall/, 'Dancehall', 'exact'],
  [/dembow|dembou/, 'Dembow', 'exact'],
  [/guaracha|aleteo|zapateo/, 'Guaracha', 'exact'],
  [/merengue/, 'Merengue', 'exact'],
  [/tipico/, 'Típico', 'exact'],
  [/salsa/, 'Salsa', 'exact'],
  [/reggaeton|regueton|perreo/, 'Reggaeton', 'exact'],
  [/latin\s*urban|urbano\s*latino|musica\s*urbana|urban\s*latino|latin\s*trap|trap\s*latino/, 'Reggaeton', 'broad'],
  [/reggae/, 'Reggae', 'exact'],
  [/hip\s*hop|\brap\b/, 'Hip Hop', 'exact'],
  [/techno/, 'Techno', 'exact'],
  [/\btrap\b/, 'Trap', 'exact'],
  [/\brock\b/, 'Rock', 'exact'],
  [/\bhouse\b/, 'House', 'exact'],
  [/electro|\bedm\b|\bdance\b/, 'Electro', 'broad']
];
function mapGenre(raw) {
  const t = norm(raw);
  if (!t) return null;
  for (const [re, genre, strength] of RULES) if (re.test(t)) return { genre, strength };
  return null;
}

// ---------- Fuentes ----------
async function fromItunes(artist, title) {
  const term = encodeURIComponent(`${artist} ${title}`);
  const j = await getJson(`https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=6`);
  const hit = (j.results || []).find(r => either(firstArtist(artist), r.artistName) && either(title, r.trackName));
  return hit && hit.primaryGenreName ? [{ source: 'iTunes', raw: hit.primaryGenreName }] : [];
}

async function fromDeezer(artist, title) {
  const q = encodeURIComponent(`artist:"${clean(firstArtist(artist))}" track:"${clean(title)}"`);
  const j = await getJson(`https://api.deezer.com/search?q=${q}&limit=6`);
  const hit = (j.data || []).find(r => r.artist && either(firstArtist(artist), r.artist.name) && either(title, r.title));
  if (!hit || !hit.album || !hit.album.id) return [];
  const al = await getJson(`https://api.deezer.com/album/${hit.album.id}`);
  return ((al.genres && al.genres.data) || []).map(g => ({ source: 'Deezer', raw: g.name }));
}

async function fromMusicBrainz(artist, title) {
  const query = encodeURIComponent(`recording:"${clean(title)}" AND artist:"${clean(firstArtist(artist))}"`);
  const j = await getJson(`https://musicbrainz.org/ws/2/recording/?query=${query}&fmt=json&limit=4`, 3500, { 'User-Agent': MB_USER_AGENT });
  const hit = (j.recordings || []).find(r => either(title, r.title) &&
    (r['artist-credit'] || []).some(c => either(firstArtist(artist), (c.artist && c.artist.name) || c.name)));
  if (!hit) return [];
  return (hit.tags || []).sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 6).map(t => ({ source: 'MusicBrainz', raw: t.name }));
}

// ---------- Decisión ----------
function decide(found) {
  const evidence = found.map(f => `${f.source}: ${f.raw}`);
  const votes = new Map(); // género -> { sources:Set, exact:boolean }
  for (const f of found) {
    const m = mapGenre(f.raw);
    if (!m) continue;
    const v = votes.get(m.genre) || { sources: new Set(), exact: false };
    v.sources.add(f.source);
    if (m.strength === 'exact') v.exact = true;
    votes.set(m.genre, v);
  }
  if (!votes.size) return { genre: null, confidence: null, evidence };
  const ranked = [...votes.entries()].sort((a, b) =>
    (b[1].sources.size - a[1].sources.size) || ((b[1].exact ? 1 : 0) - (a[1].exact ? 1 : 0)));
  const [genre, v] = ranked[0];
  const n = v.sources.size;
  const confidence = n >= 2 && v.exact ? 'alta' : (n >= 2 || v.exact) ? 'media' : 'baja';
  return { genre, confidence, evidence };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Método no permitido' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Solicitud inválida' }); }
  const artist = clean(body.artist), title = clean(body.title);
  if (!artist || !title) return reply(400, { error: 'Faltan artista o título' });

  let user;
  try { user = await getUser(event); } catch (e) { return reply(502, { error: 'No se pudo verificar la sesión (' + e.message + ')' }); }
  if (!user) return reply(401, { error: 'Debes iniciar sesión.' });
  if (!user.isAdmin) return reply(403, { error: 'Solo el administrador puede usar esta herramienta.' });

  const results = await Promise.allSettled([fromItunes(artist, title), fromDeezer(artist, title), fromMusicBrainz(artist, title)]);
  const found = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
  const failed = results.filter(r => r.status === 'rejected').length;
  return reply(200, { ...decide(found), sourcesFailed: failed });
};

exports._mapGenre = mapGenre;
exports._decide = decide;
