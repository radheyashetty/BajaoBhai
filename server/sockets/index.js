const { Server } = require('socket.io');
const tokenUtils = require('../utils/tokenUtils');
const queueHandler = require('./queueHandler');
const leaderElection = require('./leaderElection');
const chatHandler = require('./chatHandler');
const { emitPartyUserListIfChanged, clearPartyUserListCache } = require('./userListBroadcast');
const { query } = require('../db');
const { getGlobalPlaybackMode } = require('../utils/redisClient');
const Logger = require('../utils/logger');

const partyUsers = {};

function summarizeSocketPayload(payload) {
  if (payload == null) return String(payload);
  if (typeof payload === 'string') return payload.slice(0, 80);
  if (typeof payload !== 'object') return String(payload);
  const keys = Object.keys(payload);
  return `{keys:${keys.slice(0, 8).join(',')}}`;
}

function ensurePartyUsersMap(partyCode) {
  if (!partyUsers[partyCode]) {
    partyUsers[partyCode] = new Map();
  }
  return partyUsers[partyCode];
}

async function broadcastPartyUsers(io, partyCode) {
  if (!partyCode) return;
  try {
    // Always use DB as source of truth for user list broadcasts.
    // The in-memory partyUsers map is only for local connection tracking.
    const users = await query(
      'SELECT user_id AS userId, username, role, avatar_color AS avatarColor FROM users WHERE party_code = ? AND is_online = 1 ORDER BY joined_at ASC',
      [partyCode]
    );
    emitPartyUserListIfChanged(io, partyCode, users);
  } catch (err) {
    Logger.error('socket', 'broadcastPartyUsers DB fallback error', err);
    // Fallback to in-memory if DB fails
    if (partyUsers[partyCode]) {
      const users = Array.from(partyUsers[partyCode].values());
      emitPartyUserListIfChanged(io, partyCode, users);
    }
  }
}

function initSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
    allowEIO3: true,
    transports: ['polling', 'websocket'],
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      Logger.info(
        'socket-auth',
        `handshake socketId=${socket.id} tokenLength=${token?.length || 0}`
      );
      const payload = tokenUtils.verify(token);
      if (!payload) {
        Logger.warn('socket-auth', `invalid token socketId=${socket.id}`);
        return next(new Error('auth_failed: token_invalid'));
      }

      Logger.info('socket-auth', `token valid userId=${payload.userId}`);
      const rows = await query(
        `SELECT u.user_id, u.username, u.party_code, u.role, u.avatar_color, p.status AS party_status
         FROM users u
         LEFT JOIN parties p ON p.party_code = u.party_code
         WHERE u.user_id = ?
         LIMIT 1`,
        [payload.userId]
      );

      const dbUser = rows?.[0];
      Logger.info(
        'socket-auth',
        `db lookup result for userId=${payload.userId}: ${JSON.stringify(dbUser || 'null')}`
      );

      if (!dbUser || !dbUser.user_id) {
        Logger.warn('socket-auth', `user missing socketId=${socket.id} userId=${payload.userId}`);
        return next(new Error('auth_failed: user_not_found'));
      }

      const partyStatus = String(dbUser.party_status || '').toLowerCase();
      if (partyStatus !== 'active') {
        Logger.warn(
          'socket-auth',
          `party invalid socketId=${socket.id} userId=${dbUser.user_id} party=${dbUser.party_code} status=${partyStatus}`
        );
        return next(new Error('auth_failed: party_inactive'));
      }

      socket.user = {
        ...payload,
        userId: Number(dbUser.user_id),
        username: dbUser.username,
        partyCode: dbUser.party_code,
        role: dbUser.role,
        avatarColor: dbUser.avatar_color,
      };

      await query('UPDATE users SET socket_id = ?, is_online = 1 WHERE user_id = ?', [
        socket.id,
        dbUser.user_id,
      ]);

      Logger.info(
        'socket-auth',
        `success socketId=${socket.id} userId=${dbUser.user_id} role=${dbUser.role} party=${dbUser.party_code}`
      );
      next();
    } catch (e) {
      Logger.error(
        'socket-auth',
        `critical middleware failure socketId=${socket.id} error=${e.message}`,
        e
      );
      next(new Error(`auth_failed: ${e.message}`));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.user || {};
    const partyCode = user.partyCode || user.party_code;
    const userId = Number(user.userId || user.user_id || 0);
    const username = user.username || 'unknown';
    const role = user.role || 'guest';
    Logger.info(
      'socket',
      `connected socketId=${socket.id} user=${user.username} party=${partyCode}`
    );

    if (partyCode) {
      socket.join(partyCode);

      if (typeof leaderElection.cancelNoUsersEndTimer === 'function') {
        leaderElection.cancelNoUsersEndTimer(partyCode);
      }

      const usersMap = ensurePartyUsersMap(partyCode);
      usersMap.set(userId, {
        userId,
        username,
        role,
        avatarColor: socket.user.avatarColor,
      });
      broadcastPartyUsers(io, partyCode);

      // Async send playback mode on connection
      getGlobalPlaybackMode()
        .then((mode) => {
          socket.emit('playbackModeChanged', { mode });
        })
        .catch(() => {});

      // Proactively sync current playback state + queue to late-joiner
      // This fires server-side on connect so the client doesn't need to ask.
      (async () => {
        try {
          // Use lazy access to avoid circular require issues
          const {
            emitCurrentNowPlayingToSocket,
            emitQueueUpdateToSocket,
          } = require('./queueHandler');
          if (typeof emitCurrentNowPlayingToSocket === 'function') {
            await emitCurrentNowPlayingToSocket(socket, partyCode);
          }
          if (typeof emitQueueUpdateToSocket === 'function') {
            await emitQueueUpdateToSocket(socket, partyCode);
          }
        } catch (err) {
          Logger.error('socket', `auto-sync on connect failed userId=${userId}: ${err.message}`);
        }
      })();
    }

    socket.onAny((eventName, ...args) => {
      const summary = args.map(summarizeSocketPayload).join(' | ');
      Logger.info(
        'socket-in',
        `event=${eventName} socketId=${socket.id} userId=${userId} role=${role} party=${partyCode} payload=${summary}`
      );
    });

    if (typeof socket.onAnyOutgoing === 'function') {
      socket.onAnyOutgoing((eventName, ...args) => {
        const summary = args.map(summarizeSocketPayload).join(' | ');
        Logger.info(
          'socket-out',
          `event=${eventName} socketId=${socket.id} userId=${userId} role=${role} party=${partyCode} payload=${summary}`
        );
      });
    }

    // attach handlers
    queueHandler(io, socket);
    leaderElection(io, socket);
    chatHandler(io, socket);

    socket.on('disconnect', (reason) => {
      Logger.info(
        'socket',
        `disconnected id=${socket.id} userId=${userId} username=${username} role=${role} party=${partyCode} reason=${reason}`
      );

      if (partyCode && partyUsers[partyCode]) {
        partyUsers[partyCode].delete(userId);

        if (partyUsers[partyCode].size === 0) {
          delete partyUsers[partyCode];
          clearPartyUserListCache(partyCode);
        }
      }

      // Use DB-backed broadcast (async fire-and-forget)
      if (partyCode) {
        broadcastPartyUsers(io, partyCode);
      }
    });
  });

  // Low-level engine logging for diagnosing handshake failures
  io.engine.on('connection_error', (err) => {
    Logger.error(
      'socket:engine',
      `Engine connection error: ${err.req?._query?.sid || 'no-sid'} code=${err.code} message=${err.message}`,
      err
    );
  });

  const VERBOSE_ENGINE_LOGS = process.env.BB_VERBOSE_ENGINE_LOGS === '1';

  io.engine.on('headers', (headers, req) => {
    if (VERBOSE_ENGINE_LOGS) {
      Logger.info('socket:engine', `Engine handshake starting: ${req.url}`);
    }
  });

  return io;
}

module.exports = initSocket;
