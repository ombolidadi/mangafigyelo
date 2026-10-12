'use strict';

/* ---------- Állapot ---------- */

const STORE = 'mangafigyelo.v1';
const RECHECK_MS = 10 * 60 * 1000;
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const defaults = () => ({
  series: [],
  lastCheck: 0,
  settings: { mode: 'scroll', rtl: false, width: 900, api: '', key: '', langs: 'hu, en' },
});

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (saved && Array.isArray(saved.series)) {
      const d = defaults();
      return { ...d, ...saved, settings: { ...d.settings, ...saved.settings } };
    }
  } catch { /* sérült mentés: üres könyvtárral indulunk */ }
  return defaults();
}

let state = loadState();

function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); }
  catch { toast('Nem sikerült menteni (megtelt a tárhely?).'); }
}

const findSeries = id => state.series.find(s => s.id === id);
const unreadCount = s => s.chapters.reduce((n, c) => n + (s.read[c.url] ? 0 : 1), 0);
const totalNew = () => state.series.reduce((n, s) => n + s.newUrls.length, 0);

/* ---------- Közvetítő (proxy) ---------- */

const query = o => Object.entries(o).filter(([, v]) => v).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
// A GitHub Pages nem tud közvetítőt futtatni, ott ez a Cloudflare Worker az alapértelmezés.
const HOSTED_API = location.hostname.endsWith('.github.io') ? 'https://mangafigyelo.ombolidadi.workers.dev' : '';
const apiBase = () => {
  const base = state.settings.api || HOSTED_API;
  return (base ? base.replace(/\/+$/, '') + '/' : '') + 'api/';
};
const imgUrl = (url, ref) => apiBase() + 'img?' + query({ url, ref, k: state.settings.key });

async function getPage(url, ref) {
  let r;
  try { r = await fetch(apiBase() + 'fetch?' + query({ url, ref, k: state.settings.key })); }
  catch { throw new Error('A háttérszolgáltatás nem érhető el. Ellenőrizd a címét a Beállításokban.'); }
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json()).error; } catch { /* nem JSON */ }
    if (!msg && !state.settings.api && (r.status === 404 || r.status === 405)) {
      msg = 'Még nincs beállítva háttérszolgáltatás. Add meg a címét a ⚙ Beállításokban (lásd a leírást).';
    }
    throw new Error(msg || `A háttérszolgáltatás hibát adott (${r.status}).`);
  }
  return { text: decodeBody(await r.arrayBuffer(), r.headers.get('Content-Type')), url: r.headers.get('X-Final-Url') || url };
}

// Sok régebbi (főleg magyar) oldal nem UTF-8 kódolású; a kódolást a fejlécből vagy a <meta>-ból vesszük.
function decodeBody(buf, contentType) {
  const head = new TextDecoder('latin1').decode(buf.slice(0, 2048));
  const charset = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1] || /charset=["']?([\w-]+)/i.exec(head)?.[1] || 'utf-8';
  try { return new TextDecoder(charset).decode(buf); } catch { return new TextDecoder().decode(buf); }
}

/* ---------- Források: fejezetlista felismerése ---------- */

const CHAPTER_RE = /(?:^|[^a-z])(?:chapter|chap|ch|episode|ep|fejezet|r[ée]sz|cap[ií]tulo|cap|kapitel|chapitre|глава|第)[\s._\-:#]*0*(\d+(?:[.\-_]\d+)?)/i;
const MANGADEX_RE = /mangadex\.org\/title\/([0-9a-f-]{36})/i;
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };
const toNum = s => parseFloat(s.replace(/[-_]/, '.'));
const digitShape = s => s.replace(/\d+/g, '#');

