// Shared helpers for server.js and check_alerts.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'); // runtime data (ephemeral on Render)
const CACHE = path.join(DATA, 'cache');
const HIST = path.join(DATA, 'history');
for (const d of [DATA, CACHE, HIST]) fs.mkdirSync(d, { recursive: true });
const UA = 'pokemon-price-tracker/1.0 (personal project)';
const TCGCSV = 'https://tcgcsv.com/tcgplayer';
const TCGDEX = 'https://api.tcgdex.net/v2';
const CATEGORIES = [{ id: 3, lang: 'en' }, { id: 85, lang: 'ja' }];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url, { retries = 3, timeout = 20000 } = {}) {
  let err;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeout) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (e) { err = e; if (i < retries) await sleep(600 * (i + 1)); }
  }
  throw err;
}
async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  return (await res.text()).trim();
}
function readJSON(file, fallback, maxAgeMs) {
  try {
    if (maxAgeMs && Date.now() - fs.statSync(file).mtimeMs > maxAgeMs) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}
function writeJSON(file, data, pretty) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, pretty ? 1 : 0));
  fs.renameSync(tmp, file);
}
const cacheFile = n => path.join(CACHE, n);

// TCGCSV prices for one group, cached per daily stamp (TCGCSV asks for at most one fetch per file per day).
async function groupPrices(cat, groupId, stamp) {
  const f = cacheFile(`prices-${cat}-${groupId}.json`);
  let prices = readJSON(f, null);
  if (!prices || (stamp && prices.stamp !== stamp)) {
    const j = await getJSON(`${TCGCSV}/${cat}/${groupId}/prices`);
    prices = { stamp, items: (j?.results || []).map(r => [r.productId, r.subTypeName, r.lowPrice, r.midPrice, r.highPrice, r.marketPrice]) };
    writeJSON(f, prices);
  }
  return prices.items;
}

// TCGdex card detail (cached 24h)
async function tcgdexCard(lang, id) {
  const f = cacheFile(`tcgdex-${lang}-${id.replace(/[^\w.-]/g, '_')}.json`);
  let c = readJSON(f, null, 864e5);
  if (!c) { c = await getJSON(`${TCGDEX}/${lang}/cards/${encodeURIComponent(id)}`, { retries: 2 }); if (c) writeJSON(f, c); }
  return c;
}

const ext = (p, n) => (p.extendedData || []).find(e => e.name === n)?.value;
const hashPassword = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(`scrypt$${salt}$${k.toString('hex')}`)));
async function verifyPassword(pw, stored) {
  const [, salt, hex] = String(stored).split('$');
  if (!salt || !hex) return false;
  const again = (await hashPassword(pw, salt)).split('$')[2];
  return crypto.timingSafeEqual(Buffer.from(hex, 'hex'), Buffer.from(again, 'hex'));
}

// ---------- EUR -> USD (Cardmarket prices are EUR; the site shows everything in USD) ----------
// Free daily ECB reference rate via Frankfurter (no key). Cached 24h in memory + file; constant fallback if unreachable.
const FX_FALLBACK = 1.12;
const fx = { rate: null, date: null, source: null, at: 0, loading: null };
function fxNow() {
  if (!fx.rate) { const f = readJSON(path.join(CACHE, 'fx-eurusd.json'), null); if (f?.rate) Object.assign(fx, f); }
  return fx.rate ? { rate: fx.rate, date: fx.date, source: fx.source } : { rate: FX_FALLBACK, date: null, source: 'fallback constant (rate service unreachable)' };
}
async function eurUsd() {
  if (fx.rate && Date.now() - fx.at < 864e5) return fxNow();
  if (!fx.loading) fx.loading = (async () => {
    const f = readJSON(path.join(CACHE, 'fx-eurusd.json'), null, 864e5);
    if (f?.rate) { Object.assign(fx, f); return; }
    for (const url of ['https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD', 'https://api.frankfurter.app/latest?from=EUR&to=USD']) {
      try {
        const j = await getJSON(url, { retries: 1, timeout: 8000 });
        const r = +j?.rates?.USD;
        if (r > 0.5 && r < 3) { Object.assign(fx, { rate: r, date: j.date, source: 'ECB reference rate via frankfurter.dev', at: Date.now() }); writeJSON(path.join(CACHE, 'fx-eurusd.json'), { rate: fx.rate, date: fx.date, source: fx.source, at: fx.at }); return; }
      } catch {}
    }
    if (fx.rate) fx.at = Date.now() - 864e5 + 3600e3; // keep the stale rate, retry in an hour
  })().finally(() => { fx.loading = null; });
  await fx.loading;
  return fxNow();
}
// Convert a Cardmarket price block (EUR) to USD. Keeps eurRate so the UI can say "converted from EUR".
const CM_PRICE_KEYS = /^(avg|low|trend|avg1|avg7|avg30|current)(-holo)?$/;
function cmUsd(cm, rate = fxNow().rate) {
  if (!cm) return cm;
  if (cm.unit === 'USD' && cm.fromEur) return cm;
  const out = { ...cm };
  for (const [k, v] of Object.entries(cm)) if (CM_PRICE_KEYS.test(k) && typeof v === 'number') out[k] = Math.round(v * rate * 100) / 100;
  return Object.assign(out, { unit: 'USD', fromEur: true, eurRate: rate });
}

module.exports = { FX_FALLBACK, fxNow, eurUsd, cmUsd, ROOT, DATA, CACHE, HIST, UA, TCGCSV, TCGDEX, CATEGORIES, sleep, getJSON, getText, readJSON, writeJSON, cacheFile, groupPrices, tcgdexCard, ext, hashPassword, verifyPassword };
