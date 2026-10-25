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

class PgStore {
  constructor(url) {
    this.kind = 'postgres';
    const { Pool } = require('pg');
    // Short idle timeout so a scale-to-zero database (Neon) can suspend between bursts of activity.
    this.pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 10000, connectionTimeoutMillis: 20000,
      ssl: /localhost|127\.0\.0\.1/.test(url) || /sslmode=disable/.test(url) ? false : { rejectUnauthorized: true } });
    this.pool.on('error', e => console.error('pg pool error', e.message));
  }
  q(text, params) { return this.pool.query(text, params); }
  async init() {
    let err;
    for (let i = 0; i < 5; i++) { // a suspended Neon compute can take a few seconds to wake
      try {
        await this.q(`CREATE TABLE IF NOT EXISTS records (ns text NOT NULL, key text NOT NULL, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (ns, key))`);
        await this.q(`CREATE TABLE IF NOT EXISTS blobs (name text PRIMARY KEY, data bytea NOT NULL, bytes integer NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
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
module.exports = { createStore };
