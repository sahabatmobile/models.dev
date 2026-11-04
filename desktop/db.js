/* Driver database untuk SahabatMobile Desktop.
 * Plain Node (tidak import 'electron') supaya bisa dites langsung dengan node.
 * Session DB disimpan di memori oleh pemanggil (main.js); modul ini stateless.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const KINDS = ['mysql', 'postgres', 'sqlite', 'sqlserver', 'mongodb', 'redis', 'elasticsearch'];
const DEFAULT_PORT = { mysql: 3306, postgres: 5432, sqlserver: 1433, mongodb: 27017, redis: 6379, elasticsearch: 9200 };
const SQL_KINDS = ['mysql', 'postgres', 'sqlserver', 'sqlite'];
const MAX_ROWS = 500;

function isDbProtocol(p) { return KINDS.includes(String(p || '').toLowerCase()); }

function defaultPortFor(protocol) { return DEFAULT_PORT[String(protocol || '').toLowerCase()] || 3306; }

function normalizeCfg(cfg) {
  cfg = cfg || {};
  let kind = String(cfg.kind || cfg.protocol || '').toLowerCase().trim();
  if (kind === 'postgresql' || kind === 'pgsql') kind = 'postgres';
  if (kind === 'mariadb') kind = 'mysql';
  if (!KINDS.includes(kind)) throw new Error('Tipe koneksi tidak didukung: ' + (kind || '(kosong)'));
  const port = Number(cfg.port) || DEFAULT_PORT[kind] || 0;
  const c = {
    kind,
    host: String(cfg.host || '').trim(),
    port,
    user: String(cfg.user || cfg.username || '').trim(),
    password: String(cfg.password || ''),
    database: String(cfg.database || '').trim(),
    filePath: String(cfg.filePath || '').trim(),
    name: String(cfg.name || '').trim(),
  };
  if (kind === 'sqlite') {
    if (!c.filePath) throw new Error('File path database SQLite wajib diisi.');
    if (!fs.existsSync(c.filePath)) throw new Error('File database tidak ditemukan: ' + c.filePath);
  } else if (!c.host) {
    throw new Error('Host wajib diisi untuk ' + kind + '.');
  }
  return c;
}

function normalizeCell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  if (Buffer.isBuffer(v)) return '[binary ' + v.length + ' bytes]';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

function gridFromObjects(rows, limit) {
  const lim = limit || MAX_ROWS;
  const list = Array.isArray(rows) ? rows : [];
  const keys = [];
  const seen = new Set();
  for (const row of list.slice(0, 100)) {
    if (!row || typeof row !== 'object') continue;
    for (const k of Object.keys(row)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  const sliced = list.slice(0, lim);
  return {
    columns: keys,
    rows: sliced.map((r) => keys.map((k) => normalizeCell(r ? r[k] : ''))),
    rowCount: list.length,
    truncated: list.length > lim,
  };
}

function ok(grid, extra) {
  return { ok: true, columns: grid.columns, rows: grid.rows, rowCount: grid.rowCount, truncated: !!grid.truncated, ...(extra || {}) };
}

function fail(err) {
  const msg = (err && err.message) ? err.message : String(err);
  return { ok: false, error: msg };
}

async function timed(fn) {
  const t = Date.now();
  const out = await fn();
  out.elapsedMs = Date.now() - t;
  return out;
}

// ---------- MySQL / MariaDB ----------
async function createMysql(c) {
  const mysql = require('mysql2/promise');
  const base = await mysql.createConnection({
    host: c.host, port: c.port, user: c.user, password: c.password,
    database: c.database || undefined, connectTimeout: 8000, multipleStatements: false,
  });
  await base.query('SELECT 1');
  const conns = new Map();
  if (c.database) conns.set(c.database, base); else conns.set('', base);
  const session = {
    kind: 'mysql', config: c, conns, baseDatabase: c.database || '',
    async connFor(db) {
      const key = db || '';
      if (this.conns.has(key)) return this.conns.get(key);
      const conn = await mysql.createConnection({
        host: c.host, port: c.port, user: c.user, password: c.password,
        database: db || undefined, connectTimeout: 8000,
      });
      this.conns.set(key, conn);
      return conn;
    },
    async close() { for (const c2 of this.conns.values()) { try { await c2.end(); } catch {} } },
  };
  return session;
}

async function mysqlQuery(session, database, sql) {
  const conn = await session.connFor(database);
  const [rows, fields] = await conn.query(sql);
  if (!Array.isArray(rows)) {
    // INSERT/UPDATE/... -> RowDataPacket vs ResultSetHeader
    const info = rows || {};
    return ok({ columns: ['affectedRows', 'changedRows', 'insertId'], rows: [[normalizeCell(info.affectedRows), normalizeCell(info.changedRows), normalizeCell(info.insertId)]], rowCount: 1, truncated: false });
  }
  return ok(gridFromObjects(rows));
}

// ---------- PostgreSQL ----------
async function createPostgres(c) {
  const { Client } = require('pg');
  const admin = new Client({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database || 'postgres', connectionTimeoutMillis: 8000 });
  await admin.connect();
  await admin.query('SELECT 1');
  const conns = new Map();
  conns.set(c.database || 'postgres', admin);
  const session = {
    kind: 'postgres', config: c, conns, baseDatabase: c.database || 'postgres',
    async connFor(db) {
      const key = db || this.baseDatabase;
      if (this.conns.has(key)) return this.conns.get(key);
      const client = new Client({ host: c.host, port: c.port, user: c.user, password: c.password, database: key, connectionTimeoutMillis: 8000 });
      await client.connect();
      this.conns.set(key, client);
      return client;
    },
    async close() { for (const c2 of this.conns.values()) { try { await c2.end(); } catch {} } },
  };
  return session;
}

async function pgQuery(session, database, sql) {
  const client = await session.connFor(database);
  const result = await client.query(sql);
  const rows = result.rows || [];
  if (!rows.length && !(result.fields || []).length) {
    return ok({ columns: ['rowCount', 'command'], rows: [[String(result.rowCount || 0), result.command || '']], rowCount: 1, truncated: false });
  }
  return ok(gridFromObjects(rows));
}

// ---------- SQL Server (mssql) ----------
async function createSqlServer(c) {
  const sql = require('mssql');
  const baseCfg = {
    server: c.host, port: c.port, user: c.user, password: c.password,
    database: c.database || 'master',
    options: { encrypt: false, trustServerCertificate: true },
    connectionTimeout: 8000, requestTimeout: 30000,
    pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
  };
  const pool = await new sql.ConnectionPool(baseCfg).connect();
  await pool.request().query('SELECT 1');
  const sqlLib = sql;
  const pools = new Map();
  pools.set(c.database || 'master', pool);
  const session = {
    kind: 'sqlserver', config: c, pools, baseDatabase: c.database || 'master', sqlLib,
    async poolFor(db) {
      const key = db || this.baseDatabase;
      if (this.pools.has(key)) return this.pools.get(key);
      const p = await new this.sqlLib.ConnectionPool({ ...baseCfg, database: key }).connect();
      this.pools.set(key, p);
      return p;
    },
    async close() { for (const p of this.pools.values()) { try { await p.close(); } catch {} } },
  };
  return session;
}

async function sqlServerQuery(session, database, sqlText) {
  const pool = await session.poolFor(database);
  const result = await pool.request().query(sqlText);
  const recordset = result.recordset || (result.recordsets && result.recordsets[0]) || null;
  if (!recordset) {
    const affected = result.rowsAffected && result.rowsAffected[0];
    return ok({ columns: ['affectedRows'], rows: [[String(affected || 0)]], rowCount: 1, truncated: false });
  }
  return ok(gridFromObjects(recordset.map((r) => ({ ...r }))));
}

// ---------- SQLite (sql.js, wasm) ----------
async function createSqlite(c) {
  const initSqlJs = require('sql.js');
  const distDir = path.join(__dirname, 'node_modules', 'sql.js', 'dist');
  const SQL = await initSqlJs({ locateFile: (f) => path.join(distDir, f) });
  const buf = fs.readFileSync(c.filePath);
  const db = new SQL.Database(buf);
  return {
    kind: 'sqlite', config: c, db, filePath: c.filePath,
    async close() { try { this.persist(); } catch {} try { this.db.close(); } catch {} },
    persist() {
      const data = this.db.export();
      fs.writeFileSync(this.filePath, Buffer.from(data));
    },
  };
}

function sqlitePersistIfChanged(session, sqlText) {
  if (/^\s*(insert|update|delete|replace|create|drop|alter|pragma\b(?!\s+table_info)|vacuum|reindex)/i.test(sqlText)) {
    try { session.persist(); } catch { /* abaikan; file read-only? */ }
  }
}

