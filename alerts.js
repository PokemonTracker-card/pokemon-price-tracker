// Shared price-alert logic, used by check_alerts.js (CLI), GET /api/admin/alert-hits and the /api/alerts UI.
// Two alert modes:
//   - 'percent' (default): fire when the current price drops BELOW `percent`% (default 75) of the item's 30-day average.
//   - 'target' (legacy / fixed price): fire when the current price is AT OR BELOW a fixed `target`.
// checkAlerts returns the alerts that newly hit and haven't been reported yet. With markNotified, those are marked
// notified (so they aren't repeated), and alerts whose price went back above the trigger are re-armed. Sends nothing.
const L = require('./lib');

const DEFAULT_PERCENT = 75, AVG_DAYS = 30, MIN_HISTORY_DAYS = 7;
const productType = a => a.kind === 'sealed' ? (a.sealedType || null) : a.kind === 'pack' ? 'Booster Pack' : 'Single card';
const alertMode = a => a.mode === 'percent' ? 'percent' : 'target'; // alerts saved before modes existed are fixed-target
const alertPercent = a => { const p = Number(a.percent); return p > 0 && p < 1000 ? p : DEFAULT_PERCENT; };
const r2 = v => Math.round(v * 100) / 100;
const histKey = a => `${a.productId}|${a.subType}`;
const cutoffDay = () => new Date(Date.now() - (AVG_DAYS - 1) * 864e5).toISOString().slice(0, 10);

// Cardmarket current price as used by the site (trend, else sell avg; holo fields if no non-holo prices).
const cmCurrent = cm => cm ? (cm.trend || cm.avg || cm['trend-holo'] || cm['avg-holo'] || null) : null;
// Cardmarket average: avg30, falling back to avg7 / avg1 — from the same (holo or non-holo) family as the current price.
function cmAverage(cm) {
  if (!cm) return { average: null, averageBasis: 'no Cardmarket data', averageDays: 0, averageLimited: true };
  const holo = !(cm.trend || cm.avg) && !!(cm['trend-holo'] || cm['avg-holo']);
  const s = holo ? '-holo' : '', h = holo ? ' (holo)' : '';
  if (cm['avg30' + s] > 0) return { average: r2(cm['avg30' + s]), averageBasis: `Cardmarket 30-day avg${h}`, averageDays: 30, averageLimited: false };
  if (cm['avg7' + s] > 0) return { average: r2(cm['avg7' + s]), averageBasis: `Cardmarket 7-day avg${h} (no 30-day avg published)`, averageDays: 7, averageLimited: true };
  if (cm['avg1' + s] > 0) return { average: r2(cm['avg1' + s]), averageBasis: `Cardmarket 1-day avg${h} (no 30/7-day avg published)`, averageDays: 1, averageLimited: true };
  return { average: null, averageBasis: 'Cardmarket publishes no average for this card', averageDays: 0, averageLimited: true };
}
// Average of the site's own recorded daily TCGplayer market prices over the last 30 days.
function historyAverage(points) {
  const cut = cutoffDay(); const pts = (points || []).filter(p => p.d >= cut && typeof p.m === 'number' && !Number.isNaN(p.m));
  const n = pts.length;
  if (!n) return { average: null, averageBasis: 'no market-price history recorded yet', averageDays: 0, averageLimited: true };
  const average = r2(pts.reduce((s, p) => s + p.m, 0) / n);
  const averageBasis = n >= MIN_HISTORY_DAYS ? `site history, ${n} days`
    : `site history, only ${n} day${n > 1 ? 's' : ''} (limited: fewer than ${MIN_HISTORY_DAYS})`;
  return { average, averageBasis, averageDays: n, averageLimited: n < MIN_HISTORY_DAYS, averageFrom: pts[0].d, averageTo: pts[n - 1].d };
}
// Cardmarket (tcgdex) alerts are evaluated in USD (EUR converted at the daily ECB rate). Alerts saved before that stored a
// fixed target in EUR (currency 'EUR'); convert that target too so comparisons stay like-for-like.
const usdAlert = (a, rate) => a.source === 'tcgdex' && a.currency === 'EUR' && a.target != null ? { ...a, target: r2(a.target * rate), currency: 'USD' } : a;
// Decide whether an alert fires, given its current price and average info.
function evaluate(a, current, avg) {
  const mode = alertMode(a), percent = mode === 'percent' ? alertPercent(a) : null;
  const triggerPrice = mode === 'percent' ? (avg?.average != null ? r2(avg.average * percent / 100) : null) : a.target;
  const hit = current != null && triggerPrice != null && (mode === 'percent' ? current < triggerPrice : current <= triggerPrice);
  const percentOfAverage = current != null && avg?.average ? Math.round(current / avg.average * 1000) / 10 : null;
  return { mode, percent, triggerPrice, hit, percentOfAverage };
}

