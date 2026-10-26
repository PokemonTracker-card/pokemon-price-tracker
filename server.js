// Pokémon TCG Price Tracker — Node backend (no npm dependencies).
// Data: TCGCSV (daily TCGplayer prices for English [cat 3] + Japanese [cat 85] cards & sealed packs),
//       TCGdex (Chinese cards + fresh Cardmarket 1/7/30-day averages), PokeAPI (names/sprites).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lib');
const { createStore } = require('./store');
const AL = require('./alerts');
const { checkAlerts } = AL;

const PORT = +process.env.PORT || 8787;
const PROD = process.env.NODE_ENV === 'production';
const HISTORY_DAYS = Math.max(2, +process.env.HISTORY_DAYS || 365); // days of history kept in memory for charts
const store = createStore();
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- invite code ----------
// Production: only the INVITE_CODE env var (sign-up is disabled if it's missing).
// Development: INVITE_CODE, else data/config.json (auto-generated, git-ignored, re-read on every sign-up).
const CONFIG_FILE = path.join(L.DATA, 'config.json');
function loadConfig() {
  const cfg = L.readJSON(CONFIG_FILE, {});
  if (!cfg.inviteCode) { cfg.inviteCode = 'PKMN-' + crypto.randomBytes(4).toString('hex').toUpperCase(); L.writeJSON(CONFIG_FILE, cfg, true); }
  return cfg;
}
function inviteCode() {
  if (process.env.INVITE_CODE && process.env.INVITE_CODE.trim()) return process.env.INVITE_CODE.trim();
  return PROD ? null : loadConfig().inviteCode;
}

// ---------- users / sessions (in memory, written through to the store) ----------
const db = { users: {}, sessions: {} }; // username -> {username, pass, email, favorites:[], createdAt}; token -> {username, expires}
async function loadAccounts() {
  db.users = await store.all('users');
  log(`Loaded ${Object.keys(db.users).length} users from ${store.kind} store (sessions are signed cookies)`);
}
const saveUser = u => store.put('users', u.username, u);