function sqliteQuery(session, _database, sqlText) {
  const results = session.db.exec(sqlText);
  sqlitePersistIfChanged(session, sqlText);
  if (!results.length) {
    // statement non-SELECT tanpa output
    return Promise.resolve(ok({ columns: ['ok'], rows: [['1']], rowCount: 1, truncated: false }));
  }
  const first = results[0];
  const cols = first.columns || [];
  const vals = first.values || [];
  const limited = vals.slice(0, MAX_ROWS);
  return Promise.resolve(ok({
    columns: cols,
    rows: limited.map((r) => r.map(normalizeCell)),
    rowCount: vals.length,
    truncated: vals.length > MAX_ROWS,
  }, results.length > 1 ? { note: 'Menampilkan hasil statement #1 dari ' + results.length } : undefined));
}

// ---------- MongoDB ----------
async function createMongo(c) {
  const { MongoClient } = require('mongodb');
  const host = c.host;
  const authPart = c.user ? encodeURIComponent(c.user) + ':' + encodeURIComponent(c.password) + '@' : '';
  const dbPart = '/' + (c.database || 'admin');
  const uri = 'mongodb://' + authPart + host + ':' + c.port + dbPart;
  const client = new MongoClient(uri, {
    connectTimeoutMS: 8000, serverSelectionTimeoutMS: 8000,
    authSource: c.database || 'admin', retryWrites: false,
  });
  await client.connect();
  await client.db('admin').command({ ping: 1 });
  return {
    kind: 'mongodb', config: c, client,
    async close() { try { await this.client.close(); } catch {} },
  };
}

