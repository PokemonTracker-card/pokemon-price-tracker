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

module.exports = { ROOT, DATA, CACHE, HIST, UA, TCGCSV, TCGDEX, CATEGORIES, sleep, getJSON, getText, readJSON, writeJSON, cacheFile, groupPrices, tcgdexCard, ext, hashPassword, verifyPassword };
