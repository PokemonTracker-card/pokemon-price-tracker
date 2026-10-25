#!/usr/bin/env node
// Prints a JSON array of price alerts that are now at/below target and haven't been reported yet,
// then marks them notified (re-arming alerts whose price went back above target). Sends nothing itself.
// Uses the same storage as the site: Postgres when DATABASE_URL is set, else local data/*.json.
//   node check_alerts.js            -> check + mark notified
//   node check_alerts.js --dry-run  -> check only, change nothing
const { createStore } = require('./store');
const { checkAlerts } = require('./alerts');

(async () => {
  const store = createStore();
  await store.init();
  try {
    const hits = await checkAlerts(store, { markNotified: !process.argv.includes('--dry-run') });
    process.stdout.write(JSON.stringify(hits, null, 2) + '\n');
  } finally { await store.close(); }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