async function mongoFind(session, database, sqlText) {
  let parsed;
  try { parsed = JSON.parse(sqlText); } catch (e) {
    throw new Error('Input harus berupa JSON object, contoh: { "collection": "users", "filter": { "active": true }, "limit": 50 }');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Input harus berupa object JSON.');
  const collection = String(parsed.collection || '').trim();
  if (!collection) throw new Error('Field "collection" wajib diisi.');
  const db = session.client.db(database || session.config.database || 'test');
  const filter = parsed.filter && typeof parsed.filter === 'object' ? parsed.filter : {};
  const limit = Math.max(1, Math.min(200, Number(parsed.limit) || 50));
  const docs = await db.collection(collection).find(filter, { projection: parsed.project }).limit(limit).toArray();
  return ok(gridFromObjects(docs));
}

// ---------- Redis ----------
function shellSplit(line) {
  const out = [];
  let cur = '', quote = null, esc = false;
  const push = () => { if (cur !== '' || quote !== null) out.push(cur); cur = ''; };
  for (const ch of String(line)) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { push(); continue; }
    cur += ch;
  }
  push();
  return out;
}

function redisGridFromReply(reply) {
  if (reply === null || reply === undefined) return { columns: ['value'], rows: [['']], rowCount: 1, truncated: false };
  if (Buffer.isBuffer(reply)) reply = '[binary ' + reply.length + ' bytes]';
  if (typeof reply === 'number') return { columns: ['result'], rows: [[String(reply)]], rowCount: 1, truncated: false };
  if (typeof reply === 'string') { const lines = reply.split('\n'); return { columns: ['value'], rows: lines.map((l) => [l]), rowCount: lines.length, truncated: false }; }
  if (Array.isArray(reply)) {
    if (reply.length === 0) return { columns: ['value'], rows: [], rowCount: 0, truncated: false };
    if (reply.every((i) => i === null || ['string', 'number', 'boolean'].includes(typeof i) || Buffer.isBuffer(i))) {
      const rows = reply.slice(0, MAX_ROWS).map((i, idx) => [String(idx), normalizeCell(i)]);
      return { columns: ['index', 'value'], rows, rowCount: reply.length, truncated: reply.length > MAX_ROWS };
    }
    return ok(gridFromObjects(reply));
  }
  if (typeof reply === 'object') { try { return { columns: ['value'], rows: [[JSON.stringify(reply, null, 2)]], rowCount: 1, truncated: false }; } catch { return { columns: ['value'], rows: [[String(reply)]], rowCount: 1, truncated: false }; } }
  return { columns: ['value'], rows: [[String(reply)]], rowCount: 1, truncated: false };
}

async function createRedis(c) {
  const { createClient } = require('redis');
  const client = createClient({
    socket: { host: c.host, port: c.port, connectTimeout: 8000, reconnectStrategy: false },
    password: c.password || undefined,
  });
  client.on('error', () => {});
  await client.connect();
  await client.ping();
  return { kind: 'redis', config: c, client, async close() { try { await this.client.quit(); } catch { try { this.client.disconnect(); } catch {} } } };
}

async function redisCommand(session, _database, sqlText) {
  const tokens = shellSplit(sqlText);
  if (!tokens.length) throw new Error('Perintah kosong. Contoh: GET nama_kunci');
  const reply = await session.client.sendCommand(tokens);
  return ok(redisGridFromReply(reply));
}

