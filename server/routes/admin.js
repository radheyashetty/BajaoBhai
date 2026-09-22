const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query, runTransactionSync } = require('../db');
const { getAliveNodes } = require('../utils/nodeRegistry');
const { endParty } = require('../utils/partyCleanup');
const { getGlobalPlaybackMode, setGlobalPlaybackMode } = require('../utils/redisClient');
const Logger = require('../utils/logger');
const { getHealthSummary, getAlerts, clearAlerts } = require('../utils/systemHealth');
const { isValidPartyCode } = require('../utils/validators');

router.use((req, _res, next) => {
  Logger.info('route:admin', `${req.method} ${req.originalUrl}`);
  next();
});

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/* ================= ADMIN AUTH ================= */
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  const secret = process.env.ADMIN_SECRET;
  const sourceIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

  if (!secret) {
    Logger.error('admin', 'ADMIN_SECRET missing in env');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  const expected = `Bearer ${secret}`;
  if (!auth || !safeCompare(auth, expected)) {
    const receivedLen = auth ? auth.length : 0;
    const expectedLen = expected.length;
    Logger.warn(
      'admin',
      `unauthorized request ip=${sourceIp} method=${req.method} path=${req.originalUrl} receivedLen=${receivedLen} expectedLen=${expectedLen}`
    );
    return res.status(401).json({ error: 'Unauthorized' });
  }

  Logger.info(
    'admin',
    `authorized request ip=${sourceIp} method=${req.method} path=${req.originalUrl}`
  );

  next();
}

/* ================= LOGIN ENDPOINT ================= */
router.post('/login', (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  const sourceIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

  if (!secret) {
    Logger.error('admin', 'ADMIN_SECRET missing in env');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  const submittedKey = String(req.body?.key || '').trim();
  if (!submittedKey) {
    return res.status(400).json({ error: 'Admin key is required' });
  }

  if (!safeCompare(submittedKey, secret)) {
    Logger.warn(
      'admin',
      `login failed ip=${sourceIp} submittedLen=${submittedKey.length} expectedLen=${secret.length}`
    );
    return res.status(401).json({ error: 'Invalid admin key' });
  }

  Logger.info('admin', `login success ip=${sourceIp}`);
  return res.json({ message: 'Authenticated', token: submittedKey });
});

/* ================= HELPERS ================= */
function validatePartyCode(code) {
  return isValidPartyCode(code);
}

function normalizePartyCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase();
}

function normalizeStatus(status) {
  return String(status || '')
    .trim()
    .toLowerCase();
}

const ADMIN_DB_TABLES = Object.freeze([
  'parties',
  'users',
  'songs',
  'votes',
  'skip_votes',
  'reactions',
  'audit_log',
  'chat_messages',
  'analytics_snapshots',
]);

const ADMIN_DB_ROW_DELETE_CONFIG = Object.freeze({
  votes: 'vote_id',
  skip_votes: 'skip_id',
  reactions: 'reaction_id',
  audit_log: 'log_id',
  chat_messages: 'msg_id',
  analytics_snapshots: 'snapshot_id',
});

let lastSnapshotAt = 0;
const SNAPSHOT_THROTTLE_MS = 60_000; // max 1 snapshot per 60s

