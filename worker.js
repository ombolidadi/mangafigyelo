// Mangafigyelő – Cloudflare Worker közvetítő (ugyanazt tudja, mint a server.py).
// Ha van ASSETS kötés (wrangler.toml), a docs/ mappát is kiszolgálja.
// Opcionális jelszó: ACCESS_KEY nevű titok (Settings → Variables and Secrets).

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Final-Url' };
const PRIVATE = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/i;

const fail = (status, error) => new Response(JSON.stringify({ error }), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
});

async function api(u, env, isImg) {
  if (env.ACCESS_KEY && u.searchParams.get('k') !== env.ACCESS_KEY) {
    return fail(401, 'Hibás vagy hiányzó hozzáférési kulcs (Beállítások).');
  }
  let target;
  try { target = new URL(u.searchParams.get('url')); } catch { return fail(400, 'Érvénytelen cím.'); }
  if (!/^https?:$/.test(target.protocol) || PRIVATE.test(target.hostname)) return fail(400, 'Érvénytelen cím.');

  const headers = {
    'User-Agent': UA,
    'Accept': isImg ? 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5'
      : 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,hu;q=0.8',
  };
  const ref = u.searchParams.get('ref');
  if (ref) headers.Referer = ref;

  let r;
  try { r = await fetch(target.href, { headers, redirect: 'follow' }); } catch { return fail(502, 'Nem sikerült elérni a forrásoldalt.'); }
  if (!r.ok) return fail(502, `A forrásoldal hibát adott (${r.status}).`);

  const type = r.headers.get('Content-Type') || 'application/octet-stream';
  if (isImg) {
    if (!/^(image\/|application\/octet-stream|binary\/)/.test(type)) return fail(502, 'A forrás nem képet adott vissza.');
    return new Response(r.body, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800', ...CORS } });
  }
  return new Response(r.body, { headers: { 'Content-Type': type, 'X-Final-Url': r.url, 'Cache-Control': 'no-store', ...CORS } });
}

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    if (u.pathname === '/api/fetch' || u.pathname === '/api/img') return api(u, env, u.pathname === '/api/img');
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Mangafigyelő közvetítő', { status: 404 });
  },
};