async function redisKeys(session, limit) {
  const max = Math.max(1, Math.min(500, Number(limit) || 200));
  const keys = [];
  for await (const key of session.client.scanIterator({ MATCH: '*', COUNT: 100 })) {
    keys.push(key);
    if (keys.length >= max) break;
  }
  const withTypes = [];
  for (const key of keys) {
    let type = '?';
    try { type = await session.client.type(key); } catch {}
    withTypes.push({ name: key, type });
  }
  return { ok: true, items: withTypes, total: keys.length, truncated: keys.length >= max };
}

async function redisValue(session, key) {
  const client = session.client;
  const type = await client.type(key).catch(() => 'none');
  let reply;
  if (type === 'string') reply = await client.get(key);
  else if (type === 'hash') { const all = await client.hGetAll(key); reply = Object.entries(all).map(([field, value]) => ({ field, value })); }
  else if (type === 'list') reply = await client.lRange(key, 0, 99);
  else if (type === 'set') reply = await client.sMembers(key);
  else if (type === 'zset') reply = await client.zRangeWithScores(key, 0, 99);
  else reply = ['(tipe ' + type + ' — gunakan perintah manual)'];
  if (Array.isArray(reply) && reply.length && typeof reply[0] === 'object' && reply[0] !== null && 'value' in reply[0] && 'score' in reply[0]) {
    reply = reply.map((i) => ({ member: i.value, score: i.score }));
  }
  return ok(redisGridFromReply(reply), { note: 'TYPE ' + type });
}

// ---------- Elasticsearch ----------
async function createElastic(c) {
  const { Client } = require('@elastic/elasticsearch');
  const node = 'http://' + c.host + ':' + c.port;
  const client = new Client({
    node,
    auth: c.user ? { username: c.user, password: c.password } : undefined,
    requestTimeout: 10000, maxRetries: 0,
  });
  await client.ping({ requestTimeout: 8000 });
  return { kind: 'elasticsearch', config: c, client, async close() { try { await this.client.close(); } catch {} } };
}

async function elasticIndices(session) {
  const out = await session.client.cat.indices({ format: 'json', h: 'index,health,status,docs.count,store.size' });
  const arr = Array.isArray(out) ? out : (out.body || []);
  return { ok: true, items: arr.map((i) => ({ name: i.index, health: i.health, docs: i['docs.count'], size: i['store.size'] })) };
}

async function elasticSearch(session, _database, sqlText) {
  let parsed;
  try { parsed = JSON.parse(sqlText); } catch (e) {
    throw new Error('Input harus JSON, contoh: { "index": "logs-*", "size": 50, "query": { "match_all": {} } }');
  }
  const index = String(parsed.index || '').trim();
  if (!index) throw new Error('Field "index" wajib diisi, contoh: "logs-*" atau "my-index"');
  const size = Math.max(1, Math.min(200, Number(parsed.size) || 50));
  const query = parsed.query && typeof parsed.query === 'object' ? parsed.query : { match_all: {} };
  const res = await session.client.search({ index, size, query });
  const body = res.body || res;
  const hits = (body && body.hits && body.hits.hits) || [];
  const cols = ['_index', '_id', '_score'];
  const topKeys = [];
  const seen = new Set();
  for (const h of hits.slice(0, 50)) {
    const src = h._source && typeof h._source === 'object' ? Object.keys(h._source) : [];
    for (const k of src) if (!seen.has(k)) { seen.add(k); topKeys.push(k); }
  }
  const allCols = cols.concat(topKeys);
  const rows = hits.map((h) => {
    const src = h._source || {};
    return [h._index, h._id, h._score === undefined ? '' : String(h._score)].concat(topKeys.map((k) => normalizeCell(src[k])));
  });
  const total = body && body.hits && body.hits.total && (body.hits.total.value ?? body.hits.total);
  return ok({ columns: allCols, rows, rowCount: typeof total === 'number' ? total : hits.length, truncated: hits.length >= size }, { note: hits.length + ' hits (total ' + (typeof total === 'number' ? total : '?') + ')' });
}

// ---------- Public API ----------
async function createSession(cfg) {
  const c = normalizeCfg(cfg);
  switch (c.kind) {
    case 'mysql': return createMysql(c);
    case 'postgres': return createPostgres(c);
    case 'sqlserver': return createSqlServer(c);
    case 'sqlite': return createSqlite(c);
    case 'mongodb': return createMongo(c);
    case 'redis': return createRedis(c);
    case 'elasticsearch': return createElastic(c);
    default: throw new Error('Tipe tidak didukung: ' + c.kind);
  }
}

async function closeSession(session) { if (session && typeof session.close === 'function') await session.close(); }