// ---------- text normalisation ----------
const norm = s => ' ' + String(s || '')
  .replace(/♀/g, ' f ').replace(/♂/g, ' m ')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[’'`.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';

// ---------- pull rates ----------
const PULL = L.readJSON(path.join(L.ROOT, 'data', 'pull-rates.json'), { sets: {}, _about: {} });
// Curated prize/trophy cards: CardPrice-only cards TCGplayer doesn't list + extra aliases/citations for TCGplayer ones.
const EVENTS = L.readJSON(path.join(L.ROOT, 'data', 'event-cards.json'), { cards: [], tcgplayer: {} });
function tierFor(card, group) {
  const rates = PULL.sets[String(group.groupId)]?.rates;
  if (!rates || group.cat !== 3) return null;
  if (rates[card.rarity]) return card.rarity;
  const [n, t] = String(card.number).split('/').map(x => parseInt(x, 10));
  const inMain = n && t && n <= t && !/alternate|full art|secret|shiny/i.test(card.name);
  if (inMain && card.rarity === 'Ultra Rare') {
    if (/\bVMAX\b/.test(card.name) && rates['Pokémon VMAX']) return 'Pokémon VMAX';
    if (/\bV(\s|$|\s-)/.test(card.name.replace(/\s-\s.*$/, ' ')) && rates['Pokémon V']) return 'Pokémon V';
  }
  return null;
}
function pullInfo(card, group) {
  const tier = tierFor(card, group);
  if (!tier) return { known: false, reason: card.lang === 'en' ? 'No published pull-rate data for this set/rarity' : 'No published pull-rate data for this language' };
  const oneIn = PULL.sets[String(group.groupId)].rates[tier];
  const count = group.tierCounts?.[tier] || null;
  return { known: true, tier, tierOneIn: oneIn, cardsInTier: count, specificOneIn: count ? Math.round(oneIn * count) : null, source: PULL._about.source, sourceUrl: PULL._about.sourceUrl, asOf: PULL._about.sourceAsOf };
}

// ---------- index (TCGCSV) ----------
const state = { groups: [], groupByKey: new Map(), cards: [], byId: new Map(), packs: new Map(), sealed: [], sealedById: new Map(), packById: new Map(), lastUpdated: null, indexedAt: null, loading: false, progress: { done: 0, total: 0 }, pokemon: [], historyDays: [], storeReady: false, indexSource: null };
const gkey = (cat, id) => `${cat}:${id}`;

// Product lists change rarely (TCGCSV's group modifiedOn tells us when), so they're kept in one store blob and
// only re-fetched for changed groups. This keeps a rebuild after a cold start to ~1 request per group (prices).
let productsCache = null, productsDirty = false; // Map gkey -> {modifiedOn, fetchedAt, items}
async function loadProducts(cat, g, force) {
  const k = gkey(cat, g.groupId);
  let products = productsCache.get(k);
  if (!products) { // migrate the old per-file cache if present
    const old = L.readJSON(L.cacheFile(`products-${cat}-${g.groupId}.json`), null);
    if (old) products = { ...old, fetchedAt: Date.now() };
  }
  if (products && (force || products.modifiedOn !== g.modifiedOn || Date.now() - (products.fetchedAt || 0) > 7 * 864e5)) products = null;
  if (!products) {
    const j = await L.getJSON(`${L.TCGCSV}/${cat}/${g.groupId}/products`);
    products = { modifiedOn: g.modifiedOn, fetchedAt: Date.now(), items: (j?.results || []).map(p => ({
      id: p.productId, name: p.name, img: p.imageUrl, url: p.url,
      number: L.ext(p, 'Number') || null, rarity: L.ext(p, 'Rarity') || null,
      hp: L.ext(p, 'HP') || null, stage: L.ext(p, 'Stage') || null, type: L.ext(p, 'Card Type') || null })) };
    productsDirty = true;
  }
  if (productsCache.get(k) !== products) { productsCache.set(k, products); productsDirty = true; }
  return products.items;
}

const PACK_EXCLUDE = /\b(box|case|bundle|display|blister|code|lot|half|tin|build|bulk|packs|deck|set of)\b/i;
function pickPack(products, priceMap, groupName) {
  const core = groupName.replace(/^[^:]*:\s*/, '').toLowerCase();
  const strip = n => n.toLowerCase().split(core).join(' ');
  const cands = products.filter(p => !p.number && /\bpack(\s*[\[(].*)?$/i.test(p.name) && !PACK_EXCLUDE.test(strip(p.name)) && !/\b(energy|code card)\b/i.test(p.name))
    .map(p => { const pr = (priceMap.get(p.id) || [])[0]; return { id: p.id, name: p.name, img: p.img, url: p.url, sub: pr?.sub ?? null, market: pr?.market ?? null, mid: pr?.mid ?? null, low: pr?.low ?? null }; });
  if (!cands.length) return null;
  const score = c => (/booster pack/i.test(c.name) ? 0 : 3) + (/sleeved/i.test(c.name) ? 2 : 0) + (/\[|\(/.test(c.name) ? 1 : 0) + (c.market == null ? (c.mid == null ? 6 : 4) : 0);
  cands.sort((a, b) => score(a) - score(b) || (a.market ?? 1e9) - (b.market ?? 1e9));
  return cands[0];
}

// ---------- sealed products ----------
const SEALED_TYPES = [
  ['Case', /\bcase\b/i],
  ['Booster Box', /booster box|booster display box|expansion pack box|enhanced expansion box|\b(36|24|18|30|10)[- ]pack box/i],
  ['Elite Trainer Box', /elite trainer box|\betb\b/i],
  ['Booster Bundle', /booster bundle/i],
  ['Display', /\bdisplay\b/i],
  ['Booster Pack', /\b(booster|sleeved booster|expansion) pack\b|\bpack$|\bpack\s*[\[(]/i],
  ['Blister', /blister/i],
  ['Tin', /\btins?\b/i],
  ['Deck', /\bdecks?\b|build\s*(&|and)\s*battle|starter set|battle academy/i],
  ['Collection / Box', /collection|premium|\bbox\b|bundle|gift set|special set/i],
];
const SEALED_EXCLUDE = /code card|\benergy\b|sleeves?\b(?!.*(pack|box))|binder$|playmat|deck box$|coin$|\bjumbo\b|oversize/i;
function sealedType(p) {
  if (p.number || p.hp || p.stage || p.rarity || SEALED_EXCLUDE.test(p.name)) return null;
  for (const [t, re] of SEALED_TYPES) if (re.test(p.name)) return t;
  return null;
}

const INDEX_V = 3; // v2: trainer/item/energy cards included (t:1); v3: unnumbered card-like products (prize/promo cards)
async function buildIndex(force = false) {
  if (state.loading) return; state.loading = true;
  const t0 = Date.now();
  try {
    if (!productsCache) { const b = await store.getBlob('cache:products').catch(e => { log('products cache read failed', e.message); return null; }); productsCache = new Map(b ? Object.entries(b) : []); productsDirty = false; }
    const stamp = await L.getText('https://tcgcsv.com/last-updated.txt').catch(() => new Date().toISOString());
    const groups = [];
    for (const c of L.CATEGORIES) {
      const gj = await L.getJSON(`${L.TCGCSV}/${c.id}/groups`);
      for (const g of gj.results) groups.push({ cat: c.id, lang: c.lang, groupId: g.groupId, name: g.name, abbr: g.abbreviation, published: g.publishedOn, modifiedOn: g.modifiedOn });
    }
    state.progress = { done: 0, total: groups.length };
    log(`Indexing ${groups.length} groups (prices stamp ${stamp})`);
    const cards = [], packs = new Map(), snapshot = {}, sealed = [];
    let i = 0;
    const worker = async () => {
      while (i < groups.length) {
        const g = groups[i++];
        try {
          const products = await loadProducts(g.cat, g, force);
          const prices = await L.groupPrices(g.cat, g.groupId, stamp);
          const priceMap = new Map();
          for (const [id, sub, low, mid, high, market] of prices) {
            if (!priceMap.has(id)) priceMap.set(id, []);
            priceMap.get(id).push({ sub, low, mid, high, market });
            if (market != null) snapshot[`${id}|${sub}`] = market;
          }
          const pack = pickPack(products, priceMap, g.name);
          if (pack) packs.set(gkey(g.cat, g.groupId), pack);
          for (const p of products) { const t = sealedType(p); if (t) sealed.push({ id: p.id, name: p.name, img: p.img, url: p.url, type: t, cat: g.cat, lang: g.lang, groupId: g.groupId, n: p.name.toLowerCase(), prices: priceMap.get(p.id) || [] }); }
          g.tierCounts = {};
          for (const p of products) {
            // Unnumbered products are indexed only if they look like a card (rarity/HP/stage) — this picks up prize/trophy and
            // unnumbered promo cards (e.g. Pokemon Illustrator) while code cards and sealed product stay out.
            if (!p.number && (!(p.rarity || p.hp || p.stage) || /^code card/i.test(p.name))) continue;
            if (p.number) g.tierCounts[p.rarity] = (g.tierCounts[p.rarity] || 0) + 1;
            // Every numbered card is indexed (Pokémon, trainers, items, energy); non-Pokémon get t:1 so the by-Pokémon view skips them.
            const c = { ...p, cat: g.cat, lang: g.lang, groupId: g.groupId, n: norm(p.name.replace(/\s-\s.*$/, '')), prices: priceMap.get(p.id) || [] };
            if (!(p.hp || p.stage)) c.t = 1;
            cards.push(c);
          }
          // SWSH V / VMAX tier counts (regular, main-set numbered)
          const rates = PULL.sets[String(g.groupId)]?.rates || {};
          if (g.cat === 3 && (rates['Pokémon V'] || rates['Pokémon VMAX'])) {
            for (const p of products) { if (!p.number) continue; const t = tierFor(p, g); if (t && t.startsWith('Pokémon')) g.tierCounts[t] = (g.tierCounts[t] || 0) + 1; }
          }
        } catch (e) { log('group failed', g.cat, g.groupId, g.name, e.message); }
        state.progress.done++;
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    for (const g of groups) { // subset -> parent set pack fallback
      const k = gkey(g.cat, g.groupId); if (packs.has(k)) continue;
      const base = g.name.toLowerCase(); let best = null;
      for (const h of groups) {
        if (h.cat !== g.cat || h.groupId === g.groupId || !packs.has(gkey(h.cat, h.groupId)) || h.fromParent) continue;
        const hn = h.name.toLowerCase();
        if (base.startsWith(hn) && base.length > hn.length && (!best || hn.length > best.name.length)) best = h;
      }
      if (best) packs.set(k, { ...packs.get(gkey(best.cat, best.groupId)), fromParent: best.name });
    }
    applyIndex({ v: INDEX_V, stamp, indexedAt: new Date().toISOString(), groups, cards, sealed, packs: [...packs.entries()] });
    state.indexSource = 'built';
    log(`Indexed ${cards.length} cards (${cards.filter(c => c.t).length} trainer/energy, ${cards.filter(c => c.lang === 'ja').length} Japanese), ${packs.size} sets with a pack price, ${sealed.length} sealed products in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    // Persist: today's price snapshot (tracked products only), the index (for fast cold starts), the product cache.
    const tracked = new Set([...cards.map(c => c.id), ...sealed.map(x => x.id), ...[...packs.values()].map(p => p.id)]);
    const snap = {}; for (const [k, m] of Object.entries(snapshot)) if (tracked.has(+k.split('|')[0])) snap[k] = m;
    const day = String(stamp).slice(0, 10);
    try {
      await store.putBlob(`history:${day}`, snap); histAddDay(day, snap);
      if (!state.historyDays.includes(day)) state.historyDays = [...state.historyDays, day].sort();
      await store.putBlob('index:latest', indexSnapshot());
      if (productsDirty) { await store.putBlob('cache:products', Object.fromEntries(productsCache)); productsDirty = false; }
      log(`Saved index + history ${day} to ${store.kind} store`);
    } catch (e) { log('saving index/history failed', e.message); }
  } finally { state.loading = false; productsCache = null; }
}
function indexSnapshot() { return { v: INDEX_V, stamp: state.lastUpdated, indexedAt: state.indexedAt, groups: state.groups, cards: state.cards, sealed: state.sealed, packs: [...state.packs.entries()] }; }
function applyIndex(s) {
  state.groups = s.groups; state.groupByKey = new Map(s.groups.map(g => [gkey(g.cat, g.groupId), g]));
  state.sealed = s.sealed; state.sealedById = new Map(s.sealed.map(x => [x.id, x]));
  state.cards = s.cards; state.byId = new Map(s.cards.map(c => [c.id, c])); state.packs = new Map(s.packs);
  state.packById = new Map(s.packs.map(([k, p]) => [p.id, { ...p, groupKey: k }]));
  state.lastUpdated = s.stamp; state.indexedAt = s.indexedAt;
  state.progress = { done: s.groups.length, total: s.groups.length };
  state.indexV = s.v || 1;
  buildCardSearch();
}

// ---------- price history (self-recorded daily snapshots) ----------
// Compact in-memory layout: one Float32Array per day indexed by a shared key index ("productId|subType").
// Loaded lazily on the first human request (not on health checks / the alert job) to keep DB egress low.
const hist = { days: [], cols: [], keyIdx: new Map(), loaded: false, loading: null };
function histAddDay(d, snap) {
  for (const k of Object.keys(snap)) if (!hist.keyIdx.has(k)) hist.keyIdx.set(k, hist.keyIdx.size);
  const col = new Float32Array(hist.keyIdx.size).fill(NaN);
  for (const [k, m] of Object.entries(snap)) if (typeof m === 'number') col[hist.keyIdx.get(k)] = m;
  const i = hist.days.indexOf(d);
  if (i >= 0) { hist.cols[i] = col; return; }
  let at = hist.days.findIndex(x => x > d); if (at < 0) at = hist.days.length;
  hist.days.splice(at, 0, d); hist.cols.splice(at, 0, col);
  while (hist.days.length > HISTORY_DAYS) { hist.days.shift(); hist.cols.shift(); }
}
function histPoints(key) {
  const idx = hist.keyIdx.get(key); if (idx === undefined) return [];
  const out = [];
  hist.days.forEach((d, i) => { const v = idx < hist.cols[i].length ? hist.cols[i][idx] : NaN; if (!Number.isNaN(v)) out.push({ d, m: Math.round(v * 100) / 100 }); });
  return out;
}
function ensureHistory() {
  if (hist.loaded) return Promise.resolve();
  if (!hist.loading) hist.loading = (async () => {
    const t0 = Date.now();
    const names = (await store.listBlobs('history:')).slice(-HISTORY_DAYS);
    const snaps = await pool(names, 4, n => store.getBlob(n));
    names.forEach((n, i) => { if (snaps[i] && !hist.days.includes(n.slice(8))) histAddDay(n.slice(8), snaps[i]); });
    hist.loaded = true; log(`Loaded ${hist.days.length} days of price history in ${Date.now() - t0}ms`);
  })().catch(e => { log('history load failed', e.message); hist.loading = null; });
  return hist.loading;
}
const withHistory = () => Promise.race([ensureHistory(), L.sleep(8000)]);

// ---------- PokeAPI ----------
const SPECIAL = { 'mr-mime': 'Mr. Mime', 'mime-jr': 'Mime Jr.', 'mr-rime': 'Mr. Rime', farfetchd: "Farfetch'd", sirfetchd: "Sirfetch'd", 'nidoran-f': 'Nidoran♀', 'nidoran-m': 'Nidoran♂', 'ho-oh': 'Ho-Oh', 'porygon-z': 'Porygon-Z', 'jangmo-o': 'Jangmo-o', 'hakamo-o': 'Hakamo-o', 'kommo-o': 'Kommo-o', 'type-null': 'Type: Null', flabebe: 'Flabébé', 'chi-yu': 'Chi-Yu', 'chien-pao': 'Chien-Pao', 'ting-lu': 'Ting-Lu', 'wo-chien': 'Wo-Chien' };
const display = slug => SPECIAL[slug] || slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
async function loadPokemon() {
  const cached = await store.getBlob('cache:pokemon').catch(() => null);
  let list = cached && Date.now() - cached.at < 30 * 864e5 ? cached.list : null;
  if (!list) {
    try {
      const j = await L.getJSON('https://pokeapi.co/api/v2/pokemon-species?limit=2000');
      list = j.results.map(r => { const id = +r.url.match(/\/(\d+)\/?$/)[1]; return { id, slug: r.name, name: display(r.name), sprite: `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${id}.png` }; }).sort((a, b) => a.id - b.id);
      await store.putBlob('cache:pokemon', { at: Date.now(), list }).catch(e => log('pokemon cache write failed', e.message));
    } catch (e) { if (!cached) throw e; list = cached.list; log('PokeAPI failed, using stale list', e.message); }
  }
  state.pokemon = list; log(`Loaded ${list.length} Pokémon species`);
}

// ---------- TCGdex (Chinese cards; Cardmarket trends) ----------
async function tcgdexList(lang, dexId) {
  const f = L.cacheFile(`tcgdexlist-${lang}-${dexId}.json`);
  let l = L.readJSON(f, null, 864e5);
  if (!l) { l = await L.getJSON(`${L.TCGDEX}/${lang}/cards?dexId=eq:${dexId}`, { retries: 2 }) || []; L.writeJSON(f, l); }
  return l;
}
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(() => null); } })); return out; }
const cmPrice = cm => cm ? (cm.trend || cm.avg || cm['trend-holo'] || cm['avg-holo'] || null) : null;
async function chineseCards(lang, dexId) {
  const list = await tcgdexList(lang, dexId);
  const details = await pool(list.slice(0, 80), 6, x => L.tcgdexCard(lang, x.id));
  return details.filter(Boolean).map(c => zhCard(lang, c));
}
const cmTrendCache = new Map();
async function cardmarketTrend(productId, dexId) {
  const k = `${productId}`; if (cmTrendCache.has(k)) return cmTrendCache.get(k);
  const c = state.byId.get(+productId);
  if (!c || !dexId) return { found: false, reason: 'Unknown card' };
  const lang = c.lang === 'ja' ? 'ja' : 'en';
  const num = String(c.number).split('/')[0].replace(/^0+(?=\d)/, '').toLowerCase();
  let list;
  try { list = await tcgdexList(lang, dexId); } catch { return { found: false, reason: 'TCGdex is not responding right now' }; }
  const cands = list.filter(x => String(x.localId).replace(/^0+(?=\d)/, '').toLowerCase() === num);
  const details = await pool(cands.slice(0, 12), 4, x => L.tcgdexCard(lang, x.id));
  let hit = details.find(d => d && (d.variants_detailed || []).some(v => +v.thirdParty?.tcgplayer === +productId));
  if (!hit && lang === 'ja') { // TCGdex's Japanese dexId index is incomplete: try "<SETCODE>-<number>" directly
    const g = state.groupByKey.get(gkey(c.cat, c.groupId));
    const code = (g.name.match(/^([A-Za-z0-9-]+):/) || [])[1];
    const raw = String(c.number).split('/')[0];
    if (code) for (const id of [`${code}-${raw}`, `${code}-${raw.padStart(3, '0')}`]) {
      const d = await L.tcgdexCard('ja', id).catch(() => null);
      if (d && (d.variants_detailed || []).some(v => +v.thirdParty?.tcgplayer === +productId)) { hit = d; break; }
    }
  }
  let r;
  if (!hit) r = { found: false, reason: 'No Cardmarket listing linked to this exact TCGplayer product in TCGdex' };
  else {
    const v = hit.variants_detailed.find(v => +v.thirdParty?.tcgplayer === +productId);
    const eur = v?.pricing?.cardmarket || hit.pricing?.cardmarket;
    const cm = L.cmUsd(eur);
    r = cm ? { found: true, tcgdexId: hit.id, set: hit.set?.name, unit: 'USD', fromEur: true, eurRate: cm.eurRate, updated: cm.updated, avg30: cm.avg30, avg7: cm.avg7, avg1: cm.avg1, trend: cm.trend, avg: cm.avg, low: cm.low,
      holo: { avg30: cm['avg30-holo'], avg7: cm['avg7-holo'], avg1: cm['avg1-holo'], trend: cm['trend-holo'] }, url: `https://www.cardmarket.com/en/Pokemon/Products?idProduct=${cm.idProduct}` }
      : { found: false, reason: 'Card found on TCGdex but it has no Cardmarket prices' };
  }
  cmTrendCache.set(k, r); setTimeout(() => cmTrendCache.delete(k), 6 * 3600e3);
  return r;
}

// ---------- search ----------
function serializeCard(c, prices = c.prices) {
  const g = state.groupByKey.get(gkey(c.cat, c.groupId));
  return {
    id: c.id, source: 'tcgcsv', lang: c.lang, name: c.name, number: c.number, rarity: c.rarity, img: c.img, url: c.url,
    event: CS.ev.has(c.id) ? { kind: CS.ev.get(c.id), label: EVENT_LABEL[CS.ev.get(c.id)], note: EVENTS.tcgplayer[c.id]?.note || null, reportedSales: EVENTS.tcgplayer[c.id]?.reportedSales || null, pricecharting: EVENTS.tcgplayer[c.id]?.pricecharting || null } : null,
    set: { id: g.groupId, cat: g.cat, name: g.name, abbr: g.abbr, released: g.published },
    prices, pack: state.packs.get(gkey(c.cat, c.groupId)) || null,
    packNote: state.packs.has(gkey(c.cat, c.groupId)) ? null : 'No single booster pack is sold for this set (promo/deck/special product) or none is listed on TCGplayer',
    pull: pullInfo(c, g),
    history: prices.map(p => ({ sub: p.sub, points: histPoints(`${c.id}|${p.sub}`) })),
  };
}
// ---------- editions (WotC-era 1st Edition / Shadowless / Unlimited) ----------
// TCGplayer keeps 1st Edition and Unlimited of the same card as separate price rows ("1st Edition Holofoil" vs "Unlimited Holofoil")
// on one product. Base Set is split into two groups: "Base Set (Shadowless)" (1st Edition rows + Shadowless unlimited rows) and
// "Base Set" (the later, shadowed Unlimited print). Each edition is shown as its own entry so 1st Edition prices aren't hidden.
const edOf = sub => /^1st edition/i.test(sub || '') ? '1st' : /^unlimited/i.test(sub || '') ? 'unl' : null;
function editionLabel(c, ed) {
  const g = state.groupByKey.get(gkey(c.cat, c.groupId)); const shadowless = /shadowless/i.test(g?.name || '');
  if (ed === '1st') return shadowless ? '1st Edition (Shadowless)' : '1st Edition';
  if (ed === 'unl') return shadowless ? 'Shadowless (Unlimited)' : 'Unlimited';
  if (c.cat === 3 && g?.name === 'Base Set') return 'Unlimited';
  return null;
}
const famPrice = ps => { const m = ps.filter(p => p.market != null); if (m.length) return Math.max(...m.map(p => p.market)); const d = ps.filter(p => p.mid != null); return d.length ? Math.max(...d.map(p => p.mid)) : null; };
function editionEntries(c, extra = {}) {
  const has1st = c.prices.some(p => edOf(p.sub) === '1st');
  if (!has1st) { const lab = editionLabel(c, c.prices.some(p => edOf(p.sub) === 'unl') ? 'unl' : null); return [{ ...serializeCard(c), ...extra, edition: lab ? 'unl' : null, editionLabel: lab, vkey: `${c.id}` }]; }
  const fams = [['1st', c.prices.filter(p => edOf(p.sub) === '1st')], ['unl', c.prices.filter(p => edOf(p.sub) !== '1st')]].filter(f => f[1].length);
  return fams.map(([ed, ps]) => ({
    ...serializeCard(c, ps), ...extra, edition: ed, editionLabel: editionLabel(c, ed), vkey: `${c.id}:${ed}`,
    otherEditions: fams.filter(f => f[0] !== ed).map(([e2, p2]) => ({ edition: e2, label: editionLabel(c, e2), price: famPrice(p2), subs: p2.map(p => p.sub) })),
  }));
}
// "1st edition charizard", "charizard base set 1st", "unlimited" -> edition filter + the remaining words.
function editionQuery(q) {
  let ed = null;
  q = String(q).replace(/\b(1st|first)(\s*(ed\.?|edition))?\b/gi, () => { ed = '1st'; return ' '; })
    .replace(/\bunlimited\b/gi, () => { ed = ed || 'unl'; return ' '; }).replace(/\s+/g, ' ').trim();
  return { q, ed };
}
async function search(name, langs) {
  const q = norm(name);
  if (q.trim().length < 2) return { cards: [], notes: [] };
  const want = new Set(langs);
  const curated = id => { const pk = EVENTS.tcgplayer[id]?.pokemon; return pk && norm(pk) === q; };
  const out = state.cards.filter(c => want.has(c.lang) && ((!c.t && c.n.includes(q)) || curated(c.id))).flatMap(c => editionEntries(c));
  if (want.has('ja')) out.push(...EVENTS.cards.filter(e => e.pokemon && norm(e.pokemon) === q).map(serializeCurated));
  const mk = c => Math.max(-1, ...c.prices.map(p => p.market ?? -1));
  const mid = c => Math.max(-1, ...c.prices.map(p => p.mid ?? -1));
  const pr = c => { if (c.source === 'cardprice') return c.cp?.sortPrice ?? -1; const m = mk(c); return m >= 0 ? m : mid(c); };
  out.sort((a, b) => pr(b) - pr(a));
  const notes = [];
  const zh = langs.filter(l => l.startsWith('zh'));
  if (zh.length) {
    const p = state.pokemon.find(p => norm(p.name) === q);
    if (!p) notes.push('Chinese cards are looked up by Pokédex number — pick a Pokémon from the list to include them.');
    else for (const l of zh) {
      try { const zc = await chineseCards(l, p.id); zc.sort((a, b) => (b.cardmarket?.current || 0) - (a.cardmarket?.current || 0)); out.push(...zc); }
      catch (e) { notes.push(`Couldn't reach TCGdex for ${l} cards right now.`); }
    }
  }
  return { cards: out, notes };
}

// ---------- specific-card search (name + optional set name/code and/or card number) ----------
// Inverted index built once per price index: name word -> card idx, set word -> group keys, card number -> card idx.
// A query only touches the posting lists of its own tokens (no full-catalog scan per keystroke).
const numKey = s => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/(^|[^0-9])0+(?=\d)/g, '$1');
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
// ---------- prize / trophy / event cards ----------
const PRIZE_GROUPS = new Set(['85:24521', '3:24529', '85:24494', '85:24205', '85:24203', '85:24197']);
const EVENT_GROUPS = new Set(['3:22880', '3:2282', '3:1539', '3:2332', '85:24194', '85:24200', '85:24199', '85:24198', '85:24053', '85:23802']);
const PRIZE_RX = /\btrophy\b|illustrator|\bno\.? ?[123] trainer|\bnumber [123] trainer|tropical (wind|tidal wave|mega battle|beach)|lucky stadium|victory (orb|ring|cup|medal)|champion'?s league|championship arena|elite four trainer|\[(1st|2nd|3rd|4th) place|\bwinner\b|\[top \d+|\bfinalist\b|\[champion\]|(comic|ichiban!?) competition|super secret battle|secret super battle|master'?s key/i;
const EVENT_RX = /\[staff\]|championships?\b|\bworlds?\b|\bwcs\b|prize pack|\(pokemon league\)|league (promo|challenge|cup)|player rewards|prerelease|professor program|battle road|world hobby fair|corocoro|\bcampaign\b|\bmagazine\b|\[participation\]|illustration contest|\bpre-?release\b|\bevent\b/i;
function eventKind(c, gname) {
  const cur = EVENTS.tcgplayer[c.id]; if (cur?.kind) return cur.kind;
  const k = gkey(c.cat, c.groupId);
  if (PRIZE_RX.test(c.name) || PRIZE_GROUPS.has(k)) return 'prize';
  if (EVENT_RX.test(c.name) || EVENT_GROUPS.has(k) || /championship|prize pack|professor program|corocoro|world hobby fair|battle road|card information/i.test(gname)) return 'event';
  return null;
}
const EVENT_LABEL = { prize: 'Prize/Trophy', event: 'Event promo' };
function eventKeywords(c, kind, gname) {
  const w = ['card', 'event', 'promo'];
  if (kind === 'prize') w.push('trophy', 'prize', 'tournament', 'competition');
  if (/world|wcs/i.test(`${c.name} ${gname}`)) w.push('worlds', 'world', 'championship', 'championships');
  if (/championship/i.test(`${c.name} ${gname}`)) w.push('championship', 'championships', 'tournament');
  if (/prize pack/i.test(`${c.name} ${gname}`)) w.push('prize', 'pack');
  if (/\[staff\]/i.test(c.name)) w.push('staff');
  for (const a of EVENTS.tcgplayer[c.id]?.aliases || []) w.push(...norm(a).trim().split(' '));
  return ` ${[...new Set(w)].join(' ')} `;
}
const CS = { kw: new Map(), ev: new Map(), nameIdx: new Map(), nameVocab: [], setIdx: new Map(), setVocab: [], groupCards: new Map(), gnorm: new Map(), numIdx: new Map() };
function buildCardSearch() {
  const t0 = Date.now();
  const nameIdx = new Map(), setIdx = new Map(), groupCards = new Map(), gnorm = new Map(), numIdx = new Map();
  const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, a = []); a.push(v); };
  for (const g of state.groups) {
    const k = gkey(g.cat, g.groupId), n = norm(`${g.name} ${g.abbr || ''}`);
    gnorm.set(k, n);
    for (const w of new Set(n.trim().split(' '))) if (w) push(setIdx, w, k);
  }
  const kw = new Map(), ev = new Map();
  state.cards.forEach((c, i) => {
    for (const w of new Set(c.n.trim().split(' '))) if (w) push(nameIdx, w, i);
    const gname = state.groupByKey.get(gkey(c.cat, c.groupId))?.name || '';
    const kind = eventKind(c, gname);
    if (kind) { ev.set(c.id, kind); const k = eventKeywords(c, kind, gname); kw.set(i, k); for (const w of k.trim().split(' ')) if (!c.n.includes(` ${w} `)) push(nameIdx, w, i); }
    push(groupCards, gkey(c.cat, c.groupId), i);
    if (c.number) { const full = numKey(c.number), first = full.split('/')[0]; push(numIdx, first, i); if (full !== first) push(numIdx, full, i); }
  });
  Object.assign(CS, { kw, ev, nameIdx, nameVocab: [...nameIdx.keys()].sort(), setIdx, setVocab: [...setIdx.keys()].sort(), groupCards, gnorm, numIdx });
  log(`Card search index: ${ev.size} prize/event cards (${[...ev.values()].filter(k => k === 'prize').length} prize/trophy), ${nameIdx.size} name words, ${setIdx.size} set words, ${numIdx.size} numbers in ${Date.now() - t0}ms`);
}
function prefixWords(vocab, t) { // sorted vocab -> words starting with t (binary search for the first)
  let lo = 0, hi = vocab.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (vocab[m] < t) lo = m + 1; else hi = m; }
  const out = []; for (let i = lo; i < vocab.length && vocab[i].startsWith(t); i++) out.push(vocab[i]);
  return out;
}
function parseQuery(q) {
  const raw = String(q || '').toLowerCase().replace(/[#№]/g, ' ').replace(/\s*\/\s*/g, '/').trim();
  const toks = [];
  for (const r of raw.split(/\s+/).filter(Boolean)) {
    if (/^[a-z]{0,5}-?\d+[a-z]?\/[a-z]{0,5}\d+$/.test(r)) { toks.push({ t: r, num: numKey(r), slash: true }); continue; }
    for (const w of norm(r).trim().split(' ').filter(Boolean)) toks.push({ t: w, num: /\d/.test(w) && /^[a-z]{0,5}\d+[a-z]?$/.test(w) ? numKey(w) : null });
  }
  return toks;
}
function tokenCandidates(tok) {
  const out = new Set();
  if (!tok.slash) {
    const words = tok.t.length >= 2 ? prefixWords(CS.nameVocab, tok.t) : (CS.nameIdx.has(tok.t) ? [tok.t] : []);
    for (const w of words) for (const i of CS.nameIdx.get(w)) out.add(i);
    const sw = tok.t.length >= 2 ? prefixWords(CS.setVocab, tok.t) : (CS.setIdx.has(tok.t) ? [tok.t] : []);
    for (const w of sw) for (const k of CS.setIdx.get(w)) for (const i of CS.groupCards.get(k) || []) out.add(i);
  }
  if (tok.num) for (const i of CS.numIdx.get(tok.num) || []) out.add(i);
  return out;
}
function tokenScore(c, tok, i) { // best way this token matches this card, or 0
  let s = 0;
  if (tok.num && c.number) { const full = numKey(c.number); if (full === tok.num || full.split('/')[0] === tok.num) s = tok.slash ? 12 : 9; }
  if (tok.slash) return s;
  if (c.n.includes(` ${tok.t} `)) s = Math.max(s, 10); else if (tok.t.length >= 2 && c.n.includes(` ${tok.t}`)) s = Math.max(s, 6);
  const kw = CS.kw.get(i);
  if (kw) { if (kw.includes(` ${tok.t} `)) s = Math.max(s, 5); else if (tok.t.length >= 2 && kw.includes(` ${tok.t}`)) s = Math.max(s, 3); }
  const gn = CS.gnorm.get(gkey(c.cat, c.groupId)) || '';
  if (gn.includes(` ${tok.t} `)) s = Math.max(s, 6); else if (tok.t.length >= 2 && gn.includes(` ${tok.t}`)) s = Math.max(s, 4);
  return s;
}
const bestPrice = c => Math.max(-1, ...c.prices.map(p => p.market ?? p.mid ?? -1));
function indexCardSearch(toks, want, limit, sort = 'price') {
  if (!toks.length) return { total: 0, hits: [] };
  const cands = toks.map(tokenCandidates).sort((a, b) => a.size - b.size);
  const hits = [];
  for (const i of cands[0]) {
    const c = state.cards[i]; if (!want.has(c.lang)) continue;
    let score = 0, nameHits = 0, ok = true;
    for (const tok of toks) { const s = tokenScore(c, tok, i); if (!s) { ok = false; break; } score += s; if (s === 10 || s === 6) nameHits++; }
    if (!ok) continue;
    const nameWords = c.n.trim().split(' ').length;
    if (nameHits && nameHits >= nameWords) score += 8; // query covers the whole card name ("Charizard ex" vs "Charizard ex Special Delivery")
    hits.push({ i, score, price: bestPrice(c) });
  }
  const maxScore = hits.reduce((m, h) => Math.max(m, h.score), 0);
  if (sort === 'match') hits.sort((a, b) => b.score - a.score || b.price - a.price);
  else hits.sort((a, b) => b.price - a.price || b.score - a.score); // default: most expensive first, unpriced (-1) last
  return { total: hits.length, maxScore, hits: hits.slice(0, limit) };
}
let pokemonNorms = null;
function dexFor(c) {
  const cur = EVENTS.tcgplayer[c.id]?.pokemon;
  if (cur && state.pokemon.length) return state.pokemon.find(p => p.name === cur)?.id || null;
  if (c.t || !state.pokemon.length) return null;
  if (!pokemonNorms || pokemonNorms.src !== state.pokemon) pokemonNorms = { src: state.pokemon, list: state.pokemon.map(p => ({ id: p.id, n: norm(p.name) })).sort((a, b) => b.n.length - a.n.length) };
  return pokemonNorms.list.find(p => c.n.includes(p.n))?.id || null;
}
function zhCard(lang, c) {
  const cm = L.cmUsd(c.pricing?.cardmarket || null); // shown in USD, converted from Cardmarket's EUR
  return {
    id: `tcgdex:${lang}:${c.id}`, source: 'tcgdex', tcgdexId: c.id, lang, name: c.name, number: `${c.localId}${c.set?.cardCount?.official ? '/' + c.set.cardCount.official : ''}`,
    rarity: c.rarity || null, img: c.image ? `${c.image}/high.webp` : null, url: cm?.idProduct ? `https://www.cardmarket.com/en/Pokemon/Products?idProduct=${cm.idProduct}` : null,
    set: { id: c.set?.id, name: c.set?.name || c.set?.id, abbr: c.set?.id, released: null },
    prices: [], cardmarket: cm ? { ...cm, current: cmPrice(cm) } : null, category: c.category || null,
    pack: null, packNote: 'No booster pack price source for Chinese-language sets',
    pull: { known: false, reason: 'No published pull-rate data for Chinese sets' }, history: [],
  };
}
async function tcgdexNameList(lang, q) {
  const f = L.cacheFile(`tcgdexname-${lang}-${crypto.createHash('sha1').update(q).digest('hex').slice(0, 16)}.json`);
  let l = L.readJSON(f, null, 864e5);
  if (!l) { l = await L.getJSON(`${L.TCGDEX}/${lang}/cards?name=like:${encodeURIComponent(q)}`, { retries: 1 }) || []; L.writeJSON(f, l); }
  return l;
}
const ZH_SUFFIX = new Set(['ex', 'gx', 'v', 'vmax', 'vstar', 'lv', 'x', 'break', 'prime', 'star']);
async function chineseCardSearch(q, toks, langs, notes) {
  const out = [];
  const nums = toks.filter(t => t.num).map(t => t.num);
  let mode, dexId = null, suffix = [];
  if (CJK.test(q)) mode = 'name';
  else {
    const qn = norm(toks.filter(t => !t.slash).map(t => t.t).join(' '));
    const p = state.pokemon.map(p => ({ id: p.id, n: norm(p.name) })).filter(p => qn.includes(p.n)).sort((a, b) => b.n.length - a.n.length)[0];
    if (!p) { notes.push('Chinese cards: type the Chinese name (e.g. 噴火龍) or an English Pokémon name to include them — trainer/item names only match in Chinese.'); return out; }
    mode = 'dex'; dexId = p.id; suffix = qn.replace(p.n, ' ').trim().split(' ').filter(w => ZH_SUFFIX.has(w));
  }
  const codes = toks.filter(t => !t.slash && /^[a-z]{1,5}\d+[a-z]?$/.test(t.t)).map(t => t.t);
  for (const lang of langs) {
    try {
      let list = mode === 'name' ? await tcgdexNameList(lang, q.replace(/[^\u3040-\u30ff\u3400-\u9fff\uf900-\ufaffa-zA-Z0-9]+/g, ' ').trim().split(' ').find(w => CJK.test(w)) || q.trim()) : await tcgdexList(lang, dexId);
      if (nums.length) list = list.filter(x => nums.includes(numKey(x.localId)) || codes.some(cd => x.id.toLowerCase().startsWith(cd + '-')));
      else if (codes.length) list = list.filter(x => codes.some(cd => x.id.toLowerCase().startsWith(cd + '-')));
      if (suffix.length) list = list.filter(x => suffix.every(s => String(x.name).toLowerCase().includes(s)));
      const details = await pool(list.slice(0, 12), 6, x => L.tcgdexCard(lang, x.id));
      const cs = details.filter(Boolean).map(c => ({ ...zhCard(lang, c), dexId }));
      cs.sort((a, b) => (b.cardmarket?.current || 0) - (a.cardmarket?.current || 0));
      out.push(...cs);
      if (list.length > 12) notes.push(`${list.length} ${lang} matches — showing 12; add a card number or set code (e.g. SV2a) to narrow it.`);
    } catch (e) { notes.push(`Couldn't reach TCGdex for ${lang} cards right now.`); }
  }
  if (out.length) notes.push('Chinese cards come from TCGdex: names and set names are in Chinese, so English set names can’t filter them — use the card number or set code.');
  return out;
}
async function cardSearch(q0, langs, { zh = false, limit = 60, sort = 'price' } = {}) {
  const { q, ed } = editionQuery(q0);
  const outLimit = limit; if (ed) limit = 600;
  const toks = parseQuery(q);
  const notes = [];
  const cjk = CJK.test(q);
  if ((!toks.length && !cjk) || String(q).trim().length < (cjk ? 1 : 2)) return { total: 0, cards: [], notes };
  if (cjk && !zh) notes.push('Chinese/Japanese characters: press Enter (or Search) with Chinese selected to search Chinese cards by name; English/Japanese cards are indexed by their English names.');
  const want = new Set(langs.filter(l => l === 'en' || l === 'ja'));
  let r = want.size && toks.length ? indexCardSearch(toks, want, limit, sort) : { total: 0, hits: [] };
  if (!r.total && toks.length > 1 && want.size) { // nothing matches every word: show the best partial match (drop one word)
    let best = null;
    for (let k = 0; k < toks.length; k++) { const rr = indexCardSearch(toks.filter((_, j) => j !== k), want, limit, sort); if (rr.total && (!best || rr.maxScore > best.r.maxScore)) best = { r: rr, dropped: toks[k].t }; }
    if (best) { r = best.r; notes.push(`No card matches every word — showing matches without “${best.dropped}”.`); }
  }
  let cards = r.hits.flatMap(h => { const c = state.cards[h.i]; return editionEntries(c, { dexId: dexFor(c), kind: c.t && !EVENTS.tcgplayer[c.id]?.pokemon ? 'trainer' : 'pokemon' }); });
  if (ed) {
    cards = cards.filter(c => c.edition === ed);
    r = { ...r, total: cards.length };
    notes.push(cards.length ? `Showing ${ed === '1st' ? '1st Edition' : 'Unlimited'} printings only.` : `No ${ed === '1st' ? '1st Edition' : 'Unlimited'} printing matches — 1st Edition exists for Wizards of the Coast-era English sets (1999–2003) and some Japanese sets.`);
    cards = cards.slice(0, outLimit);
  }
  if (want.has('ja') && !ed && toks.length) { const cur = curatedSearch(toks); if (cur.length) { cards.push(...cur); r = { ...r, total: r.total + cur.length }; } }
  const zhLangs = langs.filter(l => l.startsWith('zh'));
  if (zh && zhLangs.length && !ed && !/^\s*[a-z]{0,5}\d+\s*\/\s*[a-z]{0,5}\d+\s*$/i.test(q)) cards.push(...await chineseCardSearch(q, toks, zhLangs, notes));
  if (sort !== 'match') { const pr = c => c.source === 'tcgdex' ? (c.cardmarket?.current ?? -1) : c.source === 'cardprice' ? (c.cp?.sortPrice ?? -1) : Math.max(-1, ...c.prices.map(p => p.market ?? p.mid ?? -1)); cards.sort((a, b) => pr(b) - pr(a)); }
  // A query that names a curated card exactly (e.g. "pikachu illustrator") pins it first even when it has no price to sort by.
  const qn = norm(q).trim(), pinned = c => c.source === 'tcgcsv' && EVENTS.tcgplayer[c.id]?.pin === true && (EVENTS.tcgplayer[c.id]?.aliases || []).some(a => norm(a).trim() === qn);
  if (cards.some(pinned)) { cards.sort((a, b) => pinned(b) - pinned(a)); notes.push('Exact match pinned first; it has no tracked price, so a price sort would otherwise put it last.'); }
  if (cards.some(c => c.event)) notes.push('Prize/trophy and event cards trade rarely: prices can be a single old sale or only an asking price — open a card to see its sale count and data source.');
  return { total: r.total, cards, notes };
}

// ---------- graded prices (CardPrice open API: https://api.cardprice.com — free, no key, attribution required) ----------
// Keyed by TCGplayer productId. Cached in memory for 24h (incl. "not found"), capped so the small Render instance stays small.
const GRADED_TTL = 864e5, GRADED_MAX = 1500;
const gradedCache = new Map(), gradedInflight = new Map();
let gradedActive = 0; const gradedQueue = [];
const gradedSlot = () => new Promise(r => { if (gradedActive < 3) { gradedActive++; r(); } else gradedQueue.push(r); });
const gradedRelease = () => { const n = gradedQueue.shift(); if (n) n(); else gradedActive--; };
async function cardpriceJSON(pathname) {
  await gradedSlot();
  try {
    for (let i = 0; ; i++) {
      const j = await L.getJSON(`https://api.cardprice.com${pathname}`, { retries: 1, timeout: 12000 });
      if (j?.error !== 'warming' || i >= 2) return j?.error ? null : j; // CardPrice answers {"error":"warming"} while its cache fills
      await new Promise(r => setTimeout(r, 1000 * (j.retry || 2)));
    }
  } finally { gradedRelease(); }
}
const GRADE_ROWS = [['psa10', 'PSA 10', 'psa'], ['bgs10', 'BGS 10', 'bgs'], ['cgc10', 'CGC 10', 'cgc'], ['sgc10', 'SGC 10', 'sgc'], ['grade95', 'Grade 9.5', null], ['grade9', 'Grade 9', null], ['grade8', 'Grade 8', null], ['grade7', 'Grade 7', null], ['ungraded', 'Ungraded (raw)', null]];
// CardPrice card record for a TCGplayer product, trimmed to what we use (cached 24h, incl. misses).
async function cardpriceCard(id) {
  const hit = gradedCache.get(id);
  if (hit && Date.now() - hit.at < GRADED_TTL) return hit.card;
  if (gradedInflight.has(id)) return gradedInflight.get(id);
  const job = (async () => {
    const prod = await cardpriceJSON(`/api/product/${id}`);
    const cardId = prod?.product?.card_id;
    const full = cardId ? await cardpriceJSON(`/api/card/${encodeURIComponent(cardId)}`) : null;
    const card = full?.card ? { card: { id: full.card.id, name: full.card.name, slug: full.card.slug }, variants: (full.variants || []).filter(v => +v.productId === id).map(v => ({ printing: v.printing, label: v.label, subType: v.subType })),
      gradedPrintings: full.gradedPrintings, graded: full.graded, population: full.population } : null;
    if (gradedCache.size >= GRADED_MAX) gradedCache.delete(gradedCache.keys().next().value);
    gradedCache.set(id, { at: Date.now(), card });
    return card;
  })().finally(() => gradedInflight.delete(id));
  gradedInflight.set(id, job);
  return job;
}
// Which CardPrice "printing" a TCGplayer variant is: 1st Edition rows map to CardPrice's "1st Edition" printing,
// otherwise the variant's own printing (e.g. "Shadowless") if CardPrice grades it separately, else the base ("") printing.
function cpPrintingFor(v, printings) {
  const is1st = /1st edition/i.test(`${v.subType || ''} ${v.label || ''}`);
  if (is1st) return printings.find(p => /1st edition/i.test(p) && v.printing && p.includes(v.printing)) || printings.find(p => /^1st edition$/i.test(p)) || printings.find(p => /1st edition/i.test(p)) || null;
  if (v.printing && printings.includes(v.printing)) return v.printing;
  return printings.includes('') ? '' : null;
}
async function cardpriceCardById(cpId) {
  const k = `cp:${cpId}`, hit = gradedCache.get(k);
  if (hit && Date.now() - hit.at < GRADED_TTL) return hit.card;
  const full = await cardpriceJSON(`/api/card/${encodeURIComponent(cpId)}`);
  const card = full?.card ? { card: { id: full.card.id, name: full.card.name, slug: full.card.slug }, variants: [], gradedPrintings: full.gradedPrintings, graded: full.graded, population: full.population } : null;
  if (gradedCache.size >= GRADED_MAX) gradedCache.delete(gradedCache.keys().next().value);
  gradedCache.set(k, { at: Date.now(), card });
  return card;
}
async function gradedFor(productId, subType = null, cpId = null) {
  const id = +productId;
  const c = cpId ? null : state.byId.get(id);
  const card = cpId ? await cardpriceCardById(cpId) : await cardpriceCard(id);
  const ed = edOf(subType);
  let r;
  {
    if (!card?.card) r = { available: false, reason: 'CardPrice has no record of this exact TCGplayer product yet.' };
    else {
      let rows = (card.gradedPrintings?.length ? card.gradedPrintings : card.graded ? [card.graded] : []).filter(Boolean);
      const names = rows.map(g => g.printing ?? '');
      const mine = card.variants.filter(v => !subType || v.subType === subType);
      const vs = mine.length ? mine : card.variants;
      const wanted = new Set(vs.map(v => cpPrintingFor(v, names)).filter(x => x != null));
      let note = null, editionMatched = null;
      const matched = rows.filter(g => wanted.has(g.printing ?? ''));
      if (ed === '1st') {
        const first = matched.filter(g => /1st edition/i.test(g.printing || ''));
        if (first.length) { rows = first; editionMatched = true; }
        else { editionMatched = false; note = 'CardPrice does not separate 1st Edition graded sales for this card — the prices below are NOT 1st Edition-specific. Check the 1st Edition links below.'; if (matched.length) rows = matched; }
      } else if (matched.length) rows = matched;
      else if (rows.length > 1) note = 'CardPrice lists several printings for this card; showing all of them.';
      const shown = new Set(rows.map(g => g.printing ?? ''));
      const pop = (card.population || []).filter(p => shown.has(p.printing ?? '') || (!matched.length && editionMatched !== false));
      const printings = rows.map(g => ({
        printing: g.printing || null, date: g.date,
        grades: (est => GRADE_ROWS.map(([k, label, co]) => ({ key: k, label, company: co, price: typeof g[k] === 'number' ? g[k] : null, estimated: est.has(k) || undefined, suspect: k === 'ungraded' && suspiciousRaw(g[k], g) || undefined })).filter(x => x.price != null))(estimatedGrades(g)),
      })).filter(p => p.grades.some(x => x.key !== 'ungraded'));
      const anyEst = printings.some(p => p.grades.some(x => x.estimated));
      if (anyEst) note = [note, 'Rows marked “est.” are CardPrice estimates derived from another grade (9.5 = 1.1× grade 9, BGS 10 = 1.3× and SGC 10 = 0.6× PSA 10), not recorded sales.'].filter(Boolean).join(' ');
      if (printings.some(p => p.grades.some(x => x.suspect))) note = [note, 'The ungraded value is under 1% of the graded values for the same card, so it is probably a bad record — ignore it.'].filter(Boolean).join(' ');
      r = printings.length || pop.length ? {
        available: printings.length > 0, reason: printings.length ? null : 'CardPrice has population data but no graded sale prices for this card yet.',
        note, edition: ed, editionMatched, cardId: card.card.id, name: card.card.name, printings,
        population: pop.map(p => ({ printing: p.printing || null, company: p.company, total: p.total, gem: p.gem, dist: p.dist, updated: p.updated_at })),
        source: { name: 'CardPrice', url: card.card.slug ? `https://cardprice.com/card/${card.card.slug}` : 'https://cardprice.com' },
        currency: 'USD',
      } : { available: false, reason: 'No graded sales recorded for this card on CardPrice yet.', source: card.card.slug ? { name: 'CardPrice', url: `https://cardprice.com/card/${card.card.slug}` } : null };
    }
  }
  if (c && !r.available) r.hint = c.lang === 'ja' ? 'Japanese cards are graded less often, so many have no tracked graded sales.' : null;
  return r;
}

// ---------- CardPrice-only data: curated prize cards, sale counts ("thin data"), price history ----------
// CardPrice derives some graded values from others (grade 9.5 = 1.1x grade 9, BGS 10 = 1.3x PSA 10, SGC 10 = 0.6x PSA 10);
// those are flagged as estimates so they aren't mistaken for recorded sales.
const near = (a, b) => a != null && b != null && Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.002);
function estimatedGrades(g) {
  const est = new Set();
  if (near(g.grade95, g.grade9 * 1.1)) est.add('grade95');
  if (near(g.bgs10, g.psa10 * 1.3)) est.add('bgs10');
  if (near(g.sgc10, g.psa10 * 0.6)) est.add('sgc10');
  return est;
}
// Raw price that is < 1% of the same card's graded values is almost certainly a bad record (e.g. a $21 "ungraded" trophy card).
function suspiciousRaw(raw, g) {
  const vals = g ? ['grade7', 'grade8', 'grade9', 'psa10'].map(k => g[k]).filter(v => typeof v === 'number') : [];
  return raw != null && vals.length > 0 && raw < Math.min(...vals) * 0.01;
}
const THIN_SALES = 5; // fewer recorded sales than this in 90 days -> "few sales" flag
const cpCache = new Map(); // cpId -> { at, info }
async function cpInfo(cpId, { history = false } = {}) {
  const hit = cpCache.get(cpId);
  if (hit && Date.now() - hit.at < GRADED_TTL && (!history || hit.info.history)) return hit.info;
  const full = await cardpriceJSON(`/api/card/${encodeURIComponent(cpId)}`);
  if (!full?.card) { const info = { found: false }; cpCache.set(cpId, { at: Date.now(), info }); return info; }
  const sales = await cardpriceJSON(`/api/sales?cardId=${encodeURIComponent(cpId)}`).catch(() => null);
  const g = (full.gradedPrintings || []).find(x => (x.printing || '') === '') || (full.gradedPrintings || [])[0] || full.graded || null;
  const latest = typeof full.latestPrice === 'number' ? full.latestPrice : null;
  const list = (sales?.sales || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const info = {
    found: true, cpId, name: full.card.name, slug: full.card.slug, url: full.card.slug ? `https://cardprice.com/card/${full.card.slug}` : 'https://cardprice.com',
    latest, latestSource: full.priceSource === 'pricecharting' ? 'PriceCharting (via CardPrice)' : full.priceSource === 'ebay' ? 'eBay (via CardPrice)' : full.priceSource ? `${full.priceSource} (via CardPrice)` : 'TCGplayer sales (via CardPrice)',
    tcgListed: !cpId.startsWith('spx-'), thinFlag: !!full.thinData, suspicious: suspiciousRaw(latest, g), gradedRow: g,
    sales: sales ? { source: 'TCGplayer completed sales (via CardPrice)', count7d: sales.count7d ?? 0, count30d: sales.count30d ?? 0, count90d: sales.count90d ?? 0, avg30d: sales.avg30d ?? null, avg90d: sales.avg90d ?? null,
      last: list[0] ? { date: list[0].date, price: list[0].price, condition: list[0].condition, variant: list[0].variant } : null, oldest: sales.oldestSale || null,
      recent: list.slice(0, 6).map(x => ({ date: x.date, price: x.price, condition: x.condition, variant: x.variant })), conditions: sales.conditions || null } : null,
    population: full.population || [],
  };
  info.sales && (info.sales.few = info.sales.count90d < THIN_SALES);
  if (history) {
    const h = await cardpriceJSON(`/api/history?cardId=${encodeURIComponent(cpId)}`).catch(() => null);
    const pts = (h?.series || []).filter(p => typeof p.price === 'number').map(p => ({ d: String(p.date).slice(0, 10), m: p.price }));
    const days = new Map(pts.map(p => [p.d, p.m])); // one point per day, last wins
    info.history = [...days].map(([d, m]) => ({ d, m })).slice(-365);
  }
  if (cpCache.size >= 400) cpCache.delete(cpCache.keys().next().value);
  cpCache.set(cpId, { at: Date.now(), info });
  return info;
}
async function cpIdForProduct(productId) { const card = await cardpriceCard(+productId); return card?.card?.id || null; }
// CardPrice price used to sort curated cards: raw/ungraded only (graded-only estimates don't count), bad records excluded.
const curatedState = new Map(); // cpId -> info (refreshed daily)
async function refreshCurated() {
  for (const e of EVENTS.cards) { try { curatedState.set(e.cpId, await cpInfo(e.cpId)); } catch (err) { log('curated refresh failed', e.cpId, err.message); } }
  log(`Curated prize cards: ${EVENTS.cards.length} (${[...curatedState.values()].filter(i => i.latest != null).length} with a CardPrice raw price)`);
}
function serializeCurated(e) {
  const i = curatedState.get(e.cpId);
  const sortPrice = i && i.latest != null && !i.suspicious ? i.latest : null;
  return {
    id: `cp:${e.cpId}`, source: 'cardprice', cpId: e.cpId, lang: e.lang, name: e.name, number: null, rarity: 'Prize card', img: e.img,
    url: e.slug ? `https://cardprice.com/card/${e.slug}` : null, kind: 'pokemon',
    set: { id: 'spx-trophy', cat: null, name: e.set, abbr: 'Trophy', released: null }, prices: [],
    cp: i ? { latest: i.latest, latestSource: i.latestSource, suspicious: i.suspicious, sortPrice, thinFlag: i.thinFlag } : { latest: null, sortPrice: null },
    event: { kind: e.kind || 'prize', label: EVENT_LABEL[e.kind || 'prize'], curated: true, note: 'Not listed on TCGplayer — prices come from CardPrice only.' },
    pack: null, packNote: 'Awarded as a prize — never sold in booster packs.', pull: { known: false, reason: 'Awarded as a tournament/contest prize, not pulled from packs' }, history: [],
    dexId: e.pokemon ? state.pokemon.find(p => p.name === e.pokemon)?.id || null : null,
    links: { pricecharting: `https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(e.name)}`, ebay: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(e.name.replace(/[()]/g, ''))}&LH_Sold=1&LH_Complete=1`, psa: `https://www.psacard.com/pop/search?q=${encodeURIComponent(e.name.replace(/[()]/g, ''))}` },
  };
}
const curatedText = e => ` ${norm([e.name, e.set, ...(e.aliases || []), 'trophy prize card event promo tournament competition contest japanese', e.pokemon || ''].join(' ')).trim()} `;
function curatedSearch(toks) {
  const words = toks.filter(t => !t.slash).map(t => t.t); if (!words.length || words.length !== toks.length) return [];
  return EVENTS.cards.filter(e => { const t = curatedText(e); return words.every(w => t.includes(` ${w}`)); }).map(serializeCurated);
}

const sealedPrice = x => { const ps = x.prices.filter(p => p.market != null); if (ps.length) return ps[0].market; const m = x.prices.find(p => p.mid != null); return m ? m.mid : null; };
function serializeSealed(x) {
  const g = state.groupByKey.get(gkey(x.cat, x.groupId));
  return { id: x.id, name: x.name, type: x.type, lang: x.lang, img: x.img, url: x.url,
    set: { id: g.groupId, cat: g.cat, name: g.name, abbr: g.abbr, released: g.published },
    prices: x.prices, history: x.prices.map(p => ({ sub: p.sub, points: histPoints(`${x.id}|${p.sub}`) })) };
}
function sealedSets(langs) {
  const counts = new Map();
  for (const x of state.sealed) if (langs.includes(x.lang)) { const k = gkey(x.cat, x.groupId); const c = counts.get(k) || { n: 0, priced: 0 }; c.n++; if (sealedPrice(x) != null) c.priced++; counts.set(k, c); }
  return [...counts.entries()].map(([k, c]) => { const g = state.groupByKey.get(k); return { cat: g.cat, groupId: g.groupId, name: g.name, lang: g.lang, released: g.published, count: c.n, priced: c.priced }; })
    .sort((a, b) => String(b.released || '').localeCompare(String(a.released || '')));
}
function sealedSearch({ q, type, langs, cat, groupId, pokemon, exclude }) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  let groups = null;
  if (pokemon) { const pq = norm(pokemon); groups = new Set(state.cards.filter(c => !c.t && c.n.includes(pq)).map(c => gkey(c.cat, c.groupId))); }
  const out = state.sealed.filter(x => langs.includes(x.lang) && (!type || x.type === type) && (!exclude || x.type !== exclude) && (!groupId || (x.groupId === +groupId && x.cat === +cat))
    && (!groups || groups.has(gkey(x.cat, x.groupId)))
    && terms.every(t => (x.n + ' ' + state.groupByKey.get(gkey(x.cat, x.groupId)).name.toLowerCase()).includes(t)));
  out.sort((a, b) => (sealedPrice(b) ?? -1) - (sealedPrice(a) ?? -1)); // most expensive first, unpriced last
  return { total: out.length, items: out.slice(0, groupId ? 500 : 300).map(serializeSealed) };
}

// ---------- current price lookup for alerts ----------
function currentFor(a) {
  if (a.source === 'tcgcsv') {
    if (a.kind === 'sealed') { const x = state.sealedById?.get(a.productId); if (!x) return null; const p = x.prices.find(p => p.sub === a.subType) || x.prices[0]; return p ? (p.market ?? p.mid ?? null) : null; }
    const c = a.kind === 'pack' ? state.packById?.get(a.productId) : state.byId.get(a.productId);
    if (!c) return null;
    if (a.kind === 'pack') return c.market ?? c.mid ?? null;
    const p = c.prices.find(p => p.sub === a.subType) || c.prices[0];
    return p ? (p.market ?? p.mid ?? null) : null;
  }
  if (a.source === 'tcgdex') {
    const c = L.readJSON(L.cacheFile(`tcgdex-${a.language}-${a.tcgdexId.replace(/[^\w.-]/g, '_')}.json`), null);
    return cmPrice(L.cmUsd(c?.pricing?.cardmarket));
  }
  return null;
}

// Current price + average + trigger for an alert (or an alert-to-be). `cm` = already-fetched Cardmarket block (tcgdex).
function quoteFor(a, cm) {
  let current, avg;
  if (a.source === 'tcgdex') {
    if (cm === undefined) cm = L.readJSON(L.cacheFile(`tcgdex-${a.language}-${String(a.tcgdexId).replace(/[^\w.-]/g, '_')}.json`), null)?.pricing?.cardmarket;
    cm = L.cmUsd(cm); current = AL.cmCurrent(cm); avg = AL.cmAverage(cm);
    a = AL.usdAlert(a, L.fxNow().rate);
  } else { current = currentFor(a); avg = AL.historyAverage(histPoints(`${a.productId}|${a.subType}`)); }
  const ev = AL.evaluate(a, current, avg);
  return { ...(a.source === 'tcgdex' ? { currency: 'USD', target: a.target ?? null, eurRate: L.fxNow().rate } : {}), current, average: avg.average, averageBasis: avg.averageBasis, averageDays: avg.averageDays, averageLimited: avg.averageLimited,
    mode: ev.mode, percent: ev.percent, triggerPrice: ev.triggerPrice, percentOfAverage: ev.percentOfAverage, triggered: ev.hit };
}

// Async variant that also covers CardPrice-sourced alerts (prize cards / cards with no TCGplayer price).
async function quoteAny(a, cm) {
  if (a.source !== 'cardprice') return quoteFor(a, cm);
  const { current, avg } = await AL.cardpriceQuote(a).catch(() => ({ current: null, avg: { average: null, averageBasis: 'CardPrice not responding', averageDays: 0, averageLimited: true } }));
  const ev = AL.evaluate(a, current, avg);
  return { currency: 'USD', target: a.target ?? null, current, average: avg.average, averageBasis: avg.averageBasis, averageDays: avg.averageDays, averageLimited: avg.averageLimited,
    mode: ev.mode, percent: ev.percent, triggerPrice: ev.triggerPrice, percentOfAverage: ev.percentOfAverage, triggered: ev.hit };
}
const cpIdOk = id => /^(spx|tcg|cp)-[\w-]{1,80}$/.test(String(id || '')) || EVENTS.cards.some(e => e.cpId === id);

// ---------- HTTP helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function send(res, code, body, type = 'application/json', headers = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': type === 'application/json' ? 'no-store' : 'no-cache', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', d => { b += d; if (b.length > 1e5) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('Invalid JSON')); } });
  });
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(x => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
// ---------- stateless signed sessions ----------
// Cookie "sid" = base64url(JSON claims) + "." + base64url(HMAC-SHA256(claims, SESSION_SECRET)).
// Claims: u username, id per-account uid, e email, iat/exp (ms), v session version. Validation needs only the secret, so sessions
// survive restarts/redeploys. Logout bumps the account's session version (revokes every cookie issued before it).
// If the account record is gone (free-plan JSON store wiped on redeploy) a minimal profile is recreated from the claims.
const SESSION_TTL = 365 * 864e5, SESSION_REFRESH = 864e5;
const SESSION_SECRET = (() => {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return Buffer.from(s);
  log('WARNING: SESSION_SECRET is not set (or too short) - using a random per-process key; sign-ins will not survive a restart.');
  return crypto.randomBytes(48);
})();
const b64u = b => Buffer.from(b).toString('base64url');
const sign = data => crypto.createHmac('sha256', SESSION_SECRET).update(data).digest();
function makeToken(u) {
  const now = Date.now();
  const body = b64u(JSON.stringify({ u: u.username, id: u.uid, e: u.email || '', iat: now, exp: now + SESSION_TTL, v: u.sv || 0 }));
  return `${body}.${b64u(sign(body))}`;
}
function readToken(t) {
  if (!t || typeof t !== 'string' || t.length > 2000) return null;
  const [body, mac] = t.split('.'); if (!body || !mac) return null;
  const want = sign(body), got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try { const c = JSON.parse(Buffer.from(body, 'base64url').toString()); return c && c.u && c.exp > Date.now() ? c : null; } catch { return null; }
}
async function currentUser(req, res) {
  const c = readToken(cookies(req).sid); if (!c) return null;
  let u = db.users[c.u];
  if (u) {
    if (!u.uid) { u.uid = c.id; await saveUser(u); } // accounts created before uids existed adopt the first valid token's uid
    if (u.uid !== c.id || (u.sv || 0) !== (c.v || 0)) return null; // different account with the same name, or logged out
  } else {
    // Record missing (store wiped): recreate a minimal profile from the signed claims so the person stays signed in.
    u = db.users[c.u] = { username: c.u, uid: c.id, sv: c.v || 0, pass: null, email: c.e || '', favorites: [], createdAt: new Date(c.iat).toISOString(), restoredFromSession: new Date().toISOString() };
    await saveUser(u); log('restored account from session cookie:', c.u);
  }
  if (res && Date.now() - c.iat > SESSION_REFRESH) res.setHeader('Set-Cookie', sessionCookie(req, makeToken(u), SESSION_TTL / 1000)); // sliding expiry
  return u;
}
function sessionCookie(req, token, maxAge) {
  const secure = PROD || req.headers['x-forwarded-proto'] === 'https' || /trycloudflare|https/.test(req.headers['cf-visitor'] || '') ? '; Secure' : '';
  return `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(maxAge)}${secure}`;
}
const publicUser = u => u && ({ username: u.username, email: u.email || '', favorites: u.favorites || [], restored: !u.pass });
const attempts = new Map(), adminFails = new Map();
function rateLimited(ip) { const now = Date.now(); const a = (attempts.get(ip) || []).filter(t => now - t < 15 * 60e3); a.push(now); attempts.set(ip, a); return a.length > 20; }
const validEmail = e => !e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const clientIp = req => req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
let alertCheckRunning = false;
async function newSession(username) {
  const u = db.users[username];
  if (!u.uid) { u.uid = crypto.randomBytes(12).toString('base64url'); await saveUser(u); }
  return makeToken(u);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p === '/healthz') return send(res, 200, { ok: true, storage: store.kind, storeReady: state.storeReady, indexReady: state.cards.length > 0, indexing: state.loading, pricesUpdated: state.lastUpdated });
    if (p.startsWith('/api/')) {
      if (req.method === 'POST' && req.headers['content-type'] && !req.headers['content-type'].includes('application/json')) return send(res, 415, { error: 'JSON only' });
      const ip = clientIp(req);
      if (!state.storeReady && p !== '/api/status') return send(res, 503, { error: 'Starting up, try again in a few seconds' }, 'application/json', { 'Retry-After': '5' });
      const user = await currentUser(req, res);

      // --- token-protected alert check for an external daily job (same logic as check_alerts.js) ---
      if (p === '/api/admin/alert-hits') {
        const tok = process.env.ALERTS_API_TOKEN;
        if (!tok) return send(res, 503, { error: 'ALERTS_API_TOKEN is not configured on the server' });
        const now = Date.now(), fails = (adminFails.get(ip) || []).filter(t => now - t < 15 * 60e3);
        if (fails.length >= 10) return send(res, 429, { error: 'Too many failed attempts, try again later' });
        const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)\s*$/i);
        if (!m || !crypto.timingSafeEqual(sha(m[1]), sha(tok))) { fails.push(now); adminFails.set(ip, fails); return send(res, 401, { error: 'Unauthorized' }, 'application/json', { 'WWW-Authenticate': 'Bearer' }); }
        if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
        if (alertCheckRunning) return send(res, 409, { error: 'An alert check is already running' });
        const mark = ['1', 'true', 'yes'].includes(String(u.searchParams.get('markNotified')).toLowerCase());
        alertCheckRunning = true;
        try {
          const historyPoints = async key => { await ensureHistory(); return histPoints(key); };
          const hits = await checkAlerts(store, { markNotified: mark, historyPoints, onError: (a, e) => log(`alert ${a.id} price lookup failed: ${e.message}`) });
          log(`admin alert check: ${hits.length} hit(s), markNotified=${mark}`);
          return send(res, 200, hits, 'application/json', { 'X-Mark-Notified': mark ? '1' : '0' });
        } finally { alertCheckRunning = false; }
      }

      if (p === '/api/status') return send(res, 200, { ready: state.cards.length > 0, loading: state.loading, progress: state.progress, cards: state.cards.length, japaneseCards: state.cards.filter(c => c.lang === 'ja').length, trainerCards: state.cards.filter(c => c.t).length, indexVersion: state.indexV, sets: state.groups.length, packs: state.packs.size, sealed: (state.sealed || []).length, pricesUpdated: state.lastUpdated, indexedAt: state.indexedAt, historyDays: state.historyDays, storage: store.kind, pullRates: PULL._about, fx: { eurUsd: L.fxNow().rate, date: L.fxNow().date, source: L.fxNow().source } });
      if (p === '/api/pokemon') return send(res, 200, state.pokemon);
      if (p === '/api/search') {
        if (!state.cards.length) return send(res, 503, { error: 'Price index is still loading, try again in a moment', progress: state.progress });
        const langs = (u.searchParams.get('langs') || 'en,ja,zh-tw,zh-cn').split(',').filter(l => ['en', 'ja', 'zh-tw', 'zh-cn'].includes(l));
        await withHistory();
        const r = await search(u.searchParams.get('name') || '', langs);
        return send(res, 200, { query: u.searchParams.get('name'), pricesUpdated: state.lastUpdated, ...r });
      }
      if (p === '/api/sealed/sets' || p === '/api/sealed') {
        if (!state.cards.length) return send(res, 503, { error: 'Price index is still loading, try again in a moment' });
        const langs = (u.searchParams.get('langs') || 'en,ja').split(',');
        const zhNote = langs.some(l => l.startsWith('zh')) ? 'Chinese sealed products: no free price source exists (TCGplayer/TCGCSV only cover English and Japanese, and TCGdex has no sealed products), so none are shown.' : null;
        if (p === '/api/sealed/sets') return send(res, 200, { sets: sealedSets(langs), note: zhNote });
        await withHistory();
        const r = sealedSearch({ q: u.searchParams.get('q'), type: u.searchParams.get('type'), langs, cat: u.searchParams.get('cat'), groupId: u.searchParams.get('groupId'), pokemon: u.searchParams.get('pokemon'), exclude: u.searchParams.get('exclude') });
        return send(res, 200, { pricesUpdated: state.lastUpdated, ...r, types: SEALED_TYPES.map(t => t[0]), note: zhNote });
      }
      if (p === '/api/cardsearch') {
        if (!state.cards.length) return send(res, 503, { error: 'Price index is still loading, try again in a moment', progress: state.progress });
        const langs = (u.searchParams.get('langs') || 'en,ja,zh-tw,zh-cn').split(',').filter(l => ['en', 'ja', 'zh-tw', 'zh-cn'].includes(l));
        const q = String(u.searchParams.get('q') || '').slice(0, 80);
        const zh = u.searchParams.get('zh') === '1';
        const limit = Math.min(60, Math.max(1, +u.searchParams.get('limit') || 60));
        if (zh) await withHistory();
        const sort = u.searchParams.get('sort') === 'match' ? 'match' : 'price';
        return send(res, 200, { query: q, sort, pricesUpdated: state.lastUpdated, ...(await cardSearch(q, langs, { zh, limit, sort })) });
      }
      if (p === '/api/cpinfo') {
        // Sales count / last sale / thin-data flag / CardPrice price history (+ cited record sales for curated cards).
        let cpId = u.searchParams.get('cardId'); const pid = +u.searchParams.get('productId');
        try {
          if (!cpId && pid && state.byId.has(pid)) cpId = await cpIdForProduct(pid);
          if (!cpId || !cpIdOk(cpId)) return send(res, 200, { found: false, reason: 'CardPrice has no record of this card.' });
          const info = await cpInfo(cpId, { history: true });
          const ev = pid ? EVENTS.tcgplayer[pid] : null;
          const { gradedRow, ...out } = info;
          return send(res, 200, { ...out, thinThreshold: THIN_SALES, reportedSales: ev?.reportedSales || null, note: ev?.note || null, pricecharting: ev?.pricecharting || null });
        } catch (e) { log('cpinfo failed', cpId || pid, e.message); return send(res, 200, { found: false, reason: 'CardPrice is not responding right now — try again in a bit.', temporary: true }); }
      }
      if (p === '/api/graded') {
        const cpId = u.searchParams.get('cardId');
        const id = +u.searchParams.get('productId');
        if (cpId ? !cpIdOk(cpId) : (!id || !state.byId.has(id))) return send(res, 404, { available: false, reason: 'Unknown card' });
        try { return send(res, 200, await gradedFor(id, u.searchParams.get('subType') || null, cpId || null)); }
        catch (e) { log('graded lookup failed', id, e.message); return send(res, 200, { available: false, reason: 'CardPrice is not responding right now — try again in a bit.', temporary: true }); }
      }
      if (p === '/api/trend') return send(res, 200, await cardmarketTrend(u.searchParams.get('productId'), u.searchParams.get('dexId')));

      // --- auth ---
      if (p === '/api/signup' && req.method === 'POST') {
        if (rateLimited(ip)) return send(res, 429, { error: 'Too many attempts, try again later' });
        const b = await readBody(req);
        const username = String(b.username || '').trim().toLowerCase();
        const code = inviteCode();
        if (!code) return send(res, 503, { error: 'Sign-up is disabled: no invite code is configured on the server' });
        if (!crypto.timingSafeEqual(sha(String(b.invite || '').trim()), sha(code))) return send(res, 403, { error: 'Invalid invite code' });
        if (!/^[a-z0-9_.-]{3,24}$/.test(username)) return send(res, 400, { error: 'Username: 3–24 letters, numbers, . _ -' });
        if (String(b.password || '').length < 8) return send(res, 400, { error: 'Password must be at least 8 characters' });
        if (!validEmail(b.email)) return send(res, 400, { error: 'That email address looks invalid' });
        if (db.users[username] && !db.users[username].pass && user === db.users[username]) { // profile restored from a session cookie: let its owner set a password again
          user.pass = await L.hashPassword(String(b.password)); if (b.email) user.email = String(b.email).trim(); delete user.restoredFromSession; await saveUser(user);
          return send(res, 200, { user: publicUser(user) }, 'application/json', { 'Set-Cookie': sessionCookie(req, makeToken(user), SESSION_TTL / 1000) });
        }
        if (db.users[username]) return send(res, 409, { error: 'That username is taken' });
        if (await store.get('users', username)) return send(res, 409, { error: 'That username is taken' });
        db.users[username] = { username, uid: crypto.randomBytes(12).toString('base64url'), sv: 0, pass: await L.hashPassword(String(b.password)), email: String(b.email || '').trim(), favorites: [], createdAt: new Date().toISOString() };
        await saveUser(db.users[username]);
        const token = await newSession(username);
        return send(res, 200, { user: publicUser(db.users[username]) }, 'application/json', { 'Set-Cookie': sessionCookie(req, token, SESSION_TTL / 1000) });
      }
      if (p === '/api/login' && req.method === 'POST') {
        if (rateLimited(ip)) return send(res, 429, { error: 'Too many attempts, try again later' });
        const b = await readBody(req);
        const usr = db.users[String(b.username || '').trim().toLowerCase()];
        if (!usr || !usr.pass || !(await L.verifyPassword(String(b.password || ''), usr.pass))) return send(res, 401, { error: 'Wrong username or password' });
        const token = await newSession(usr.username);
        return send(res, 200, { user: publicUser(usr) }, 'application/json', { 'Set-Cookie': sessionCookie(req, token, SESSION_TTL / 1000) });
      }
      if (p === '/api/logout' && req.method === 'POST') {
        if (user) { user.sv = (user.sv || 0) + 1; await saveUser(user); } // revoke every cookie issued so far
        return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': sessionCookie(req, '', 0) });
      }
      if (p === '/api/me') {
        if (!user) return send(res, req.method === 'GET' ? 200 : 401, { user: null });
        if (req.method === 'POST') {
          const b = await readBody(req);
          if (b.email !== undefined) { if (!validEmail(b.email)) return send(res, 400, { error: 'That email address looks invalid' }); user.email = String(b.email).trim(); }
          if (b.password !== undefined) { // only for accounts restored from a session cookie (no password on record)
            if (user.pass) return send(res, 400, { error: 'This account already has a password' });
            if (String(b.password).length < 8) return send(res, 400, { error: 'Password must be at least 8 characters' });
            user.pass = await L.hashPassword(String(b.password)); delete user.restoredFromSession;
          }
          await saveUser(user);
        }
        return send(res, 200, { user: publicUser(user) });
      }
      if (p === '/api/favorites' && req.method === 'POST') {
        if (!user) return send(res, 401, { error: 'Log in to save favorites' });
        const b = await readBody(req); const name = String(b.pokemon || '').slice(0, 40);
        user.favorites = (user.favorites || []).filter(f => f !== name); if (b.on) user.favorites.unshift(name);
        await saveUser(user); return send(res, 200, { user: publicUser(user) });
      }
      // Preview for the alert form: current price, 30-day average and its basis, and the trigger at a given percent.
      if (p === '/api/alerts/quote') {
        const q = Object.fromEntries(u.searchParams);
        const pct = Number(q.percent) > 0 ? Number(q.percent) : AL.DEFAULT_PERCENT;
        let a, cm;
        if (q.source === 'cardprice') {
          if (!cpIdOk(q.cpId)) return send(res, 404, { error: 'Unknown card' });
          const field = AL.CP_FIELDS[q.field] ? q.field : 'raw';
          a = { source: 'cardprice', cpId: q.cpId, field, currency: 'USD' };
          return send(res, 200, { ...(await quoteAny({ ...a, mode: field === 'raw' ? 'percent' : 'target', percent: pct, target: Number(q.target) || null })), currency: 'USD', field, fieldLabel: AL.CP_FIELDS[field], subType: null });
        } else if (q.source === 'tcgdex') {
          const lang = ['zh-tw', 'zh-cn'].includes(q.lang) ? q.lang : null;
          const c = lang && await L.tcgdexCard(lang, String(q.tcgdexId || '')).catch(() => null);
          if (!c) return send(res, 404, { error: 'Unknown card' });
          a = { source: 'tcgdex', language: lang, tcgdexId: c.id, currency: 'USD' }; cm = c.pricing?.cardmarket || null;
        } else {
          const kind = ['card', 'pack', 'sealed'].includes(q.kind) ? q.kind : 'card', id = +q.productId;
          const rows = kind === 'pack' ? null : kind === 'sealed' ? state.sealedById?.get(id)?.prices : state.byId.get(id)?.prices;
          const sub = kind === 'pack' ? state.packById?.get(id)?.sub ?? null : ((rows || []).find(x => x.sub === q.subType) || (rows || [])[0])?.sub ?? null;
          a = { source: 'tcgcsv', kind, productId: id, subType: sub, currency: 'USD' };
          await withHistory();
        }
        return send(res, 200, { ...quoteFor({ ...a, mode: 'percent', percent: pct }, cm), currency: a.currency, subType: a.subType ?? null });
      }
      if (p === '/api/alerts') {
        if (!user) return send(res, 401, { error: 'Log in to use price alerts' });
        const all = Object.values(await store.all('alerts'));
        if (req.method === 'GET') {
          await withHistory();
          const mine = await Promise.all(all.filter(a => a.profile === user.username).map(async a => ({ ...a, ...(await quoteAny(a)) })));
          return send(res, 200, { alerts: mine });
        }
        if (req.method === 'POST') {
          const b = await readBody(req);
          const mode = b.mode === 'target' ? 'target' : 'percent';
          const target = mode === 'target' ? Number(b.target) : null;
          const percent = mode === 'percent' ? (b.percent == null || b.percent === '' ? AL.DEFAULT_PERCENT : Number(b.percent)) : null;
          if (mode === 'target' && !(target > 0)) return send(res, 400, { error: 'Enter a target price above 0' });
          if (mode === 'percent' && !(percent >= 1 && percent <= 99)) return send(res, 400, { error: 'Percent of average must be between 1 and 99' });
          const rule = { mode, target, percent: percent == null ? null : Math.round(percent * 10) / 10 };
          let item;
          if (b.source === 'cardprice') {
            if (!cpIdOk(b.cpId)) return send(res, 400, { error: 'Unknown card' });
            const field = AL.CP_FIELDS[b.field] ? b.field : 'raw';
            if (field !== 'raw' && mode !== 'target') return send(res, 400, { error: 'Graded-price alerts need a fixed target price (there is no graded price history to average).' });
            const info = await cpInfo(b.cpId).catch(() => null);
            if (!info?.found) return send(res, 400, { error: 'CardPrice has no record of this card' });
            const cur = EVENTS.cards.find(e => e.cpId === b.cpId), tcg = /^tcg-(\d+)$/.exec(b.cpId), tc = tcg && state.byId.get(+tcg[1]);
            item = { kind: 'card', source: 'cardprice', cpId: b.cpId, field, productId: tc ? tc.id : null, subType: null, name: `${cur?.name || tc?.name || info.name} — ${AL.CP_FIELDS[field]}`,
              set: cur?.set || (tc && state.groupByKey.get(gkey(tc.cat, tc.groupId))?.name) || 'CardPrice', language: cur?.lang || tc?.lang || 'ja', currency: 'USD',
              priceField: `CardPrice ${AL.CP_FIELDS[field]} price (thin data: ${info.sales ? `${info.sales.count90d} recorded sale${info.sales.count90d === 1 ? '' : 's'} in 90 days` : 'no recorded sales'})`, url: info.url, img: cur?.img || tc?.img || null };
          } else if (b.source === 'tcgdex') {
            const lang = ['zh-tw', 'zh-cn'].includes(b.lang) ? b.lang : null;
            const c = lang && await L.tcgdexCard(lang, String(b.tcgdexId || '')).catch(() => null);
            if (!c) return send(res, 400, { error: 'Unknown card' });
            const cm = c.pricing?.cardmarket;
            item = { kind: 'card', source: 'tcgdex', tcgdexId: c.id, productId: null, subType: null, name: c.name, set: c.set?.name || c.set?.id, language: lang, currency: 'USD', priceField: 'Cardmarket trend (avg if no trend) via TCGdex, converted from EUR', url: cm?.idProduct ? `https://www.cardmarket.com/en/Pokemon/Products?idProduct=${cm.idProduct}` : null, img: c.image ? `${c.image}/high.webp` : null };
          } else if (b.kind === 'sealed') {
            const x = state.sealedById.get(+b.productId); if (!x) return send(res, 400, { error: 'Unknown sealed product' });
            const g = state.groupByKey.get(gkey(x.cat, x.groupId));
            const sub = (x.prices.find(p => p.sub === b.subType) || x.prices[0])?.sub || null;
            item = { kind: 'sealed', sealedType: x.type, source: 'tcgcsv', category: g.cat, groupId: g.groupId, productId: x.id, subType: sub, name: x.name, set: g.name, language: g.lang, currency: 'USD', priceField: 'TCGplayer market (mid if no market)', url: x.url, img: x.img };
          } else if (b.kind === 'pack') {
            const pk = state.packById.get(+b.productId); if (!pk) return send(res, 400, { error: 'Unknown pack' });
            const g = state.groupByKey.get(pk.groupKey);
            item = { kind: 'pack', source: 'tcgcsv', category: g.cat, groupId: g.groupId, productId: pk.id, subType: pk.sub, name: pk.name, set: pk.fromParent || g.name, language: g.lang, currency: 'USD', priceField: 'TCGplayer market (mid if no market)', url: pk.url, img: pk.img };
          } else {
            const c = state.byId.get(+b.productId); if (!c) return send(res, 400, { error: 'Unknown card' });
            const g = state.groupByKey.get(gkey(c.cat, c.groupId));
            const sub = (c.prices.find(x => x.sub === b.subType) || c.prices[0])?.sub || null;
            const edl = editionLabel(c, edOf(sub));
            item = { kind: 'card', source: 'tcgcsv', category: g.cat, groupId: g.groupId, productId: c.id, subType: sub, name: edl ? `${c.name} — ${edl}` : c.name, edition: edl, set: g.name, language: g.lang, currency: 'USD', priceField: 'TCGplayer market (mid if no market)', url: c.url, img: c.img };
          }
          const existing = all.find(a => a.profile === user.username && a.source === item.source && (item.source === 'tcgdex' ? a.tcgdexId === item.tcgdexId : item.source === 'cardprice' ? a.cpId === item.cpId && a.field === item.field : a.productId === item.productId && a.subType === item.subType && a.kind === item.kind));
          let saved;
          if (existing) await store.put('alerts', existing.id, saved = { ...existing, ...rule, notified: false, updatedAt: new Date().toISOString() });
          else { const id = crypto.randomBytes(6).toString('hex'); await store.put('alerts', id, saved = { id, profile: user.username, ...item, ...rule, notified: false, createdAt: new Date().toISOString() }); }
          await withHistory();
          return send(res, 200, { ok: true, alert: { ...saved, ...(await quoteAny(saved)) } });
        }
        if (req.method === 'DELETE') {
          const id = u.searchParams.get('id');
          const a = all.find(a => a.id === id && a.profile === user.username);
          if (a) await store.del('alerts', a.id);
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: 'Not found' });
    }
    let fp = path.normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, '');
    if (fp === '/' || fp === '\\') fp = '/index.html';
    const f = path.join(L.ROOT, 'public', fp);
    if (!f.startsWith(path.join(L.ROOT, 'public'))) return send(res, 403, 'forbidden', 'text/plain');
    fs.readFile(f, (err, buf) => err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, MIME[path.extname(f)] || 'application/octet-stream'));
  } catch (e) { log('error', p, e.stack || e.message); if (!res.headersSent) send(res, 500, { error: PROD ? 'Server error' : e.message }); }
});
server.listen(PORT, '0.0.0.0', () => log(`Listening on port ${PORT} (${PROD ? 'production' : 'development'}, ${store.kind} storage)`));