function normalizeTableName(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function isAllowedAdminTable(tableName) {
  return ADMIN_DB_TABLES.includes(tableName);
}

function getAdminRowDeleteKey(tableName) {
  return ADMIN_DB_ROW_DELETE_CONFIG[tableName] || null;
}

function escapeLikePattern(value) {
  return String(value || '').replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

async function runTransaction(queries = []) {
  return runTransactionSync(() => {
    for (const q of queries) {
      query(q.sql, q.values || []);
    }
  });
}

router.get('/nodes', requireAdmin, async (_req, res) => {
  try {
    const nodes = await getAliveNodes();
    return res.json({ nodes, count: nodes.length });
  } catch (err) {
    Logger.error('admin', `GET /nodes error: ${err.message}`, err);
    return res.status(500).json({ error: 'Failed to fetch live nodes' });
  }
});

/* ================= GET PARTIES ================= */
router.get('/parties', requireAdmin, async (req, res) => {
  try {
    const parties = await query(`
      SELECT 
        p.party_code,
        p.party_name,
        p.status,
        COUNT(u.user_id) AS active_users
      FROM parties p
      LEFT JOIN users u 
        ON u.party_code = p.party_code AND u.is_online = 1
      GROUP BY p.party_code, p.party_name, p.status
    `);

    res.json({ parties });
  } catch (err) {
    Logger.error('admin', `GET /parties error: ${err.message}`, err);
    res.status(500).json({ error: 'Failed to fetch parties' });
  }
});

/* ================= SYSTEM HEALTH ================= */
router.get('/health/summary', requireAdmin, async (_req, res) => {
  try {
    const summary = getHealthSummary();
    return res.json(summary);
  } catch (err) {
    Logger.error('admin', `GET /health/summary error: ${err.message}`, err);
    return res.status(500).json({ error: 'Failed to fetch health summary' });
  }
});

router.get('/health/alerts', requireAdmin, async (req, res) => {
  try {
    const limit = Number.parseInt(req.query.limit, 10) || 50;
    const category = req.query.category || null;
    const alerts = getAlerts(limit, category);
    return res.json({ alerts, count: alerts.length });
  } catch (err) {
    Logger.error('admin', `GET /health/alerts error: ${err.message}`, err);
    return res.status(500).json({ error: 'Failed to fetch health alerts' });
  }
});

router.post('/health/clear', requireAdmin, async (_req, res) => {
  try {
    const count = clearAlerts();
    return res.json({ message: `Cleared ${count} alerts`, count });
  } catch (err) {
    Logger.error('admin', `POST /health/clear error: ${err.message}`, err);
    return res.status(500).json({ error: 'Failed to clear health alerts' });
  }
});

/* ================= GET USERS ================= */
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const parsedOffset = Number.parseInt(req.query.offset, 10);
    const limit = Number.isNaN(parsedLimit) ? 100 : Math.min(Math.max(parsedLimit, 1), 1000);
    const offset = Number.isNaN(parsedOffset) ? 0 : Math.max(parsedOffset, 0);

    const users = await query(
      `
      SELECT user_id, username, party_code, role, is_online
      FROM users
      LIMIT ? OFFSET ?
    `,
      [limit, offset]
    );

    res.json({ users, limit, offset });
  } catch (err) {
    Logger.error('admin', `GET /users error: ${err.message}`, err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/* ================= END PARTY ================= */
router.post('/parties/:partyCode/end', requireAdmin, async (req, res) => {
  try {
    const partyCode = normalizePartyCode(req.params.partyCode);

    if (!validatePartyCode(partyCode)) {
      return res.status(400).json({ error: 'Invalid party code' });
    }

    const existing = await query('SELECT party_code FROM parties WHERE party_code = ? LIMIT 1', [
      partyCode,
    ]);
    if (!existing.length) {
      return res.status(404).json({ error: 'Party not found' });
    }

    const io = req.app.get('io');
    await endParty(io, partyCode, 'admin-end');

    res.json({ message: 'Party ended successfully' });
  } catch (err) {
    Logger.error('admin', `END PARTY error: ${err.message}`, err);
    res.status(500).json({ error: 'Failed to end party' });
  }
});

/* ================= DELETE PARTY ================= */
router.delete('/parties/:partyCode', requireAdmin, async (req, res) => {
  try {
    const partyCode = normalizePartyCode(req.params.partyCode);

    if (!validatePartyCode(partyCode)) {
      return res.status(400).json({ error: 'Invalid party code' });
    }

    const existing = await query('SELECT party_code FROM parties WHERE party_code = ? LIMIT 1', [
      partyCode,
    ]);
    if (!existing.length) {
      return res.status(404).json({ error: 'Party not found' });
    }

    const io = req.app.get('io');
    await endParty(io, partyCode, 'admin-delete');

    await runTransaction([
      {
        sql: 'DELETE FROM reactions WHERE song_id IN (SELECT song_id FROM songs WHERE party_code = ?)',
        values: [partyCode],
      },
      {
        sql: 'DELETE FROM skip_votes WHERE song_id IN (SELECT song_id FROM songs WHERE party_code = ?)',
        values: [partyCode],
      },
      {
        sql: 'DELETE FROM chat_messages WHERE party_code = ?',
        values: [partyCode],
      },
      {
        sql: 'DELETE FROM votes WHERE song_id IN (SELECT song_id FROM songs WHERE party_code = ?)',
        values: [partyCode],
      },
      {
        sql: 'DELETE FROM songs WHERE party_code = ?',
        values: [partyCode],
      },
      {
        sql: 'DELETE FROM users WHERE party_code = ?',
        values: [partyCode],
      },
      {
        sql: 'DELETE FROM parties WHERE party_code = ?',
        values: [partyCode],
      },
    ]);

    res.json({ message: 'Party deleted successfully' });
  } catch (err) {
    Logger.error('admin', `DELETE PARTY error: ${err.message}`, err);
    res.status(500).json({ error: 'Failed to delete party' });
  }
});

/* ================= FORCE PARTY STATUS ================= */
router.post('/parties/:partyCode/status', requireAdmin, async (req, res) => {
  try {
    const partyCode = normalizePartyCode(req.params.partyCode);
    const nextStatus = normalizeStatus(req.body?.status);

    if (!validatePartyCode(partyCode)) {
      return res.status(400).json({ error: 'Invalid party code' });
    }
    if (!['active', 'ended'].includes(nextStatus)) {
      return res.status(400).json({ error: 'Invalid status. Allowed: active, ended' });
    }

    const update = await query('UPDATE parties SET status = ? WHERE party_code = ?', [
      nextStatus,
      partyCode,
    ]);
    if (!update?.changes) {
      return res.status(404).json({ error: 'Party not found' });
    }

    const io = req.app.get('io');
    if (io && nextStatus === 'ended') {
      await endParty(io, partyCode, 'admin-status');
    }

    return res.json({ message: `Party marked as ${nextStatus}` });
  } catch (err) {
    Logger.error('admin', `FORCE PARTY STATUS error: ${err.message}`, err);
    return res.status(500).json({ error: 'Failed to update party status' });
  }
});

/* ================= FORCE HOST TRANSFER ================= */
router.post('/parties/:partyCode/host', requireAdmin, async (req, res) => {
  try {
    const partyCode = normalizePartyCode(req.params.partyCode);
    const userId = Number.parseInt(req.body?.userId, 10);

    if (!validatePartyCode(partyCode)) {
      return res.status(400).json({ error: 'Invalid party code' });
    }
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const targetUser = await query(
      'SELECT user_id, username, socket_id FROM users WHERE user_id = ? AND party_code = ? LIMIT 1',
      [userId, partyCode]
    );
    if (!targetUser.length) {
      return res.status(404).json({ error: 'Target user not found in this party' });
    }

    await runTransaction([
      {
        sql: "UPDATE users SET role = 'guest' WHERE party_code = ? AND role = 'host'",
        values: [partyCode],
      },
      {
        sql: "UPDATE users SET role = 'host' WHERE user_id = ?",
        values: [userId],
      },
      {
        sql: 'UPDATE parties SET host_user_id = ? WHERE party_code = ?',
        values: [userId, partyCode],
      },
    ]);

    const io = req.app.get('io');
    if (io) {
      const users = await query(
        'SELECT user_id AS userId, username, role, avatar_color AS avatarColor FROM users WHERE party_code = ? AND is_online = 1 ORDER BY joined_at ASC',
        [partyCode]
      );
      io.to(partyCode).emit('hostChanged', {
        newHostId: userId,
        newHostUsername: targetUser[0].username,
        reason: 'admin-transfer',
      });
      io.to(partyCode).emit('userList', { users });

      if (targetUser[0].socket_id) {
        io.to(targetUser[0].socket_id).emit('hostGranted', { partyCode, userId });
      }
    }

    return res.json({ message: 'Host updated successfully' });
  } catch (err) {
    Logger.error('admin', `FORCE HOST TRANSFER error: ${err.message}`, err);
    return res.status(500).json({ error: 'Failed to transfer host' });
  }
});

/* ================= KICK USER ================= */
router.delete('/users/:userId', requireAdmin, async (req, res) => {
  try {
    const userId = Number.parseInt(req.params.userId, 10);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const rows = await query(
      'SELECT user_id, username, party_code, role, socket_id FROM users WHERE user_id = ? LIMIT 1',
      [userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const target = rows[0];
    const partyCode = normalizePartyCode(target.party_code);
    const io = req.app.get('io');

    await runTransaction([
      {
        sql: 'DELETE FROM votes WHERE user_id = ?',
        values: [userId],
      },
      {
        sql: 'DELETE FROM skip_votes WHERE user_id = ?',
        values: [userId],
      },
      {
        sql: 'DELETE FROM reactions WHERE user_id = ?',
        values: [userId],
      },
      {
        sql: 'DELETE FROM songs WHERE added_by = ? AND party_code = ? AND status = ?',
        values: [userId, partyCode, 'queued'],
      },
      {
        sql: 'DELETE FROM users WHERE user_id = ?',
        values: [userId],
      },
    ]);

    let hostChangedPayload = null;
    if (target.role === 'host') {
      const replacement = await query(
        'SELECT user_id, username, socket_id FROM users WHERE party_code = ? AND is_online = 1 ORDER BY joined_at ASC LIMIT 1',
        [partyCode]
      );

      if (replacement.length) {
        const newHostId = replacement[0].user_id;
        await runTransaction([
          {
            sql: "UPDATE users SET role = 'guest' WHERE party_code = ?",
            values: [partyCode],
          },
          {
            sql: "UPDATE users SET role = 'host' WHERE user_id = ?",
            values: [newHostId],
          },
          {
            sql: 'UPDATE parties SET host_user_id = ? WHERE party_code = ?',
            values: [newHostId, partyCode],
          },
        ]);
        hostChangedPayload = {
          newHostId,
          newHostUsername: replacement[0].username,
          socketId: replacement[0].socket_id,
        };
      } else {
        await endParty(io, partyCode, 'admin-kick-last-host');
      }
    }

    if (io) {
      if (target.socket_id) {
        io.to(target.socket_id).emit('partyEnded', {
          partyCode,
          reason: 'admin-kick',
        });
      }

      if (hostChangedPayload) {
        io.to(partyCode).emit('hostChanged', {
          newHostId: hostChangedPayload.newHostId,
          newHostUsername: hostChangedPayload.newHostUsername,
          reason: 'admin-kick-host',
        });
        if (hostChangedPayload.socketId) {
          io.to(hostChangedPayload.socketId).emit('hostGranted', {
            partyCode,
            userId: hostChangedPayload.newHostId,
          });
        }
      }

      const users = await query(
        'SELECT user_id AS userId, username, role, avatar_color AS avatarColor FROM users WHERE party_code = ? AND is_online = 1 ORDER BY joined_at ASC',
        [partyCode]
      );
      io.to(partyCode).emit('userList', { users });
    }

    return res.json({ message: `User ${target.username} removed` });
  } catch (err) {
    Logger.error('admin', `KICK USER error: ${err.message}`, err);
    return res.status(500).json({ error: 'Failed to remove user' });
  }
});

/* ================= END ALL PARTIES ================= */
router.post('/parties/end-all', requireAdmin, async (req, res) => {
  try {
    const activeParties = await query('SELECT party_code FROM parties WHERE status = ?', [
      'active',
    ]);
    const partyCodes = activeParties.map((row) => normalizePartyCode(row.party_code));

    const io = req.app.get('io');
    for (const partyCode of partyCodes) {
      await endParty(io, partyCode, 'admin-end-all');
    }

    return res.json({ message: `Ended ${partyCodes.length} active parties` });
  } catch (err) {
    Logger.error('admin', `END ALL PARTIES error: ${err.message}`, err);
    return res.status(500).json({ error: 'Failed to end all parties' });
  }
});

/* ================= RESET SYSTEM ================= */
router.delete('/all', requireAdmin, async (req, res) => {
  try {
    if (req.query.confirm !== 'YES_DELETE_ALL') {
      return res.status(400).json({
        error: 'Confirmation required: add ?confirm=YES_DELETE_ALL',
      });
    }

    const activeParties = await query('SELECT party_code FROM parties WHERE status = ?', [
      'active',
    ]);

    const io = req.app.get('io');
    for (const row of activeParties) {
      const partyCode = normalizePartyCode(row.party_code);
      await endParty(io, partyCode, 'admin-reset');
    }

    await runTransaction([
      { sql: 'DELETE FROM reactions' },
      { sql: 'DELETE FROM skip_votes' },
      { sql: 'DELETE FROM votes' },
      { sql: 'DELETE FROM songs' },
      { sql: 'DELETE FROM chat_messages' },
      { sql: 'DELETE FROM analytics_snapshots' },
      { sql: 'DELETE FROM users' },
      { sql: 'DELETE FROM parties' },
    ]);

    res.json({ message: 'All data deleted safely' });
  } catch (err) {
    Logger.error('admin', `RESET SYSTEM error: ${err.message}`, err);
    res.status(500).json({ error: 'Failed to reset system' });
  }
});

/* ================= ANALYTICS ================= */
router.get('/analytics', requireAdmin, async (req, res) => {
  try {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const uptime = process.uptime();

    // Use allSettled so one query failure doesn't fail the entire request
    const results = await Promise.allSettled([
      query('SELECT COUNT(*) AS count FROM parties WHERE status = ?', ['active']),
      query('SELECT COUNT(*) AS count FROM users WHERE is_online = 1'),
      query('SELECT COUNT(*) AS count FROM songs'),
      query('SELECT COUNT(*) AS count FROM votes'),
    ]);

    const activeParties =
      results[0]?.status === 'fulfilled' ? results[0]?.value?.[0]?.count || 0 : 0;
    const onlineUsers = results[1]?.status === 'fulfilled' ? results[1]?.value?.[0]?.count || 0 : 0;
    const songs = results[2]?.status === 'fulfilled' ? results[2]?.value?.[0]?.count || 0 : 0;
    const votes = results[3]?.status === 'fulfilled' ? results[3]?.value?.[0]?.count || 0 : 0;

    const io = req.app.get('io');
    const activeSockets = io ? io.engine.clientsCount : 0;
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const rssMB = Math.round(mem.rss / 1024 / 1024);

    // Throttled snapshot recording — max 1 per 60s
    const now = Date.now();
    if (now - lastSnapshotAt >= SNAPSHOT_THROTTLE_MS) {
      lastSnapshotAt = now;
      try {
        query(
          `INSERT INTO analytics_snapshots (active_parties, online_users, total_songs, total_votes, active_sockets, heap_used_mb, rss_mb) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [activeParties, onlineUsers, songs, votes, activeSockets, heapUsedMB, rssMB]
        );
        // Prune snapshots older than 30 days
        query(`DELETE FROM analytics_snapshots WHERE recorded_at < datetime('now', '-30 days')`);
      } catch (snapErr) {
        Logger.warn('admin', `Snapshot recording failed: ${snapErr.message}`);
      }
    }

    res.json({
      system: {
        uptime: Math.round(uptime),
        nodeVersion: process.version,
      },
      memory: {
        rssMB,
        heapUsedMB,
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      },
      cpu: {
        userMs: Math.round(cpu.user / 1000),
        systemMs: Math.round(cpu.system / 1000),
      },
      counts: { parties: activeParties, users: onlineUsers, songs, votes },
      activeSockets,
    });
  } catch (err) {
    Logger.error('admin', `ANALYTICS error: ${err.message}`, err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

router.get('/analytics/history', requireAdmin, async (req, res) => {
  try {
    const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 720); // 1h to 30d
    const rows = query(
      `SELECT snapshot_id, recorded_at, active_parties, online_users, total_songs, total_votes, active_sockets, heap_used_mb, rss_mb
       FROM analytics_snapshots
       WHERE recorded_at >= datetime('now', '-' || ? || ' hours')
       ORDER BY recorded_at ASC`,
      [hours]
    );

    // Compute summary stats
    let peakSockets = 0,
      peakMemory = 0,
      peakUsers = 0;
    for (const r of rows) {
      if (r.active_sockets > peakSockets) peakSockets = r.active_sockets;
      if (r.heap_used_mb > peakMemory) peakMemory = r.heap_used_mb;
      if (r.online_users > peakUsers) peakUsers = r.online_users;
    }

    res.json({
      hours,
      count: rows.length,
      snapshots: rows,
      peaks: { sockets: peakSockets, memoryMB: peakMemory, users: peakUsers },
    });
  } catch (err) {
    Logger.error('admin', `ANALYTICS HISTORY error: ${err.message}`, err);
    res.status(500).json({ error: 'Failed to fetch analytics history' });
  }
});

/* ================= SYSTEM SETTINGS ================= */
router.get('/playback-mode', requireAdmin, async (req, res) => {
  try {
    const mode = await getGlobalPlaybackMode();
    res.json({ mode: mode || 'api' });
  } catch (err) {
    Logger.error('admin', `GET /playback-mode error: ${err.message}`, err);
    res.status(500).json({ error: 'Failed to fetch playback mode' });
  }
});

router.post('/playback-mode', requireAdmin, async (req, res) => {
  try {
    const { mode } = req.body;
    if (mode !== 'api' && mode !== 'stream') {
      return res.status(400).json({ error: 'Mode must be api or stream' });
    }

    await setGlobalPlaybackMode(mode);
    const io = req.app.get('io');
    if (io) {
      io.emit('playbackModeChanged', { mode });
    }

    res.json({ message: `Playback mode set to ${mode}`, mode });
  } catch (err) {
    Logger.error('admin', `POST /playback-mode error: ${err.message}`, err);
    res.status(500).json({ error: 'Failed to update playback mode' });
  }
});

/* ================= DATABASE INSPECTION ================= */
router.get('/db/tables', requireAdmin, async (_req, res) => {
  try {
    const rows = [];
    for (const tableName of ADMIN_DB_TABLES) {
      const countResult = await query(`SELECT COUNT(*) AS count FROM ${tableName}`);
      rows.push({ table: tableName, count: countResult?.[0]?.count || 0 });
    }

    return res.json({ tables: rows });
  } catch (err) {
    Logger.error('admin', `GET /db/tables error: ${err.message}`, err);
    return res.status(500).json({ error: 'Failed to fetch database tables' });
  }
});

router.get('/db/tables/:tableName', requireAdmin, async (req, res) => {
  try {
    const tableName = normalizeTableName(req.params.tableName);
    if (!isAllowedAdminTable(tableName)) {
      return res.status(400).json({ error: 'Invalid table name' });
    }

    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const parsedOffset = Number.parseInt(req.query.offset, 10);
    const limit = Number.isNaN(parsedLimit) ? 50 : Math.min(Math.max(parsedLimit, 1), 500);
    const offset = Number.isNaN(parsedOffset) ? 0 : Math.max(parsedOffset, 0);
    const rawSearch = String(req.query.q || '').trim();
    const sortBy = String(req.query.sortBy || '').trim();
    const sortDir =
      String(req.query.sortDir || '')
        .trim()
        .toLowerCase() === 'asc'
        ? 'ASC'
        : 'DESC';
    const rowPrimaryKey = getAdminRowDeleteKey(tableName);
    const tableColumns = await query(`PRAGMA table_info(${tableName})`);
    const availableColumns = tableColumns.map((row) => row.name).filter(Boolean);

    if (!availableColumns.length) {
      return res.status(500).json({ error: 'Unable to inspect table columns' });
    }

    let whereClause = '';
    let whereParams = [];
    let searchableColumns = [];

    if (rawSearch) {
      searchableColumns = [...availableColumns];

      const escapedSearch = escapeLikePattern(rawSearch);
      const likeValue = `%${escapedSearch}%`;
      const conditions = searchableColumns.map(
        (colName) => `CAST(${colName} AS TEXT) LIKE ? ESCAPE '\\'`
      );
      whereClause = ` WHERE ${conditions.join(' OR ')}`;
      whereParams = searchableColumns.map(() => likeValue);
    }

    const requestedSortColumn =
      sortBy && availableColumns.includes(sortBy)
        ? sortBy
        : rowPrimaryKey && availableColumns.includes(rowPrimaryKey)
          ? rowPrimaryKey
          : availableColumns[0];
    const orderBy = `${requestedSortColumn} ${sortDir}`;
    const rows = await query(
      `SELECT * FROM ${tableName}${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...whereParams, limit, offset]
    );
    const totalResult = await query(
      `SELECT COUNT(*) AS count FROM ${tableName}${whereClause}`,
      whereParams
    );
    const total = totalResult?.[0]?.count || 0;

    return res.json({
      table: tableName,
      rows,
      rowPrimaryKey,
      canDeleteRows: Boolean(rowPrimaryKey),
      search: {
        query: rawSearch,
        searchableColumns,
      },
      sort: {
        by: requestedSortColumn,
        dir: sortDir.toLowerCase(),
        availableColumns,
      },
      pagination: {
        limit,
        offset,
        total,
      },
    });
  } catch (err) {
    Logger.error('admin', `GET /db/tables/${req.params.tableName} error: ${err.message}`, err);
    return res.status(500).json({ error: 'Failed to fetch table rows' });
  }
});

router.delete('/db/tables/:tableName', requireAdmin, async (req, res) => {
  try {
    const tableName = normalizeTableName(req.params.tableName);
    if (!isAllowedAdminTable(tableName)) {
      return res.status(400).json({ error: 'Invalid table name' });
    }

    const confirm = String(req.query.confirm || '')
      .trim()
      .toUpperCase();
    if (confirm !== 'YES_CLEAR_TABLE') {
      return res.status(400).json({ error: 'Confirmation required: add ?confirm=YES_CLEAR_TABLE' });
    }

    if (tableName === 'parties') {
      const io = req.app.get('io');
      const activeParties = await query('SELECT party_code FROM parties WHERE status = ?', [
        'active',
      ]);
      for (const row of activeParties) {
        const partyCode = normalizePartyCode(row.party_code);
        await endParty(io, partyCode, 'admin-clear-parties-table');
      }
    }

    const result = await query(`DELETE FROM ${tableName}`);
    return res.json({
      message: `Cleared table ${tableName}`,
      table: tableName,
      deletedRows: result?.changes || 0,
    });
  } catch (err) {
    Logger.error('admin', `DELETE /db/tables/${req.params.tableName} error: ${err.message}`, err);
    return res.status(500).json({ error: 'Failed to clear table' });
  }
});

router.delete('/db/tables/:tableName/rows/:rowId', requireAdmin, async (req, res) => {
  try {
    const tableName = normalizeTableName(req.params.tableName);
    if (!isAllowedAdminTable(tableName)) {
      return res.status(400).json({ error: 'Invalid table name' });
    }

    const rowPrimaryKey = getAdminRowDeleteKey(tableName);
    if (!rowPrimaryKey) {
      return res.status(400).json({ error: 'Row delete is not allowed for this table' });
    }

    const rowId = Number.parseInt(req.params.rowId, 10);
    if (!Number.isInteger(rowId) || rowId <= 0) {
      return res.status(400).json({ error: 'Invalid rowId' });
    }

    const confirm = String(req.query.confirm || '')
      .trim()
      .toUpperCase();
    if (confirm !== 'YES_DELETE_ROW') {
      return res.status(400).json({ error: 'Confirmation required: add ?confirm=YES_DELETE_ROW' });
    }

    const existing = await query(
      `SELECT ${rowPrimaryKey} FROM ${tableName} WHERE ${rowPrimaryKey} = ? LIMIT 1`,
      [rowId]
    );
    if (!existing.length) {
      return res.status(404).json({ error: 'Row not found' });
    }

    const result = await query(`DELETE FROM ${tableName} WHERE ${rowPrimaryKey} = ?`, [rowId]);
    return res.json({
      message: `Deleted row ${rowId} from ${tableName}`,
      table: tableName,
      rowId,
      deletedRows: result?.changes || 0,
    });
  } catch (err) {
    Logger.error(
      'admin',
      `DELETE /db/tables/${req.params.tableName}/rows/${req.params.rowId} error: ${err.message}`,
      err
    );
    return res.status(500).json({ error: 'Failed to delete row' });
  }
});

module.exports = router;