async function listDatabases(session) {
  switch (session.kind) {
    case 'mysql': {
      const conn = await session.connFor('');
      const [rows] = await conn.query('SHOW DATABASES');
      return { ok: true, items: rows.map((r) => r.Database || Object.values(r)[0]).filter(Boolean) };
    }
    case 'postgres': {
      const client = await session.connFor(session.baseDatabase);
      const res = await client.query("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname");
      return { ok: true, items: res.rows.map((r) => r.datname) };
    }
    case 'sqlserver': {
      const pool = await session.poolFor('master');
      const res = await pool.request().query("SELECT name FROM sys.databases WHERE database_id > 4 AND state = 0 ORDER BY name");
      return { ok: true, items: (res.recordset || []).map((r) => r.name) };
    }
    case 'sqlite':
      return { ok: true, items: ['main'] };
    case 'mongodb': {
      const res = await session.client.db('admin').command({ listDatabases: 1, nameOnly: true });
      return { ok: true, items: (res.databases || []).map((d) => d.name) };
    }
    case 'redis':
      return { ok: true, items: ['DB0'] };
    case 'elasticsearch': {
      const idx = await elasticIndices(session);
      return { ok: true, items: idx.items.map((i) => i.name) };
    }
    default: return { ok: false, error: 'Tipe tidak didukung: ' + session.kind };
  }
}

async function listTables(session, database) {
  switch (session.kind) {
    case 'mysql': {
      const conn = await session.connFor(database);
      const [rows] = await conn.query('SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name', [database]);
      return { ok: true, items: rows.map((r) => ({ name: r.name || r.TABLE_NAME, type: r.type || r.TABLE_TYPE })) };
    }
    case 'postgres': {
      const client = await session.connFor(database);
      const res = await client.query("SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
      return { ok: true, items: res.rows.map((r) => ({ name: r.name, type: r.type })) };
    }
    case 'sqlserver': {
      const pool = await session.poolFor(database);
      const res = await pool.request().query("SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE IN ('BASE TABLE','VIEW') ORDER BY TABLE_NAME");
      return { ok: true, items: (res.recordset || []).map((r) => ({ name: r.name, type: r.type })) };
    }
    case 'sqlite': {
      const res = session.db.exec("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
      const items = res.length ? res[0].values.map((r) => ({ name: String(r[0]), type: String(r[1]) })) : [];
      return { ok: true, items };
    }
    case 'mongodb': {
      const db = session.client.db(database || session.config.database || 'test');
      const cols = await db.listCollections({}, { nameOnly: true }).toArray();
      return { ok: true, items: cols.filter((c) => !String(c.name).startsWith('system.')).map((c) => ({ name: c.name, type: 'collection' })) };
    }
    case 'redis':
      return redisKeys(session, 300);
    case 'elasticsearch': {
      const idx = await elasticIndices(session);
      return { ok: true, items: idx.items.filter((i) => i.name === database).map((i) => ({ name: i.name, type: 'index (' + (i.docs || '?') + ' docs)' })) };
    }
    default: return { ok: false, error: 'Tipe tidak didukung: ' + session.kind };
  }
}

function quoteIdent(kind, name) {
  const s = String(name);
  if (kind === 'mysql') return '`' + s.replace(/`/g, '``') + '`';
  if (kind === 'sqlserver') return '[' + s.replace(/]/g, ']]') + ']';
  return '"' + s.replace(/"/g, '""') + '"'; // postgres / sqlite
}

async function runQuery(session, database, sqlText) {
  const sql = String(sqlText || '').trim();
  if (!sql) throw new Error('Query kosong.');
  try {
    return await timed(async () => {
      switch (session.kind) {
        case 'mysql': return mysqlQuery(session, database, sql);
        case 'postgres': return pgQuery(session, database, sql);
        case 'sqlserver': return sqlServerQuery(session, database, sql);
        case 'sqlite': return sqliteQuery(session, database, sql);
        case 'mongodb': return mongoFind(session, database, sql);
        case 'redis': return redisCommand(session, database, sql);
        case 'elasticsearch': return elasticSearch(session, database, sql);
        default: throw new Error('Tipe tidak didukung: ' + session.kind);
      }
    });
  } catch (err) {
    return fail(err);
  }
}

async function redisKeyValue(session, key) {
  try { return await timed(() => redisValue(session, key)); } catch (err) { return fail(err); }
}

module.exports = {
  KINDS, DEFAULT_PORT, SQL_KINDS, isDbProtocol, defaultPortFor,
  createSession, closeSession, listDatabases, listTables, runQuery, redisKeyValue,
  quoteIdent, shellSplit,
};
