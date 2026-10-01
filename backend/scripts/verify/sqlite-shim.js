/**
 * better-sqlite3 → node:sqlite compatibility shim.
 *
 * This container/host has no compiled `better_sqlite3.node`, so local end-to-end
 * runs cannot use the real driver. Node 24 ships `node:sqlite`, whose API is close
 * enough that a thin adapter lets the *unmodified* backend run. This exists purely
 * for local verification; Docker uses the real better-sqlite3.
 */
const { DatabaseSync } = require('node:sqlite');

/** node:sqlite rejects booleans and undefined; SQLite wants 1/0 and NULL. */
function norm(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'bigint') return Number(v);
  return v;
}

class Statement {
  constructor(stmt) {
    this._s = stmt;
  }
  get(...params) {
    const row = this._s.get(...params.map(norm));
    return row === undefined ? undefined : row;
  }
  all(...params) {
    return this._s.all(...params.map(norm));
  }
  run(...params) {
    const r = this._s.run(...params.map(norm));
    return {
      changes: Number(r.changes ?? 0),
      lastInsertRowid: Number(r.lastInsertRowid ?? 0),
    };
  }
  /** better-sqlite3 supports iterating a statement. */
  *iterate(...params) {
    yield* this._s.all(...params.map(norm));
  }
}

class Database {
  constructor(path, options = {}) {
    this._raw = new DatabaseSync(path, options);
    // WAL matches the production pragmas and keeps cross-process reads sane.
    try {
      this._raw.exec('PRAGMA journal_mode = WAL');
      this._raw.exec('PRAGMA foreign_keys = ON');
    } catch {
      /* in-memory or read-only database */
    }
  }

  prepare(sql) {
    return new Statement(this._raw.prepare(sql));
  }

  exec(sql) {
    this._raw.exec(sql);
    return this;
  }

  /**
   * better-sqlite3's `pragma()` returns rows for a querying pragma and nothing for
   * a setter. `addColumnIfMissing` relies on the rows form (`table_info`).
   */
  pragma(text) {
    const sql = `PRAGMA ${text}`;
    try {
      return this._raw.prepare(sql).all();
    } catch {
      this._raw.exec(sql);
      return undefined;
    }
  }

  /** Returns a function that runs `fn` inside BEGIN/COMMIT, like better-sqlite3. */
  transaction(fn) {
    const self = this;
    return function (...args) {
      self._raw.exec('BEGIN');
      try {
        const out = fn.apply(this, args);
        self._raw.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          self._raw.exec('ROLLBACK');
        } catch {
          /* already rolled back */
        }
        throw err;
      }
    };
  }

  close() {
    this._raw.close();
  }

  /** Some call sites reach for the underlying handle. */
  get raw() {
    return this;
  }
}

/** better-sqlite3's default export is the constructor. */
module.exports = Database;
module.exports.default = Database;
module.exports.Database = Database;