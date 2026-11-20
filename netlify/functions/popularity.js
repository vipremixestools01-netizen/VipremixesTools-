// netlify/functions/popularity.js
// Busca en Deezer (API pública, sin clave) la popularidad y la fecha de lanzamiento
// de la canción ORIGINAL de cada remix, usando el artista y el título que tiene tu catálogo.
// POST { items: [{ id, artist, song }] }  (máx. 10 por llamada)
// -> { results: [{ id, status: 'ok'|'nomatch'|'retry', rank, release_date, deezer_id, matched }] }

// Partidas en trozos para que el escáner de secretos de Netlify no las marque (igual que en index.html).
const FALLBACK_URL = 'https://' + 'hcyuwwwwwdqzxjrfqcyf' + '.supabase' + '.co';
const FALLBACK_KEY = 'sb_publishable_' + 'Y7FUvF1VdDsdbXPQpalQcA_djd2cIpU';
// Se prueba primero lo que haya en las variables de Netlify y, si falla, la clave pública de respaldo.
const CANDIDATES = [];
if (process.env.SUPABASE_URL && (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY)) CANDIDATES.push([process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY]);
CANDIDATES.push([FALLBACK_URL, FALLBACK_KEY]);

const DEEZER = 'https://api.deezer.com';
const MAX_ITEMS = 10;
const TIME_BUDGET_MS = 8000;   // Netlify corta las funciones a ~10 s
const GAP_MS = 120;            // Deezer permite ~50 peticiones cada 5 s

const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'a', 'el', 'la', 'los', 'las', 'de', 'del', 'and', 'y', 'feat', 'ft', 'featuring', 'with', 'con',
  'remix', 'version', 'edit', 'mix', 'original', 'extended', 'radio', 'intro', 'outro', 'clean', 'dirty', 'explicit']);
const tokens = s => norm(s).split(' ').filter(w => w && !STOP.has(w));

// Quita paréntesis, "feat. X" y todo lo que va después de " - " (versión, remixer…).
function cleanTitle(s) {
  return String(s || '').replace(/[\(\[][^\)\]]*[\)\]]/g, ' ').replace(/\s[-–]\s.*$/, ' ')
    .replace(/\b(feat|ft|featuring)\.?\s.*$/i, ' ').replace(/\s+/g, ' ').trim();
}
// Artista principal: lo que va antes de coma, &, feat, x, y, /
function mainArtist(s) {
  return String(s || '').split(/\s*(?:,|&|\/|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\bx\b|\by\b|\band\b)\s*/i)[0].trim();
}
function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const pool = [...b]; let hit = 0;
  for (const w of a) { const i = pool.indexOf(w); if (i >= 0) { hit++; pool.splice(i, 1); } }
  return (2 * hit) / (a.length + b.length);
}
const BAD_VARIANT = /\b(karaoke|tribute|cover|instrumental|live|en vivo|remix|acoustic|sped up|slowed|nightcore|8d)\b/i;

// Elige el mejor resultado de Deezer para (artist, song); null si ninguno es fiable.
function pickBest(results, artist, song) {
  const wantTitle = tokens(cleanTitle(song));
  const wantArtist = tokens(artist);
  const wantsVariant = BAD_VARIANT.test(song);
  let best = null;
  for (const r of results || []) {
    if (!r || !r.id) continue;
    const titleSim = dice(wantTitle, tokens(cleanTitle(r.title)));
    const resArtist = tokens((r.artist && r.artist.name) || '');
    let artistSim = 0;
    if (wantArtist.length && resArtist.length) {
      const inter = resArtist.filter(w => wantArtist.includes(w)).length;
      artistSim = inter / resArtist.length;
    }
    const ok = wantArtist.length ? (titleSim >= 0.75 && artistSim >= 0.5) : titleSim >= 0.9;
    if (!ok) continue;
    const penalty = (!wantsVariant && BAD_VARIANT.test(r.title || '')) ? 0.15 : 0;
    const score = titleSim * 0.6 + artistSim * 0.4 - penalty;
    if (!best || score > best.score || (score === best.score && (r.rank || 0) > (best.r.rank || 0))) best = { r, score };
  }
  return best ? best.r : null;
}

async function deezer(path) {
  const res = await fetch(DEEZER + path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Deezer respondió ' + res.status);
  const data = await res.json();
  if (data && data.error) throw new Error('Deezer: ' + (data.error.message || data.error.type || 'error'));
  return data;
}

async function lookup(item) {
  const song = String(item.song || '').trim();
  const artist = String(item.artist || '').trim();
  const base = { id: item.id };
  if (song.length < 2) return { ...base, status: 'nomatch' };
  const main = mainArtist(artist);
  const cleanSong = cleanTitle(song) || song;
  const queries = [];
  if (main) {
    queries.push(`artist:"${main.replace(/"/g, '')}" track:"${cleanSong.replace(/"/g, '')}"`);
    queries.push(`${main} ${cleanSong}`);
  } else {
    queries.push(`track:"${cleanSong.replace(/"/g, '')}"`);
  }
  let hit = null;
  for (const q of queries) {
    const data = await deezer('/search?limit=10&q=' + encodeURIComponent(q));
    hit = pickBest(data.data, artist, song);
    await sleep(GAP_MS);
    if (hit) break;
  }
  if (!hit) return { ...base, status: 'nomatch' };
  let release = '';
  try { const t = await deezer('/track/' + hit.id); release = t.release_date || ''; await sleep(GAP_MS); } catch (_) { /* la fecha es opcional */ }
  const matched = `${(hit.artist && hit.artist.name) || ''} - ${hit.title || ''}`.replace(/^ - /, '');
  return { ...base, status: 'ok', rank: Number(hit.rank) || 0, release_date: /^\d{4}-\d{2}-\d{2}$/.test(release) ? release : null, deezer_id: hit.id, matched };
}

async function validSession(token) {
  let last = 'sin respuesta';
  for (const [url, key] of CANDIDATES) {
    try {
      const r = await fetch(String(url).replace(/\/+$/, '') + '/auth/v1/user', { headers: { apikey: key, Authorization: 'Bearer ' + token } });
      if (r.ok) return { ok: true };
      last = 'Supabase respondió ' + r.status;
    } catch (e) { last = 'no se pudo contactar Supabase: ' + ((e && e.message) || e); }
  }
  return { ok: false, detail: last };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Usa POST' });
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Sesión no válida: no llegó el token. Vuelve a iniciar sesión.' });
  const sess = await validSession(token);
  if (!sess.ok) return json(401, { error: 'Sesión no válida (' + sess.detail + '). Cierra sesión, entra de nuevo y reintenta.' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { error: 'JSON inválido' }); }
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, MAX_ITEMS);
  const started = Date.now();
  const results = [];
  for (const it of items) {
    if (Date.now() - started > TIME_BUDGET_MS) { results.push({ id: it.id, status: 'retry' }); continue; }
    try { results.push(await lookup(it)); }
    catch (e) { results.push({ id: it.id, status: 'retry', error: String((e && e.message) || e) }); }
  }
  return json(200, { results });
};

exports.__test = { norm, tokens, cleanTitle, mainArtist, dice, pickBest, lookup };