function largestGroup(items, keyOf) {
  const groups = new Map();
  for (const it of items) {
    const k = keyOf(it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  return [...groups.values()].reduce((a, b) => (b.length > a.length ? b : a), []);
}

function sortNewestFirst(chapters) {
  if (chapters.length && chapters.every(c => c.num != null)) {
    return chapters.sort((a, b) => b.num - a.num);
  }
  const nums = chapters.filter(c => c.num != null);
  if (nums.length > 1 && nums[0].num < nums[nums.length - 1].num) chapters.reverse();
  return chapters;
}

function parseFeed(xml, base) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const text = (el, tag) => el.getElementsByTagName(tag)[0]?.textContent.trim() || '';
  const chapters = [];
  for (const item of doc.querySelectorAll('item, entry')) {
    const linkEl = item.getElementsByTagName('link')[0];
    let url = linkEl?.getAttribute('href') || linkEl?.textContent.trim();
    try { url = new URL(url, base).href; } catch { continue; }
    const title = text(item, 'title') || url;
    const m = CHAPTER_RE.exec(title) || CHAPTER_RE.exec(safeDecode(url));
    if (!chapters.some(c => c.url === url)) chapters.push({ url, title: title.slice(0, 100), num: m ? toNum(m[1]) : null });
  }
  return { title: text(doc, 'title') || new URL(base).hostname, cover: '', chapters: sortNewestFirst(chapters) };
}

function parseSeries(html, base, selector) {
  if (/^\s*(<\?xml|<rss|<feed)/i.test(html)) return parseFeed(html, base);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = n => doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute('content')?.trim();
  const title = (meta('og:title') || doc.querySelector('h1')?.textContent || doc.title || new URL(base).hostname)
    .replace(/\s+/g, ' ').trim().slice(0, 120);
  let cover = '';
  try { cover = new URL(meta('og:image') || meta('twitter:image'), base).href; } catch { /* nincs borító */ }

  let anchors;
  if (selector) {
    anchors = [];
    for (const el of doc.querySelectorAll(selector)) {
      if (el.matches('a[href]')) anchors.push(el); else anchors.push(...el.querySelectorAll('a[href]'));
    }
  } else {
    anchors = [...doc.querySelectorAll('a[href]')];
  }

  const host = new URL(base).hostname;
  const self = base.split('#')[0];
  const found = new Map();
  for (const a of anchors) {
    let u;
    try { u = new URL(a.getAttribute('href'), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    u.hash = '';
    if (u.href === self || found.has(u.href)) continue;
    const text = a.textContent.replace(/\s+/g, ' ').trim();
    const m = CHAPTER_RE.exec(text) || CHAPTER_RE.exec(safeDecode(u.pathname + u.search));
    if (!selector && (!m || u.hostname !== host)) continue;
    const loose = m ? null : /(\d+(?:\.\d+)?)/.exec(text);
    const num = m ? toNum(m[1]) : loose ? parseFloat(loose[1]) : null;
    found.set(u.href, { url: u.href, title: (text || `Fejezet ${num ?? ''}`).slice(0, 100), num, path: u.pathname });
  }

  let list = [...found.values()];
  if (!selector && list.length) {
    // A valódi fejezetlinkek azonos URL-mintát követnek; a menük, ajánlók linkjei nem.
    let best = largestGroup(list, c => digitShape(c.path));
    if (best.length < Math.max(2, list.length * 0.3)) {
      best = largestGroup(list, c => digitShape(c.path.replace(/[^/]*\/?$/, '')));
    }
    list = best;
  }
  const chapters = sortNewestFirst(list.map(({ url, title, num }) => ({ url, title, num })));
  return { title, cover, chapters };
}

async function fetchMangadex(id, lang) {
  const info = JSON.parse((await getPage(`https://api.mangadex.org/manga/${id}?includes[]=cover_art`)).text).data;
  const titles = info.attributes.title;
  const file = info.relationships.find(r => r.type === 'cover_art')?.attributes?.fileName;
  const chapters = [];
  const seen = new Set();
  for (let offset = 0; offset < 5000; offset += 500) {
    const feed = JSON.parse((await getPage(`https://api.mangadex.org/manga/${id}/feed?limit=500&offset=${offset}` +
      `&order[chapter]=desc&translatedLanguage[]=${encodeURIComponent(lang)}&includeExternalUrl=0`)).text);
    for (const ch of feed.data) {
      const a = ch.attributes;
      const key = a.chapter ?? ch.id;
      if (!a.pages || seen.has(key)) continue;
      seen.add(key);
      chapters.push({
        url: `https://mangadex.org/chapter/${ch.id}`,
        title: (a.chapter ? `${a.chapter}. fejezet` : 'Egyrészes') + (a.title ? ` – ${a.title}` : ''),
        num: a.chapter ? parseFloat(a.chapter) : null,
      });
    }
    if (offset + 500 >= feed.total) break;
  }
  return {
    title: titles.en || Object.values(titles)[0] || 'MangaDex',
    cover: file ? `https://uploads.mangadex.org/covers/${id}/${file}.256.jpg` : '',
    chapters,
  };
}

const STATUS_HU = { ongoing: 'folyamatban', completed: 'befejezett', hiatus: 'szünetel', cancelled: 'megszakítva' };

function langName(code) {
  // A MangaDex „es-la” kódja a latin-amerikai spanyolt jelenti, nem Laoszt.
  const tag = { 'es-la': 'es-419' }[code] || code;
  try { return new Intl.DisplayNames(['hu'], { type: 'language' }).of(tag) || code; } catch { return code; }
}

async function searchMangadex(text) {
  const found = JSON.parse((await getPage('https://api.mangadex.org/manga?limit=15&includes[]=cover_art' +
    '&order[relevance]=desc&title=' + encodeURIComponent(text))).text);
  return found.data.map(m => {
    const a = m.attributes;
    const file = m.relationships.find(r => r.type === 'cover_art')?.attributes?.fileName;
    return {
      id: m.id,
      title: a.title.en || Object.values(a.title)[0] || '?',
      huTitle: (a.altTitles || []).find(t => t.hu)?.hu || '',
      year: a.year,
      status: STATUS_HU[a.status] || '',
      cover: file ? `https://uploads.mangadex.org/covers/${m.id}/${file}.256.jpg` : '',
    };
  });
}

// A MangaDex nyelvlistájában a csak külső oldalra mutató (hivatalos kiadású) fejezetek is benne
// vannak, ezért a legutóbbi, itt ténylegesen olvasható fejezetek nyelveit nézzük meg.
async function readableLang(id) {
  const feed = JSON.parse((await getPage(`https://api.mangadex.org/manga/${id}/feed?limit=100&includeExternalUrl=0&order[readableAt]=desc`)).text);
  const langs = [...new Set(feed.data.filter(c => c.attributes.pages).map(c => c.attributes.translatedLanguage))];
  const prefs = state.settings.langs.toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const preferred = prefs.find(l => langs.includes(l));
  return { lang: preferred || langs[0] || '', preferred: !!preferred };
}

async function fetchSeries(url, opt) {
  const md = MANGADEX_RE.exec(url);
  if (md) return fetchMangadex(md[1], opt.lang || 'en');
  const page = await getPage(url);
  return parseSeries(page.text, page.url, opt.chapterSel);
}

/* ---------- Források: egy fejezet képei ---------- */

const IMG_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-cfsrc', 'data-srcset', 'srcset', 'src'];
const JUNK_RE = /logo|avatar|favicon|icon|sprite|emoji|gravatar|banner|badge|button|loading|placeholder|spinner|\/ads?\/|\.svg(\?|$)|\.gif(\?|$)/i;
const imgGroupKey = u => { const p = new URL(u); return p.hostname + digitShape(p.pathname.replace(/[^/]*$/, '')); };

function parsePages(html, base, selector) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const urls = [];
  const add = raw => {
    try {
      const u = new URL(raw.trim().split(/\s+/)[0], base).href;
      if (/^https?:/.test(u) && !urls.includes(u)) urls.push(u);
    } catch { /* nem cím */ }
  };
  let imgs = [...doc.querySelectorAll(selector || 'img')];
  if (selector) imgs = imgs.flatMap(el => (el.matches('img') ? [el] : [...el.querySelectorAll('img')]));
  for (const img of imgs) {
    const raw = IMG_ATTRS.map(a => img.getAttribute(a)).find(v => v && !v.trim().startsWith('data:'));
    if (raw) add(raw);
  }
  if (selector) return urls;

  const best = largestGroup(urls.filter(u => !JUNK_RE.test(u)), imgGroupKey);
  if (best.length >= 3) return best;

  // Sok oldal a képek listáját egy szkriptbe ágyazva adja át.
  const embedded = [];
  const re = /https?:\/\/[^"'\s<>\\)]+?\.(?:jpe?g|png|webp|avif)(?:\?[^"'\s<>\\)]*)?/gi;
  for (const m of html.replace(/\\\//g, '/').matchAll(re)) {
    if (!JUNK_RE.test(m[0]) && !embedded.includes(m[0])) embedded.push(m[0]);
  }
  const bestEmbedded = largestGroup(embedded, imgGroupKey);
  return bestEmbedded.length > best.length ? bestEmbedded : best;
}

async function fetchPages(s, chapter) {
  const md = /mangadex\.org\/chapter\/([0-9a-f-]{36})/i.exec(chapter.url);
  if (md) {
    const j = JSON.parse((await getPage(`https://api.mangadex.org/at-home/server/${md[1]}`)).text);
    return { ref: '', pages: j.chapter.data.map(f => `${j.baseUrl}/data/${j.chapter.hash}/${f}`) };
  }
  const page = await getPage(chapter.url, s.url);
  return { ref: page.url, pages: parsePages(page.text, page.url, s.imageSel) };
}

/* ---------- Új fejezetek figyelése ---------- */

async function refreshSeries(s) {
  const data = await fetchSeries(s.url, s);
  if (!data.chapters.length) throw new Error('Nem találtam fejezeteket az oldalon.');
  const known = new Set(s.chapters.map(c => c.url));
  const fresh = known.size ? data.chapters.filter(c => !known.has(c.url) && !s.read[c.url]) : [];
  const current = new Set(data.chapters.map(c => c.url));
  s.chapters = data.chapters;
  s.newUrls = [...new Set([...s.newUrls, ...fresh.map(c => c.url)])].filter(u => current.has(u));
  if (!s.cover) s.cover = data.cover;
  s.checked = Date.now();
  s.error = '';
  return fresh;
}

let checking = false;

async function checkAll(manual) {
  if (checking || !state.series.length) return;
  checking = true;
  $('#refresh').classList.add('busy');
  const found = [];
  const queue = [...state.series];
  await Promise.all([0, 1, 2].map(async () => {
    while (queue.length) {
      const s = queue.shift();
      try {
        const fresh = await refreshSeries(s);
        if (fresh.length) found.push(`${s.title} (${fresh.length})`);
      } catch (e) { s.error = e.message; }
    }
  }));
  state.lastCheck = Date.now();
  save();
  checking = false;
  $('#refresh').classList.remove('busy');
  if ($('#reader').hidden) render();
  updateBadge();
  if (found.length) {
    toast('Új fejezet érkezett!');
    notify('Új fejezetek: ' + found.join(', '));
  } else if (manual) {
    toast(state.series.some(s => s.error) ? 'Nincs új fejezet – néhány oldalt nem sikerült elérni.' : 'Nincs új fejezet.');
  }
}

function updateBadge() {
  const n = totalNew();
  try { n ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.(); } catch { /* nem támogatott */ }
}

async function notify(body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const opt = { body, icon: 'icon-192.png', tag: 'uj-fejezet' };
    if (reg) reg.showNotification('Mangafigyelő', opt); else new Notification('Mangafigyelő', opt);
  } catch { /* az alkalmazáson belüli jelzés így is megjelenik */ }
}

/* ---------- Nézetek ---------- */

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function coverHtml(s) {
  const letter = esc((s.title || '?').trim().charAt(0).toUpperCase());
  return letter + (s.cover ? `<img src="${esc(imgUrl(s.cover, s.url))}" alt="" loading="lazy" onerror="this.remove()">` : '');
}

function renderLibrary() {
  if (!state.series.length) {
    return `<div class="empty"><h2>Még üres a könyvtárad</h2>
      <p>Add meg egy manga vagy képregény oldalának címét (ahol a fejezetek listája látható). Az alkalmazás minden megnyitáskor megnézi, jött-e új fejezet.</p>
      <button class="primary" data-act="add">＋ Első sorozat hozzáadása</button></div>`;
  }
  const withNew = state.series.filter(s => s.newUrls.length);
  const banner = withNew.length ? `<div class="banner"><strong>🔔 Új fejezetek:</strong>${withNew.map(s =>
    `<button data-act="open" data-id="${s.id}">${esc(s.title)} (${s.newUrls.length})</button>`).join('')}</div>` : '';
  const sorted = [...state.series].sort((a, b) => (b.newUrls.length > 0) - (a.newUrls.length > 0));
  return banner + `<div class="grid">${sorted.map(s => `
    <button class="card" data-act="open" data-id="${s.id}">
      <div class="cover">${coverHtml(s)}${s.newUrls.length ? `<span class="pill new">${s.newUrls.length} új</span>` : ''}</div>
      <div class="ctitle">${esc(s.title)}</div>
      <div class="csub">${unreadCount(s)} olvasatlan · ${s.chapters.length} fejezet</div>
      ${s.error ? `<div class="cerr">⚠ Nem sikerült frissíteni</div>` : ''}
    </button>`).join('')}</div>`;
}

function resumeIndex(s) {
  const last = s.last ? s.chapters.findIndex(c => c.url === s.last.url) : -1;
  if (last >= 0 && !s.read[s.chapters[last].url]) return last;
  for (let i = s.chapters.length - 1; i >= 0; i--) if (!s.read[s.chapters[i].url]) return i;
  return -1;
}

function renderSeries(s) {
  const resume = resumeIndex(s);
  const started = s.last || Object.keys(s.read).length;
  const checked = s.checked ? new Date(s.checked).toLocaleString('hu-HU', { dateStyle: 'medium', timeStyle: 'short' }) : '–';
  return `
    <div class="shead">
      <div class="cover">${coverHtml(s)}</div>
      <div class="sinfo">
        <h2>${esc(s.title)}</h2>
        <div class="src"><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(new URL(s.url).hostname)}</a> · ellenőrizve: ${esc(checked)}</div>
        <div class="csub">${unreadCount(s)} olvasatlan · ${s.chapters.length} fejezet</div>
        ${s.error ? `<div class="warn">⚠ ${esc(s.error)}</div>` : ''}
        <div class="sbtns">
          ${resume >= 0 ? `<button class="primary" data-act="read" data-id="${s.id}" data-i="${resume}">${started ? 'Folytatás' : 'Olvasás kezdése'}</button>` : ''}
          <button data-act="refresh-one" data-id="${s.id}">↻ Frissítés</button>
          <button data-act="mark-all" data-id="${s.id}">Mind olvasott</button>
          <button data-act="edit" data-id="${s.id}">Szerkesztés</button>
          <button class="danger" data-act="delete" data-id="${s.id}">Törlés</button>
        </div>
      </div>
    </div>
    <ul class="chapters">${s.chapters.map((c, i) => `
      <li class="${s.read[c.url] ? 'read' : ''} ${s.last?.url === c.url ? 'current' : ''}">
        <button class="chopen" data-act="read" data-id="${s.id}" data-i="${i}">
          <span class="t">${esc(c.title)}</span>${s.newUrls.includes(c.url) ? '<span class="pill new">új</span>' : ''}
        </button>
        <button class="chtool" data-act="mark-upto" data-id="${s.id}" data-i="${i}" aria-label="Eddig mind olvasott" title="Eddig mind olvasott">⤓</button>
        <button class="chtool tick" data-act="toggle-read" data-id="${s.id}" data-i="${i}" aria-label="Olvasott" title="Olvasott">✓</button>
      </li>`).join('')}</ul>`;
}

function render() {
  const id = /^#s=(.+)/.exec(location.hash)?.[1];
  const s = id && findSeries(id);
  $('#back').hidden = !s;
  $('#heading').hidden = !!s;
  $('#view').innerHTML = s ? renderSeries(s) : renderLibrary();
}

/* ---------- Párbeszédablakok ---------- */

const dlg = $('#dlg');

let searchRun = 0;
const isUrl = v => /^https?:\/\/\S+$/i.test(v.trim());

function seriesDialog(s) {
  const md = s && MANGADEX_RE.test(s.url);
  dlg.innerHTML = `
    <form method="dialog" id="sform">
      <h2>${s ? 'Sorozat szerkesztése' : 'Sorozat hozzáadása'}</h2>
      <label for="f-url">${s ? 'A sorozat oldalának címe (ahol a fejezetlista van)' : 'Keresés cím alapján – vagy a sorozat oldalának webcíme'}</label>
      <input type="text" id="f-url" required placeholder="${s ? 'https://…' : 'pl. One Piece vagy https://…'}" value="${esc(s?.url)}" autocapitalize="off" autocorrect="off" enterkeyhint="${s ? 'done' : 'search'}">
      <div id="f-results"></div>
      <label for="f-title">Cím (üresen hagyva az oldalról veszem)</label>
      <input type="text" id="f-title" value="${esc(s?.title)}">
      ${s ? '' : `<label class="check"><input type="checkbox" id="f-allread"> A meglévő fejezeteket már olvastam</label>`}
      <details ${s?.chapterSel || s?.imageSel || md ? 'open' : ''}>
        <summary>Haladó beállítások</summary>
        <label for="f-lang">MangaDex fordítás nyelve</label>
        <input type="text" id="f-lang" value="${esc(s?.lang || 'en')}" autocapitalize="off">
        <label for="f-chsel">Fejezetlinkek CSS-szelektora</label>
        <input type="text" id="f-chsel" value="${esc(s?.chapterSel)}" placeholder="pl. .chapter-list a" autocapitalize="off" autocorrect="off">
        <label for="f-imgsel">Képek CSS-szelektora a fejezetoldalon</label>
        <input type="text" id="f-imgsel" value="${esc(s?.imageSel)}" placeholder="pl. .reading-content img" autocapitalize="off" autocorrect="off">
        <p class="hint">Csak akkor kell, ha az automatikus felismerés nem talál fejezeteket vagy rossz képeket mutat.</p>
      </details>
      <div class="derr" id="f-err" hidden></div>
      <div class="dbtns">
        <button type="button" data-act="dlg-close">Mégse</button>
        <button type="submit" class="primary" id="f-ok">${s ? 'Mentés' : 'Hozzáadás'}</button>
      </div>
    </form>`;
  const okLabel = () => (s ? 'Mentés' : isUrl($('#f-url').value) ? 'Hozzáadás' : 'Keresés');
  $('#f-url').addEventListener('input', () => { $('#f-ok').textContent = okLabel(); });
  $('#f-ok').textContent = okLabel();
  $('#f-results').addEventListener('click', ev => {
    const pick = ev.target.closest('[data-pick]');
    if (!pick) return;
    if (!pick.dataset.lang) return;
    $('#f-url').value = `https://mangadex.org/title/${pick.dataset.pick}`;
    $('#f-title').value = '';
    $('#f-lang').value = pick.dataset.lang;
    $('#sform').requestSubmit();
  });
  $('#sform').addEventListener('submit', async ev => {
    ev.preventDefault();
    const err = $('#f-err'), ok = $('#f-ok');
    if (!isUrl($('#f-url').value)) {
      if (s) { err.textContent = 'Ide a sorozat oldalának webcíme kell (https://…).'; err.hidden = false; return; }
      ok.disabled = true; ok.textContent = 'Keresés…'; err.hidden = true;
      try {
        const results = await searchMangadex($('#f-url').value.trim());
        $('#f-results').innerHTML = results.length ? `<p class="hint">Találatok a MangaDexről – koppints arra, amelyiket fel szeretnéd venni:</p>` + results.map(r => `
          <button type="button" class="result" data-pick="${esc(r.id)}" data-lang="" disabled>
            <span class="rcover">${r.cover ? `<img src="${esc(imgUrl(r.cover))}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
            <span class="rinfo"><strong>${esc(r.title)}</strong>
              ${r.huTitle ? `<span>${esc(r.huTitle)}</span>` : ''}
              <span>${esc([r.year, r.status].filter(Boolean).join(' · '))}</span>
              <span class="pill">ellenőrzés…</span></span>
          </button>`).join('') : '<p class="hint">Nincs találat. Próbáld az eredeti (japán/angol) címmel, vagy add meg a sorozat oldalának webcímét.</p>';
        const run = ++searchRun;
        const queue = [...results];
        [0, 1, 2].forEach(async () => {
          while (queue.length && run === searchRun) {
            const r = queue.shift();
            let lang = '', preferred = false;
            try { ({ lang, preferred } = await readableLang(r.id)); } catch { /* nem elérhető: nem választható */ }
            const row = $(`#f-results [data-pick="${r.id}"]`);
            if (!row || run !== searchRun) return;
            row.dataset.lang = lang;
            row.disabled = !lang;
            const pill = $('.pill', row);
            pill.textContent = !lang ? 'itt nem olvasható' : `${preferred ? '' : 'csak '}${langName(lang)} fordítás`;
            pill.classList.toggle('new', lang === 'hu');
          }
        });
      } catch (e) { err.textContent = e.message; err.hidden = false; }
      ok.disabled = false; ok.textContent = okLabel();
      return;
    }
    const draft = {
      url: $('#f-url').value.trim(),
      lang: $('#f-lang').value.trim() || 'en',
      chapterSel: $('#f-chsel').value.trim(),
      imageSel: $('#f-imgsel').value.trim(),
    };
    const title = $('#f-title').value.trim();
    if (!s && state.series.some(x => x.url === draft.url)) {
      err.textContent = 'Ez a sorozat már szerepel a könyvtárban.'; err.hidden = false; return;
    }
    ok.disabled = true; ok.textContent = 'Ellenőrzés…'; err.hidden = true;
    try {
      const data = await fetchSeries(draft.url, draft);
      if (!data.chapters.length && MANGADEX_RE.test(draft.url)) {
        throw new Error(`A MangaDexen ehhez nincs olvasható fejezet ezen a nyelven (${draft.lang}).\nA Haladó beállításokban megadhatsz másik nyelvkódot.`);
      }
      if (!data.chapters.length) {
        throw new Error('Nem találtam fejezeteket ezen az oldalon.\nLehet, hogy az oldal JavaScripttel tölti be a listát, vagy más szerkezetű – próbáld a Haladó beállításokban megadni a fejezetlinkek szelektorát.');
      }
      const target = s || { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), read: {}, newUrls: [], last: null, error: '' };
      const sourceChanged = s && s.url !== draft.url;
      Object.assign(target, draft, { title: title || data.title, chapters: data.chapters, checked: Date.now(), error: '' });
      if (!s || sourceChanged || !target.cover) target.cover = data.cover;
      target.newUrls = target.newUrls.filter(u => data.chapters.some(c => c.url === u));
      if (!s) {
        if ($('#f-allread').checked) data.chapters.forEach(c => { target.read[c.url] = 1; });
        state.series.push(target);
      }
      save();
      dlg.close();
      toast(s ? 'Mentve.' : `Hozzáadva: ${data.chapters.length} fejezet.`);
      if (location.hash === '#s=' + target.id) render(); else location.hash = '#s=' + target.id;
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
      ok.disabled = false; ok.textContent = okLabel();
    }
  });
  dlg.showModal();
}

