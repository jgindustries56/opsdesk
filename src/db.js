'use strict';

/**
 * One data layer, two drivers.
 *
 *   - Railway (or any Postgres): set DATABASE_URL.
 *   - Your laptop, with zero setup: leave DATABASE_URL unset and it writes to
 *     a local SQLite file. Same SQL, same code paths, no install, no cost.
 *
 * Queries are written in Postgres style ($1, $2, ...). For SQLite the
 * placeholders are rewritten to `?` on the way through.
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const usingPostgres = Boolean(config.databaseUrl);

let pool = null;
let sqlite = null;

/** Dialect-specific fragments used by the schema. */
const D = usingPostgres
  ? {
      id: 'BIGSERIAL PRIMARY KEY',
      fk: 'BIGINT',
      int: 'BIGINT',
      qty: 'NUMERIC(14,3)',
      text: 'TEXT',
      ts: 'TIMESTAMPTZ',
      bool: 'BOOLEAN',
      now: 'NOW()',
      true: 'TRUE',
      false: 'FALSE',
    }
  : {
      id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
      fk: 'INTEGER',
      int: 'INTEGER',
      qty: 'REAL',
      text: 'TEXT',
      ts: 'TEXT',
      bool: 'INTEGER',
      // Parenthesised so SQLite accepts it as a column DEFAULT, and formatted
      // as ISO-8601 UTC so both drivers store timestamps the same shape.
      now: "(strftime('%Y-%m-%dT%H:%M:%SZ','now'))",
      true: '1',
      false: '0',
    };

/**
 * Rewrite Postgres-style numbered placeholders to SQLite positional ones.
 *
 * A parameter may legitimately appear more than once ("updated_at=$8, created_at=$8"),
 * so the parameter array is rebuilt in order of appearance rather than reused
 * as-is — otherwise the counts drift and the driver silently mismatches.
 */
function toSqliteSql(sql, params) {
  const ordered = [];
  const rewritten = sql.replace(/\$(\d+)/g, (_, n) => {
    ordered.push(params[Number(n) - 1]);
    return '?';
  });
  return { sql: rewritten, params: ordered };
}

function normaliseParams(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return usingPostgres ? p : p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    return p;
  });
}

async function init() {
  if (usingPostgres) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl)
        ? false
        : { rejectUnauthorized: false },
      max: 8,
    });
    await pool.query('SELECT 1');
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const file = path.resolve(config.sqlitePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    sqlite = new DatabaseSync(file);
    sqlite.exec('PRAGMA journal_mode = WAL');
    sqlite.exec('PRAGMA foreign_keys = ON');
  }
}

/** Run a statement. Returns { rows }. */
async function query(sql, params = []) {
  const args = normaliseParams(params);
  if (usingPostgres) {
    const res = await pool.query(sql, args);
    return { rows: res.rows, rowCount: res.rowCount };
  }
  const prepared = toSqliteSql(sql, args);
  const stmt = sqlite.prepare(prepared.sql);
  const isRead = /^\s*(SELECT|WITH|PRAGMA)/i.test(sql) || /RETURNING/i.test(sql);
  if (isRead) {
    const rows = stmt.all(...prepared.params).map((r) => ({ ...r }));
    return { rows, rowCount: rows.length };
  }
  const info = stmt.run(...prepared.params);
  return { rows: [], rowCount: Number(info.changes || 0) };
}

/** Convenience: first row or null. */
async function one(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows[0] || null;
}

/** Convenience: all rows. */
async function all(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows;
}

/** Raw DDL, no parameters. */
async function exec(sql) {
  if (usingPostgres) {
    await pool.query(sql);
  } else {
    sqlite.exec(sql);
  }
}

async function close() {
  if (pool) await pool.end();
  if (sqlite) sqlite.close();
}

module.exports = { init, query, one, all, exec, close, D, usingPostgres };
