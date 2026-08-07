const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs').promises;
const Logger = require('./utils/logger');

// Create SQLite database
const dbPath = path.join(__dirname, '../data/bajao_bhai.db');
const db = new Database(dbPath, { timeout: 5000 });
const VERBOSE_DB_LOGS = process.env.BB_VERBOSE_DB_LOGS !== '0';

// Enable foreign keys and modern concurrency mode
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL'); // WAL mode is safe with synchronous=NORMAL

function formatSql(sql) {
  return String(sql || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

// unused formatParams function removed

// Statement cache for high-concurrency optimization
const stmtCache = new Map();

function getCachedStatement(sql) {
  if (stmtCache.has(sql)) {
    return stmtCache.get(sql);
  }
  const stmt = db.prepare(sql);

  // LRU simple eviction: keep cache under 200 statements
  if (stmtCache.size >= 200) {
    const firstKey = stmtCache.keys().next().value;
    stmtCache.delete(firstKey);
  }

  stmtCache.set(sql, stmt);
  return stmt;
}

// NOTE: better-sqlite3 is synchronous. This function returns values directly.
// Existing call sites may still use `await query(...)`; that is harmless because
// awaiting a non-Promise returns the value as-is.
function query(sql, params = []) {
  const label = `query: ${formatSql(sql)}`;
  try {
    if (VERBOSE_DB_LOGS) {
      Logger.time('db', label);
    }

    const stmt = getCachedStatement(sql);
    const normalizedSql = sql.trim().toUpperCase();
    if (
      normalizedSql.startsWith('SELECT') ||
      normalizedSql.startsWith('WITH') ||
      normalizedSql.startsWith('PRAGMA')
    ) {
      const rows = stmt.all(...params);
      if (VERBOSE_DB_LOGS) {
        Logger.timeEnd('db', label);
        Logger.info('db', `<- rows=${rows.length}`);
      }
      return rows;
    } else {
      const result = stmt.run(...params);
      if (VERBOSE_DB_LOGS) {
        Logger.timeEnd('db', label);
        Logger.info('db', `<- changes=${result.changes} insertId=${result.lastInsertRowid}`);
      }
      return {
        insertId: Number(result.lastInsertRowid),
        changes: result.changes,
      };
    }
  } catch (err) {
    Logger.error('db', `Query error: ${sql}`, err);
    throw err;
  }
}

// Synchronously run a batch of queries or a callback within a native better-sqlite3 transaction.
// Prevents JS event loop yields from holding DB locks.
const runTransactionSync = (input) => {
  if (typeof input === 'function') {
    // In better-sqlite3, .immediate() on the transaction wrapper executes the transaction.
    return db.transaction(input).immediate();
  }

  return db.transaction((queries) => {
    for (const q of queries) {
      const stmt = getCachedStatement(q.sql);
      const normalizedSql = q.sql.trim().toUpperCase();
      if (
        normalizedSql.startsWith('SELECT') ||
        normalizedSql.startsWith('WITH') ||
        normalizedSql.startsWith('PRAGMA')
      ) {
        stmt.all(...(q.values || []));
      } else {
        stmt.run(...(q.values || []));
      }
    }
  })(input);
};

function getTableColumns(tableName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return new Set(rows.map((r) => r.name));
}

function runSafeAlter(statement) {
  try {
    db.prepare(statement).run();
  } catch (err) {
    if (!String(err.message || '').includes('duplicate column name')) {
      throw err;
    }
  }
}

function rebuildSongsForLegacyColumns(columns) {
  const hasArtist = columns.has('artist');
  const hasDuration = columns.has('duration');
  const hasChannelName = columns.has('channel_name');
  const hasDurationSeconds = columns.has('duration_seconds');

  if ((!hasArtist || hasChannelName) && (!hasDuration || hasDurationSeconds)) {
    return;
  }

  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE songs_new (
        song_id INTEGER PRIMARY KEY AUTOINCREMENT,
        party_code TEXT NOT NULL,
        video_id TEXT NOT NULL,
        title TEXT NOT NULL,
        channel_name TEXT,
        thumbnail TEXT,
        duration_seconds INTEGER DEFAULT 0,
        added_by INTEGER,
        status TEXT DEFAULT 'queued',
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const channelExpr = hasChannelName ? 'channel_name' : hasArtist ? 'artist' : 'NULL';
    const durationExpr = hasDurationSeconds
      ? 'duration_seconds'
      : hasDuration
        ? 'CAST(duration AS INTEGER)'
        : '0';

    db.exec(`
      INSERT INTO songs_new (song_id, party_code, video_id, title, channel_name, thumbnail, duration_seconds, added_by, status, added_at)
      SELECT song_id, party_code, video_id, title, ${channelExpr}, thumbnail, ${durationExpr}, added_by, status, added_at
      FROM songs
    `);

    db.exec('DROP TABLE songs');
    db.exec('ALTER TABLE songs_new RENAME TO songs');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function applyMigrations() {
  runSafeAlter('ALTER TABLE parties ADD COLUMN is_public INTEGER DEFAULT 0');
  runSafeAlter('ALTER TABLE parties ADD COLUMN party_name TEXT');
  runSafeAlter('ALTER TABLE parties ADD COLUMN ended_at DATETIME');

  runSafeAlter("ALTER TABLE users ADD COLUMN avatar_color TEXT DEFAULT '#6366f1'");
  runSafeAlter('ALTER TABLE users ADD COLUMN favorite_genre TEXT');

  const songColumns = getTableColumns('songs');
  rebuildSongsForLegacyColumns(songColumns);

  runSafeAlter('ALTER TABLE songs ADD COLUMN channel_name TEXT');
  runSafeAlter('ALTER TABLE songs ADD COLUMN duration_seconds INTEGER DEFAULT 0');

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_code TEXT,
      user_id INTEGER,
      action TEXT NOT NULL,
      detail TEXT,
      node_id TEXT,
      logged_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_party ON audit_log(party_code)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      msg_id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_code TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_chat_party_time ON chat_messages(party_code, sent_at DESC)'
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS analytics_snapshots (
      snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      active_parties INTEGER DEFAULT 0,
      online_users INTEGER DEFAULT 0,
      total_songs INTEGER DEFAULT 0,
      total_votes INTEGER DEFAULT 0,
      active_sockets INTEGER DEFAULT 0,
      heap_used_mb INTEGER DEFAULT 0,
      rss_mb INTEGER DEFAULT 0
    )
  `);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_snapshots_recorded ON analytics_snapshots(recorded_at DESC)'
  );

  // Hot-path indexes for queue, votes, and online user lookups.
  db.exec('CREATE INDEX IF NOT EXISTS idx_parties_status ON parties(status)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_users_party_online_role_joined ON users(party_code, is_online, role, joined_at)'
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_socket_id ON users(socket_id)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_songs_party_status_added ON songs(party_code, status, added_at)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_songs_party_video_status ON songs(party_code, video_id, status)'
  );
  // UNIQUE index to prevent duplicate queued items of same video in same party
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_unique_queued ON songs(party_code, video_id) WHERE status = 'queued'"
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_songs_added_by_party_status ON songs(added_by, party_code, status)'
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_votes_song_id ON votes(song_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_votes_user_song ON votes(user_id, song_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_skip_votes_song_id ON skip_votes(song_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reactions_song_id ON reactions(song_id)');

  // Guard against legacy databases that might contain duplicate vote rows.
  db.exec(`
    DELETE FROM votes
    WHERE vote_id NOT IN (
      SELECT MIN(vote_id)
      FROM votes
      GROUP BY user_id, song_id
    )
  `);
  db.exec(`
    DELETE FROM skip_votes
    WHERE skip_id NOT IN (
      SELECT MIN(skip_id)
      FROM skip_votes
      GROUP BY user_id, song_id
    )
  `);

  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_unique_user_song ON votes(user_id, song_id)'
  );
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_skip_votes_unique_user_song ON skip_votes(user_id, song_id)'
  );
}

// Compatibility pool-like interface for existing code paths
const pool = {
  query: (sql, params = []) => query(sql, params),
};

async function initSchema() {
  try {
    const schemaFile = path.join(__dirname, '../db/schema_v3.sql');
    const sql = await fs.readFile(schemaFile, 'utf8');
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      db.exec(stmt);
    }
    applyMigrations();
    Logger.info('db', 'Database schema initialized (schema_v3.sql) with safe migrations');
  } catch (err) {
    Logger.error('db', `Failed to initialize schema: ${err.message}`, err);
    throw err;
  }
}

module.exports = {
  pool,
  query,
  runTransactionSync,
  initSchema,
  db,
};