function settingsDialog() {
  const st = state.settings;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const permText = { granted: 'Engedélyezve ✓', denied: 'Letiltva az eszköz beállításaiban', default: 'Nincs engedélyezve', unsupported: 'Itt nem érhető el (iPaden előbb add a Főképernyőhöz, https-címről)' }[perm];
  dlg.innerHTML = `
    <form method="dialog" id="setform">
      <h2>Beállítások</h2>
      <h3>Olvasó</h3>
      <label for="s-mode">Olvasási mód</label>
      <select id="s-mode"><option value="scroll">Görgetős (webtoon)</option><option value="paged">Lapozós</option></select>
      <label class="check"><input type="checkbox" id="s-rtl" ${st.rtl ? 'checked' : ''}> Jobbról balra lapozás (manga)</label>
      <label for="s-width">Legnagyobb képszélesség görgetős módban (képpont)</label>
      <input type="number" id="s-width" min="400" max="3000" step="50" value="${esc(st.width)}">
      <h3>Keresés</h3>
      <label for="s-langs">Előnyben részesített fordítási nyelvek (sorrendben)</label>
      <input type="text" id="s-langs" value="${esc(st.langs)}" placeholder="hu, en" autocapitalize="off" autocorrect="off">
      <h3>Értesítések</h3>
      <p class="hint">Állapot: ${permText}. Az alkalmazáson belüli jelzés és az „új” címkék engedély nélkül is működnek.</p>
      ${perm === 'default' ? '<button type="button" data-act="ask-notify">Értesítések engedélyezése</button>' : ''}
      <h3>Háttérszolgáltatás</h3>
      <label for="s-api">Címe (üresen: az alapértelmezett)</label>
      <input type="url" id="s-api" value="${esc(st.api)}" placeholder="https://…workers.dev" autocapitalize="off" autocorrect="off">
      <label for="s-key">Hozzáférési kulcs (ha beállítottál)</label>
      <input type="password" id="s-key" value="${esc(st.key)}" autocomplete="off">
      <h3>Biztonsági mentés</h3>
      <div class="dbtns" style="justify-content:flex-start;margin-top:0">
        <button type="button" data-act="export">Mentés fájlba</button>
        <button type="button" data-act="import">Visszatöltés fájlból</button>
      </div>
      <p class="hint">A könyvtár ezen az eszközön, a böngészőben tárolódik.</p>
      <div class="dbtns"><button type="button" data-act="dlg-close">Mégse</button><button type="submit" class="primary">Mentés</button></div>
    </form>`;
  $('#s-mode').value = st.mode;
  $('#setform').addEventListener('submit', () => {
    st.mode = $('#s-mode').value;
    st.rtl = $('#s-rtl').checked;
    st.width = Math.min(3000, Math.max(400, +$('#s-width').value || 900));
    st.langs = $('#s-langs').value.trim() || 'hu, en';
    st.api = $('#s-api').value.trim();
    st.key = $('#s-key').value;
    save(); applySettings(); render();
  });
  dlg.showModal();
}