// Loads only the needed keys from the last 30 `history:YYYY-MM-DD` blobs in the store (used when no in-memory history).
function storeHistoryLookup(store) {
  let loaded = null;
  return async (keys) => {
    if (!loaded) loaded = (async () => {
      const want = new Set(keys), out = new Map([...want].map(k => [k, []]));
      const cut = cutoffDay();
      const names = (await store.listBlobs('history:')).filter(n => n.slice(8) >= cut).sort();
      for (const n of names) {
        const snap = await store.getBlob(n).catch(() => null); if (!snap) continue;
        for (const k of want) if (typeof snap[k] === 'number') out.get(k).push({ d: n.slice(8), m: r2(snap[k]) });
      }
      return out;
    })();
    return loaded;
  };
}

async function checkAlerts(store, { markNotified = false, historyPoints = null, onError = (a, e) => console.error(`price lookup failed for alert ${a.id} (${a.name}): ${e.message}`) } = {}) {
  const alerts = Object.values(await store.all('alerts'));
  const users = await store.all('users');
  const stamp = await L.getText('https://tcgcsv.com/last-updated.txt').catch(() => null);
  // Site-history averages: from the caller (server's in-memory history) or straight from the store's history blobs.
  const needHist = alerts.filter(a => a.source !== 'tcgdex').map(histKey);
  let histMap = null;
  const getHist = async a => {
    if (historyPoints) return historyPoints(histKey(a));
    if (!histMap) histMap = await storeHistoryLookup(store)(needHist).catch(e => { onError({ id: '-', name: 'price history' }, e); return new Map(); });
    return histMap.get(histKey(a)) || [];
  };
  const fx = await L.eurUsd().catch(() => L.fxNow());
  const priceCache = new Map();
  const tcgcsvQuote = async a => {
    const k = `${a.category}:${a.groupId}`;
    if (!priceCache.has(k)) priceCache.set(k, await L.groupPrices(a.category, a.groupId, stamp));
    const rows = priceCache.get(k).filter(r => r[0] === a.productId);
    const r = rows.find(r => r[1] === a.subType) || rows[0];
    return { current: r ? (r[5] ?? r[3] ?? null) : null, avg: historyAverage(await getHist(a)) }; // market, else mid
  };
  const tcgdexQuote = async a => {
    const c = await L.tcgdexCard(a.language, a.tcgdexId);
    const cm = L.cmUsd(c?.pricing?.cardmarket, fx.rate); return { current: cmCurrent(cm), avg: cmAverage(cm) };
  };
  const hits = [];
  const now = () => new Date().toISOString();
  for (const a0 of alerts) {
    const a = usdAlert(a0, fx.rate);
    let q;
    try { q = a.source === 'tcgdex' ? await tcgdexQuote(a) : await tcgcsvQuote(a); }
    catch (e) { onError(a, e); continue; }
    const { current, avg } = q;
    const ev = evaluate(a, current, avg);
    const upd = { lastChecked: now(), lastPrice: current, lastAverage: avg.average, lastAverageBasis: avg.averageBasis, lastTrigger: ev.triggerPrice };
    if (ev.hit) {
      if (!a.notified) {
        hits.push({
          alertId: a.id, profile: a.profile, email: users[a.profile]?.email || null,
          kind: a.kind, productType: productType(a), name: a.name, set: a.set, language: a.language, variant: a.subType || null,
          mode: ev.mode, currentPrice: current, average: avg.average, averageBasis: avg.averageBasis, averageDays: avg.averageDays, averageLimited: avg.averageLimited,
          percentOfAverage: ev.percentOfAverage, triggerPercent: ev.percent, triggerPrice: ev.triggerPrice, target: ev.triggerPrice,
          currency: a.source === 'tcgdex' ? 'USD' : a.currency,
          priceField: a.source === 'tcgdex' ? `Cardmarket trend (avg if no trend) via TCGdex, converted from EUR at 1 EUR = $${fx.rate} (${fx.date || fx.source})` : a.priceField,
          link: a.url, image: a.img || null, pricesUpdated: a.source === 'tcgcsv' ? stamp : 'TCGdex/Cardmarket daily',
        });
        Object.assign(upd, { notified: true, notifiedAt: now(), notifiedPrice: current });
      }
    } else if (current != null && ev.triggerPrice != null && a.notified) Object.assign(upd, { notified: false, rearmedAt: now() });
    if (markNotified) {
      // Re-read so edits made on the site meanwhile aren't clobbered; skip if the alert was deleted or its rule changed.
      const fresh = await store.get('alerts', a.id);
      if (fresh && alertMode(fresh) === ev.mode && fresh.target === a0.target && fresh.percent === a0.percent) await store.put('alerts', a.id, { ...fresh, ...upd });
    }
  }
  return hits;
}
module.exports = { checkAlerts, usdAlert, productType, alertMode, alertPercent, cmCurrent, cmAverage, historyAverage, evaluate, DEFAULT_PERCENT, AVG_DAYS, MIN_HISTORY_DAYS };