// Startup: storage -> accounts -> Pokémon list -> saved price index (fast) -> rebuild in background only if TCGCSV has newer prices.
(async () => {
  const t0 = Date.now();
  await store.init();
  await loadAccounts();
  state.storeReady = true;
  await loadPokemon().catch(e => log('PokeAPI failed', e.message));
  const snap = await store.getBlob('index:latest').catch(e => { log('saved index read failed', e.message); return null; });
  if ((snap?.v === 1 || snap?.v === INDEX_V) && snap.cards?.length) { applyIndex(snap); state.indexSource = 'saved'; log(`Loaded saved index (prices ${snap.stamp}) in ${Date.now() - t0}ms`); }
  state.historyDays = (await store.listBlobs('history:').catch(() => [])).map(n => n.slice(8));
  const refresh = async () => {
    try { const s = await L.getText('https://tcgcsv.com/last-updated.txt'); if (s !== state.lastUpdated || state.indexV !== INDEX_V) await buildIndex(); }
    catch (e) { log('refresh check failed', e.message); if (!state.cards.length) await buildIndex().catch(e2 => log('index failed', e2.message)); }
  };
  L.eurUsd().then(f => log(`EUR->USD ${f.rate} (${f.date || f.source})`)).catch(() => {});
  setInterval(() => L.eurUsd().catch(() => {}), 6 * 3600e3);
  refresh(); // background: the site serves the saved index meanwhile
  setTimeout(() => refreshCurated().catch(() => {}), 5000); setInterval(() => refreshCurated().catch(() => {}), GRADED_TTL);
  setInterval(refresh, 60 * 60 * 1000); // TCGCSV refreshes ~daily (~20:00 UTC); only re-pull when its stamp changes
})().catch(e => { log('startup failed:', e.stack || e.message); process.exit(1); });

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  if (stopping) return; stopping = true; log(`${sig}: shutting down`);
  server.close(() => store.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 8000).unref();
});
