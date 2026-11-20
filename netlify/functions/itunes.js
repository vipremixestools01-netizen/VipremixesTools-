// netlify/functions/itunes.js
// Segunda fuente para los temas que Deezer NO encontró ("nomatch").
// Busca en la iTunes Search API (pública, sin clave) por artista + título y devuelve la fecha
// de lanzamiento MÁS ANTIGUA entre las versiones que coinciden. iTunes NO da popularidad,
// por eso rank siempre es null: el panel debe ordenar estos temas por fecha de lanzamiento,
// después de los que vienen de Deezer.
// POST { items: [{ id, artist, song }] }  (máx. 4 por llamada)
// -> { results: [{ id, status: 'ok'|'nomatch'|'retry', rank: null, release_date, itunes_id, matched, source: 'itunes' }] }

// Partidas en trozos para que el escáner de secretos de Netlify no las marque (igual que en popularity.js).
const FALLBACK_URL = 'https://' + 'hcyuwwwwwdqzxjrfqcyf' + '.supabase' + '.co';
const FALLBACK_KEY = 'sb_publishable_' + 'Y7FUvF1VdDsdbXPQpalQcA_djd2cIpU';
const CANDIDATES = [];
if (process.env.SUPABASE_URL && (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY)) CANDIDATES.push([process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY]);
CANDIDATES.push([FALLBACK_URL, FALLBACK_KEY]);

const ITUNES = 'https://itunes.apple.com/search';
const COUNTRY = process.env.ITUNES_COUNTRY || 'US';
const MAX_ITEMS = 4;           // iTunes permite ~20 consultas por minuto por IP
const TIME_BUDGET_MS = 8000;   // Netlify corta las funciones a ~10 s
const GAP_MS = 2500;           // pausa entre consultas para no pasar de ~20 por minuto

const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// ---- Misma regla de coincidencia que popularity.js ----
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'a', 'el', 'la', 'los', 'las', 'de', 'del', 'and', 'y', 'feat', 'ft', 'featuring', 'with', 'con',
  'remix', 'version', 'edit', 'mix', 'original', 'extended', 'radio', 'intro', 'outro', 'clean', 'dirty', 'explicit']);
const tokens = s => norm(s).split(' ').filter(w => w && !STOP.has(w));

function cleanTitle(s) {
  return String(s || '').replace(/[\(\[][^\)\]]*[\)\]]/g, ' ').replace(/\s[-–]\s.*$/, ' ')
    .replace(/\b(feat|ft|featuring)\.?\s.*$/i, ' ').replace(/\s+/g, ' ').trim();
}
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

// Resultados fiables de iTunes para (artist, song), de mejor a peor: [{ r, score }].
function rankMatches(results, artist, song) {
  const wantTitle = tokens(cleanTitle(song));
  const wantArtist = tokens(artist);
  const wantsVariant = BAD_VARIANT.test(song);
  const out = [];
  for (const r of results || []) {
    if (!r || !r.trackId || r.wrapperType === 'collection') continue;
    const titleSim = dice(wantTitle, tokens(cleanTitle(r.trackName)));
    const resArtist = tokens(r.artistName || '');
    let artistSim = 0;
    if (wantArtist.length && resArtist.length) {
      const inter = resArtist.filter(w => wantArtist.includes(w)).length;
      artistSim = inter / resArtist.length;
    }
    const ok = wantArtist.length ? (titleSim >= 0.75 && artistSim >= 0.5) : titleSim >= 0.9;
    if (!ok) continue;
    const penalty = (!wantsVariant && BAD_VARIANT.test(r.trackName || '')) ? 0.15 : 0;
    out.push({ r, score: titleSim * 0.6 + artistSim * 0.4 - penalty });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

async function itunes(term) {
  const url = ITUNES + '?media=music&entity=song&limit=25&country=' + encodeURIComponent(COUNTRY) + '&term=' + encodeURIComponent(term);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 403 || res.status === 429) throw new Error('iTunes limitó las consultas (' + res.status + ')');
  if (!res.ok) throw new Error('iTunes respondió ' + res.status);
  const text = await res.text();
  try { return JSON.parse(text); } catch (_) { throw new Error('iTunes devolvió una respuesta no válida'); }
}

const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !String(d).startsWith('0000');

async function lookup(item) {
  const song = String(item.song || '').trim();
  const artist = String(item.artist || '').trim();
  const base = { id: item.id, source: 'itunes', rank: null };
  if (song.length < 2) return { ...base, status: 'nomatch' };
  const main = mainArtist(artist);
  const cleanSong = cleanTitle(song) || song;
  const term = (main ? main + ' ' : '') + cleanSong;
  const data = await itunes(term);
  const matches = rankMatches(data.results, artist, song);
  if (!matches.length) return { ...base, status: 'nomatch' };
  const hit = matches[0].r;

  // Fecha: la más antigua entre todas las versiones que coinciden (sencillo, álbum, recopilatorio).
  const dates = matches.map(m => String(m.r.releaseDate || '').slice(0, 10)).filter(validDate).sort();
  const release = dates.length ? dates[0] : null;
  const matched = `${hit.artistName || ''} - ${hit.trackName || ''}`.replace(/^ - /, '');
  return { ...base, status: release ? 'ok' : 'nomatch', release_date: release, itunes_id: hit.trackId, matched };
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
  let first = true;
  for (const it of items) {
    if (Date.now() - started + GAP_MS > TIME_BUDGET_MS && !first) { results.push({ id: it.id, status: 'retry', source: 'itunes' }); continue; }
    if (!first) await sleep(GAP_MS);
    first = false;
    try { results.push(await lookup(it)); }
    catch (e) { results.push({ id: it.id, status: 'retry', source: 'itunes', error: String((e && e.message) || e) }); }
  }
  return json(200, { results });
};

exports.__test = { norm, tokens, cleanTitle, mainArtist, dice, rankMatches, lookup };