function applySettings() {
  document.documentElement.style.setProperty('--page-width', state.settings.width + 'px');
}

function exportBackup() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' }));
  a.download = `mangafigyelo-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function importBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    try {
      const data = JSON.parse(await input.files[0].text());
      if (!Array.isArray(data.series)) throw new Error();
      if (state.series.length && !confirm('A visszatöltés felülírja a mostani könyvtárat. Folytatod?')) return;
      localStorage.setItem(STORE, JSON.stringify(data));
      state = loadState();
      dlg.close(); applySettings(); render(); updateBadge();
      toast('Visszatöltve.');
    } catch { toast('Ez nem érvényes mentésfájl.'); }
  };
  input.click();
}

/* ---------- Olvasó ---------- */

const R = { s: null, idx: 0, pages: [], ref: '', page: 0, token: 0 };
const reader = $('#reader'), rbody = $('#rbody');

function markRead(s, url) {
  s.read[url] = 1;
  s.newUrls = s.newUrls.filter(u => u !== url);
}

async function openChapter(s, idx, page = 0) {
  const c = s.chapters[idx];
  if (!c) return;
  const token = ++R.token;
  Object.assign(R, { s, idx, pages: [], page });
  s.newUrls = s.newUrls.filter(u => u !== c.url);
  s.last = { url: c.url, page };
  save(); updateBadge();

  reader.hidden = false;
  document.body.classList.add('reading');
  reader.className = 'bars mode-' + state.settings.mode;
  $('#rtitle').textContent = `${s.title} – ${c.title}`;
  $('#rorig').href = c.url;
  $('#rprev').disabled = idx >= s.chapters.length - 1;
  $('#rnext').disabled = idx <= 0;
  $('#rcount').textContent = '';
  updateReaderButtons();
  rbody.innerHTML = '<div class="rmsg">Betöltés…</div>';

  try {
    const { pages, ref } = await fetchPages(s, c);
    if (token !== R.token) return;
    if (!pages.length) throw new Error('Nem találtam képeket ezen a fejezetoldalon.');
    R.pages = pages; R.ref = ref;
    R.page = Math.min(page, pages.length - 1);
    renderReader();
    setTimeout(() => { if (token === R.token) reader.classList.remove('bars'); }, 1800);
  } catch (e) {
    if (token !== R.token) return;
    rbody.innerHTML = `<div class="rmsg"><p><strong>${esc(e.message)}</strong></p>
      <p>Előfordul, hogy egy oldal JavaScripttel tölti be a képeket vagy védi a tartalmát – ilyenkor az eredeti oldalon tudod elolvasni, itt pedig olvasottnak jelölheted.</p>
      <div class="row"><a class="btn primary" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">Megnyitás az eredeti oldalon</a>
      <button data-act="r-markread">Olvasottnak jelölöm</button></div></div>`;
  }
}

function updateReaderButtons() {
  $('#rmode').textContent = state.settings.mode === 'scroll' ? '⇅ Görgetős' : '⇄ Lapozós';
  $('#rdir').textContent = state.settings.rtl ? '← Jobbról balra' : '→ Balról jobbra';
  $('#rdir').hidden = state.settings.mode !== 'paged';
}

function pageImg(i) {
  const img = document.createElement('img');
  img.className = 'pg wait';
  img.alt = `${i + 1}. oldal`;
  img.dataset.i = i;
  img.decoding = 'async';
  img.onload = () => img.classList.remove('wait', 'err');
  img.onerror = () => {
    if (!img.dataset.direct) {
      // Ha a közvetítőn át nem jön, megpróbáljuk közvetlenül, hivatkozó nélkül.
      img.dataset.direct = '1';
      img.referrerPolicy = 'no-referrer';
      img.src = R.pages[i];
    } else {
      img.classList.remove('wait');
      img.classList.add('err');
      img.alt = `A(z) ${i + 1}. oldalt nem sikerült betölteni – koppints rá az újrapróbáláshoz.`;
    }
  };
  img.src = imgUrl(R.pages[i], R.ref);
  return img;
}

function renderReader() {
  const paged = state.settings.mode === 'paged';
  reader.classList.toggle('mode-paged', paged);
  reader.classList.toggle('mode-scroll', !paged);
  updateReaderButtons();
  const slider = $('#rslider');
  slider.max = R.pages.length;
  slider.dir = paged && state.settings.rtl ? 'rtl' : 'ltr';
  rbody.innerHTML = '';
  rbody.scrollTop = 0;
  if (paged) {
    showPage(R.page);
  } else {
    R.pages.forEach((_, i) => {
      const img = pageImg(i);
      if (i > 1) img.loading = 'lazy';
      rbody.append(img);
    });
    const hasNext = R.idx > 0;
    const end = document.createElement('div');
    end.className = 'rend';
    end.innerHTML = `<div>Vége a fejezetnek</div><div class="row">
      ${hasNext ? '<button class="primary" data-act="r-next">Következő fejezet ›</button>' : '<span>Ez a legfrissebb fejezet.</span>'}
      <button data-act="r-close">Vissza a sorozathoz</button></div>`;
    rbody.append(end);
    if (R.page > 0) rbody.children[R.page].scrollIntoView();
    setPage(R.page);
  }
}

function showPage(i) {
  i = Math.max(0, Math.min(R.pages.length - 1, i));
  rbody.innerHTML = '';
  rbody.append(pageImg(i));
  for (const n of [i + 1, i + 2]) if (R.pages[n]) new Image().src = imgUrl(R.pages[n], R.ref);
  setPage(i);
}

function setPage(i) {
  const changed = i !== R.page;
  R.page = i;
  $('#rslider').value = i + 1;
  $('#rcount').textContent = `${i + 1} / ${R.pages.length}`;
  const c = R.s.chapters[R.idx];
  const finished = i >= R.pages.length - 1 && !R.s.read[c.url];
  if (finished) markRead(R.s, c.url);
  if (changed || finished) { R.s.last = { url: c.url, page: i }; save(); }
}

function turn(dir) {
  const next = R.page + dir;
  if (next < 0) return toast('Ez a fejezet első oldala.');
  if (next >= R.pages.length) return R.idx > 0 ? openChapter(R.s, R.idx - 1) : toast('Ez a legfrissebb fejezet.');
  showPage(next);
}

function closeReader() {
  R.token++;
  reader.hidden = true;
  rbody.innerHTML = '';
  document.body.classList.remove('reading');
  render(); updateBadge();
}

let scrollTick = false;
rbody.addEventListener('scroll', () => {
  if (scrollTick || state.settings.mode !== 'scroll' || !R.pages.length) return;
  scrollTick = true;
  requestAnimationFrame(() => {
    scrollTick = false;
    if (reader.hidden) return;
    const box = rbody.getBoundingClientRect();
    const mid = box.top + box.height / 2;
    let current = R.pages.length - 1;
    if (rbody.scrollTop + rbody.clientHeight < rbody.scrollHeight - 60) {
      for (const img of rbody.querySelectorAll('.pg')) {
        if (img.getBoundingClientRect().bottom > mid) { current = +img.dataset.i; break; }
      }
    }
    if (current !== R.page) setPage(current);
  });
}, { passive: true });

rbody.addEventListener('click', ev => {
  if (ev.target.closest('button, a')) return;
  const img = ev.target.closest('.pg.err');
  if (img) {
    delete img.dataset.direct;
    img.className = 'pg wait';
    img.src = imgUrl(R.pages[+img.dataset.i], R.ref) + '&retry=' + Date.now();
    return;
  }
  const x = ev.clientX / window.innerWidth;
  if (state.settings.mode === 'paged' && R.pages.length && (x < 0.3 || x > 0.7)) {
    turn((x > 0.7) === !state.settings.rtl ? 1 : -1);
  } else {
    reader.classList.toggle('bars');
  }
});

let touchStart = null;
rbody.addEventListener('touchstart', ev => { touchStart = ev.touches.length === 1 ? ev.touches[0] : null; }, { passive: true });
rbody.addEventListener('touchend', ev => {
  if (!touchStart || state.settings.mode !== 'paged' || !R.pages.length) return;
  const t = ev.changedTouches[0];
  const dx = t.clientX - touchStart.clientX, dy = t.clientY - touchStart.clientY;
  touchStart = null;
  if (window.visualViewport?.scale > 1.05) return; // nagyítás közben ne lapozzon
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) turn((dx < 0) === !state.settings.rtl ? 1 : -1);
}, { passive: true });

$('#rslider').addEventListener('input', ev => {
  const i = +ev.target.value - 1;
  if (state.settings.mode === 'paged') showPage(i);
  else rbody.querySelector(`.pg[data-i="${i}"]`)?.scrollIntoView();
});

document.addEventListener('keydown', ev => {
  if (reader.hidden || dlg.open) return;
  if (ev.key === 'Escape') return closeReader();
  if (state.settings.mode !== 'paged') return;
  const fwd = state.settings.rtl ? 'ArrowLeft' : 'ArrowRight', back = state.settings.rtl ? 'ArrowRight' : 'ArrowLeft';
  if (ev.key === fwd || ev.key === ' ') { ev.preventDefault(); turn(1); }
  if (ev.key === back) { ev.preventDefault(); turn(-1); }
});

/* ---------- Műveletek ---------- */

const actions = {
  home: () => { location.hash = ''; },
  open: el => { location.hash = '#s=' + el.dataset.id; },
  add: () => seriesDialog(null),
  edit: el => seriesDialog(findSeries(el.dataset.id)),
  settings: settingsDialog,
  check: () => checkAll(true),
  'dlg-close': () => dlg.close(),
  export: exportBackup,
  import: importBackup,
  'ask-notify': async () => { await Notification.requestPermission(); settingsDialog(); },

  read: el => {
    const s = findSeries(el.dataset.id), i = +el.dataset.i;
    openChapter(s, i, s.last?.url === s.chapters[i].url && !s.read[s.last.url] ? s.last.page : 0);
  },
  'toggle-read': el => {
    const s = findSeries(el.dataset.id), url = s.chapters[+el.dataset.i].url;
    if (s.read[url]) delete s.read[url]; else markRead(s, url);
    save(); render(); updateBadge();
  },
  'mark-upto': el => {
    const s = findSeries(el.dataset.id);
    s.chapters.slice(+el.dataset.i).forEach(c => markRead(s, c.url));
    save(); render(); updateBadge();
  },
  'mark-all': el => {
    const s = findSeries(el.dataset.id);
    s.chapters.forEach(c => markRead(s, c.url));
    save(); render(); updateBadge();
  },
  'refresh-one': async el => {
    const s = findSeries(el.dataset.id);
    el.disabled = true;
    try {
      const fresh = await refreshSeries(s);
      toast(fresh.length ? `${fresh.length} új fejezet!` : 'Nincs új fejezet.');
    } catch (e) { s.error = e.message; toast('Nem sikerült frissíteni.'); }
    save(); render(); updateBadge();
  },
  delete: el => {
    const s = findSeries(el.dataset.id);
    if (!confirm(`Biztosan törlöd a könyvtárból: „${s.title}”? Az olvasási előzmény is elvész.`)) return;
    state.series = state.series.filter(x => x !== s);
    save(); updateBadge();
    location.hash = '';
  },

  'r-close': closeReader,
  'r-prev': () => openChapter(R.s, R.idx + 1),
  'r-next': () => openChapter(R.s, R.idx - 1),
  'r-markread': () => { markRead(R.s, R.s.chapters[R.idx].url); save(); closeReader(); },
  'r-mode': () => {
    state.settings.mode = state.settings.mode === 'scroll' ? 'paged' : 'scroll';
    save();
    if (R.pages.length) renderReader(); else updateReaderButtons();
  },
  'r-dir': () => {
    state.settings.rtl = !state.settings.rtl;
    save();
    if (R.pages.length) renderReader(); else updateReaderButtons();
  },
};

document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el);
});

/* ---------- Indulás ---------- */

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - state.lastCheck > RECHECK_MS) checkAll(false);
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

applySettings();
render();
updateBadge();
checkAll(false);
