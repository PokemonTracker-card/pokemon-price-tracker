// Storage adapter.
//   DATABASE_URL set  -> Postgres (e.g. a free Neon database). Tables are created automatically.
//   otherwise         -> local JSON files in data/ (dev / self-hosting).
// Two kinds of data:
//   records: small JSON docs addressed by (namespace, key): users, sessions, alerts
//   blobs:   larger JSON docs stored gzip-compressed: daily price-history snapshots, the price index, caches
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const L = require('./lib');

const gz = obj => zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
const gunz = buf => JSON.parse(zlib.gunzipSync(buf).toString('utf8'));

class JsonStore {
  constructor() { this.kind = 'json'; }
  async init() {}
  file(ns) { return path.join(L.DATA, `${ns}.json`); }
  async all(ns) {
    const d = L.readJSON(this.file(ns), {});
    if (ns === 'alerts' && Array.isArray(d.alerts)) return Object.fromEntries(d.alerts.map(a => [a.id, a])); // legacy {alerts:[...]}
    return d;
  }
  async get(ns, key) { return (await this.all(ns))[key] ?? null; }
  async put(ns, key, value) { const d = await this.all(ns); d[key] = value; L.writeJSON(this.file(ns), d, true); }
  async del(ns, key) { const d = await this.all(ns); if (key in d) { delete d[key]; L.writeJSON(this.file(ns), d, true); } }
  blobFile(name) {
    const m = name.match(/^history:(\d{4}-\d{2}-\d{2})$/);
    return m ? path.join(L.HIST, `${m[1]}.json`) : L.cacheFile(`blob-${name.replace(/[^\w.-]/g, '_')}.json`);
  }
  async getBlob(name) { return L.readJSON(this.blobFile(name), null); }
  async putBlob(name, obj) { L.writeJSON(this.blobFile(name), obj); }
  async listBlobs(prefix) {
    if (prefix !== 'history:') throw new Error('JSON store only lists history blobs');
    return fs.readdirSync(L.HIST).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().map(f => 'history:' + f.slice(0, 10));
  }
  async close() {}
}

// Turn a libpq-style URL (e.g. Neon's "...?sslmode=require&channel_binding=require") into node-postgres options.
// node-postgres ignores channel_binding in the URL and treats sslmode=require as verify-full with a warning, so both are
// stripped from the string and expressed as explicit options instead.
function pgOptions(url) {
  const u = new URL(url);
  const sslmode = u.searchParams.get('sslmode'), cb = u.searchParams.get('channel_binding');
  for (const k of ['sslmode', 'channel_binding', 'uselibpqcompat']) u.searchParams.delete(k);
  const local = /^(localhost|127\.0\.0\.1|::1)$/.test(u.hostname);
  return {
    connectionString: u.toString(),
    ssl: sslmode === 'disable' || (local && !sslmode) ? false : { rejectUnauthorized: true, servername: u.hostname },
    enableChannelBinding: cb === 'require' || cb === 'prefer', // SCRAM-SHA-256-PLUS (supported by pg >= 8.15)
  };
}

class PgStore {
  constructor(url) {
    this.kind = 'postgres';
    // PG_DRIVER=neon-ws: Neon's WebSocket driver over port 443 (for networks that block 5432; optional dev dependency).
    const ws = process.env.PG_DRIVER === 'neon-ws';
    let Pool;
    if (ws) { const n = require(process.env.NEON_DRIVER_PATH || '@neondatabase/serverless'); n.neonConfig.webSocketConstructor = require(process.env.WS_PATH || 'ws'); Pool = n.Pool; this.kind = 'postgres (neon-ws)'; }
    else ({ Pool } = require('pg'));
    const opt = pgOptions(url);
    if (ws) { delete opt.enableChannelBinding; delete opt.ssl; }
    // Short idle timeout so a scale-to-zero database (Neon) can suspend between bursts of activity.
    this.pool = new Pool({ ...opt, max: 4, idleTimeoutMillis: 10000, connectionTimeoutMillis: 20000 });
    this.pool.on('error', e => console.error('pg pool error', e.message));
  }
  q(text, params) { return this.pool.query(text, params); }
  async init() {
    let err;
    for (let i = 0; i < 5; i++) { // a suspended Neon compute can take a few seconds to wake
      try {
        await this.q(`CREATE TABLE IF NOT EXISTS records (ns text NOT NULL, key text NOT NULL, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (ns, key))`);
        await this.q(`CREATE TABLE IF NOT EXISTS blobs (name text PRIMARY KEY, data bytea NOT NULL, bytes integer NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
        const r = await this.q(`SELECT current_setting('server_version') AS v, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl`).catch(() => ({ rows: [{}] }));
        console.log(`postgres store ready (server ${r.rows[0].v || '?'}, ssl ${r.rows[0].ssl ?? 'n/a'}, channel binding ${this.pool.options?.enableChannelBinding ? 'requested' : 'off'})`);
        return;
      } catch (e) { err = e; await L.sleep(2000 * (i + 1)); }
    }
    throw err;
  }
  async all(ns) { const r = await this.q('SELECT key, value FROM records WHERE ns = $1', [ns]); return Object.fromEntries(r.rows.map(x => [x.key, x.value])); }
  async get(ns, key) { const r = await this.q('SELECT value FROM records WHERE ns = $1 AND key = $2', [ns, key]); return r.rows[0]?.value ?? null; }
  async put(ns, key, value) {
    await this.q(`INSERT INTO records (ns, key, value, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (ns, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [ns, key, JSON.stringify(value)]);
  }
  async del(ns, key) { await this.q('DELETE FROM records WHERE ns = $1 AND key = $2', [ns, key]); }
  async getBlob(name) { const r = await this.q('SELECT data FROM blobs WHERE name = $1', [name]); return r.rows[0] ? gunz(r.rows[0].data) : null; }
  async putBlob(name, obj) {
    const buf = gz(obj);
    await this.q(`INSERT INTO blobs (name, data, bytes, updated_at) VALUES ($1, $2, $3, now()) ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, bytes = EXCLUDED.bytes, updated_at = now()`, [name, buf, buf.length]);
  }
  async listBlobs(prefix) { const r = await this.q('SELECT name FROM blobs WHERE name LIKE $1 ORDER BY name', [prefix.replace(/[%_]/g, '\\$&') + '%']); return r.rows.map(x => x.name); }
  async close() { await this.pool.end(); }
}

function createStore() { return process.env.DATABASE_URL ? new PgStore(process.env.DATABASE_URL) : new JsonStore(); }
module.exports = { createStore, pgOptions };
