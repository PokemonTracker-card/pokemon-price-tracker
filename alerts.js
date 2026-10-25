// Shared price-alert check, used by check_alerts.js (CLI) and GET /api/admin/alert-hits (server).
// Returns the alerts that are now at/below target and haven't been reported yet. With markNotified,
// those are marked notified (so they aren't repeated), and alerts whose price went back above target
// are re-armed. Sends nothing itself.
const L = require('./lib');

const productType = a => a.kind === 'sealed' ? (a.sealedType || null) : a.kind === 'pack' ? 'Booster Pack' : 'Single card';

async function checkAlerts(store, { markNotified = false, onError = (a, e) => console.error(`price lookup failed for alert ${a.id} (${a.name}): ${e.message}`) } = {}) {
  const alerts = Object.values(await store.all('alerts'));
  const users = await store.all('users');
  const stamp = await L.getText('https://tcgcsv.com/last-updated.txt').catch(() => null);
  const priceCache = new Map();
  const tcgcsvPrice = async a => {
    const k = `${a.category}:${a.groupId}`;
    if (!priceCache.has(k)) priceCache.set(k, await L.groupPrices(a.category, a.groupId, stamp));
    const rows = priceCache.get(k).filter(r => r[0] === a.productId);
    const r = rows.find(r => r[1] === a.subType) || rows[0];
    return r ? (r[5] ?? r[3] ?? null) : null; // market, else mid
  };
  const tcgdexPrice = async a => {
    const c = await L.tcgdexCard(a.language, a.tcgdexId);
    const cm = c?.pricing?.cardmarket; return cm ? (cm.trend || cm.avg || cm['trend-holo'] || cm['avg-holo'] || null) : null;
  };
  const hits = [];
  const now = () => new Date().toISOString();
  for (const a of alerts) {
    let current = null;
    try { current = a.source === 'tcgdex' ? await tcgdexPrice(a) : await tcgcsvPrice(a); }
    catch (e) { onError(a, e); continue; }
    const upd = { lastChecked: now(), lastPrice: current };
    if (current != null && current <= a.target) {
      if (!a.notified) {
        hits.push({
          alertId: a.id, profile: a.profile, email: users[a.profile]?.email || null,
          kind: a.kind, productType: productType(a), name: a.name, set: a.set, language: a.language, variant: a.subType || null,
          currentPrice: current, target: a.target, currency: a.currency, priceField: a.priceField,
          link: a.url, image: a.img || null, pricesUpdated: a.source === 'tcgcsv' ? stamp : 'TCGdex/Cardmarket daily',
        });
        Object.assign(upd, { notified: true, notifiedAt: now(), notifiedPrice: current });
      }
    } else if (current != null && a.notified) Object.assign(upd, { notified: false, rearmedAt: now() });
    if (markNotified) {
      // Re-read so edits made on the site meanwhile aren't clobbered; skip if the alert was deleted or its target changed.
      const fresh = await store.get('alerts', a.id);
      if (fresh && fresh.target === a.target) await store.put('alerts', a.id, { ...fresh, ...upd });
    }
  }
  return hits;
}
module.exports = { checkAlerts, productType };
