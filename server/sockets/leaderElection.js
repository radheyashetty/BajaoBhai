const { query } = require('../db');
const { emitPartyUserListIfChanged } = require('./userListBroadcast');
const { redis, isRedisReady } = require('../utils/redisClient');
const { endParty } = require('../utils/partyCleanup');
const Logger = require('../utils/logger');

// track pending host election timeouts by party
const electionTimers = new Map();
const noUsersEndTimers = new Map();
const ELECTION_LOCK_MS = 5000;
const HOST_RECONNECT_GRACE_MS = Math.max(
  2500,
  Number(process.env.BB_HOST_RECONNECT_GRACE_MS || 15000)
);
const NO_USERS_END_GRACE_MS = Math.max(
  HOST_RECONNECT_GRACE_MS,
  Number(process.env.BB_NO_USERS_END_GRACE_MS || 120000)
);

function electionKey(partyCode) {
  return `election:${String(partyCode || '').toUpperCase()}`;
}

async function tryAcquireElectionLock(partyCode, owner) {
  if (!isRedisReady()) return true;
  try {
    const result = await redis.set(
      electionKey(partyCode),
      String(owner || process.pid),
      'PX',
      ELECTION_LOCK_MS,
      'NX'
    );
    return result === 'OK';
  } catch (err) {
    Logger.warn('socket:leader', `leaderElection lock fallback: ${err.message}`);
    return true;
  }
}

async function releaseElectionLock(partyCode) {
  if (!isRedisReady()) return;
  try {
    await redis.del(electionKey(partyCode));
  } catch (err) {
    Logger.warn('socket:leader', `leaderElection unlock failed: ${err.message}`);
  }
}

function cancelNoUsersEndTimer(partyCode) {
  if (!partyCode) return;
  if (noUsersEndTimers.has(partyCode)) {
    clearTimeout(noUsersEndTimers.get(partyCode));
    noUsersEndTimers.delete(partyCode);
    Logger.info('socket:leader', `cancelNoUsersEndTimer party=${partyCode}`);
  }
}

function scheduleNoUsersEndTimer(io, partyCode) {
  if (!partyCode) return;
  cancelNoUsersEndTimer(partyCode);

  const timerId = setTimeout(async () => {
    try {
      const online = await query(
        'SELECT COUNT(*) AS cnt FROM users WHERE party_code = ? AND is_online = 1',
        [partyCode]
      );
      const onlineCount = Number(online?.[0]?.cnt || 0);
      onlineCount > 0
        ? Logger.info('socket:leader', `noUsersEnd skipped party=${partyCode} reason=users-online`)
        : null;
      if (onlineCount > 0) return;

      await endParty(io, partyCode, 'no-host-no-guests');
      Logger.info(
        'socket:leader',
        `noUsersEnd ended party=${partyCode} graceMs=${NO_USERS_END_GRACE_MS}`
      );
    } catch (err) {
      Logger.error('socket:leader', 'leaderElection noUsersEndTimer error', err);
    } finally {
      noUsersEndTimers.delete(partyCode);
    }
  }, NO_USERS_END_GRACE_MS);
  timerId.unref();

  noUsersEndTimers.set(partyCode, timerId);
  Logger.info(
    'socket:leader',
    `noUsersEnd scheduled party=${partyCode} in=${NO_USERS_END_GRACE_MS}ms`
  );
}

module.exports = (io, socket) => {
  socket.on('disconnect', async () => {
    try {
      const { partyCode, userId, role } = socket.user || {};
      if (!partyCode) return;
      Logger.info(
        'socket:leader',
        `disconnect observed party=${partyCode} userId=${userId} role=${role}`
      );

      // mark offline now
      await query('UPDATE users SET is_online = 0, socket_id = NULL WHERE user_id = ?', [userId]);

      // schedule leader election with reconnect grace
      if (role === 'host') {
        if (electionTimers.has(partyCode)) {
          clearTimeout(electionTimers.get(partyCode));
        }
        const timerId = setTimeout(async () => {
          try {
            // re-check if host came back online
            const hostRow = await query(
              'SELECT user_id, socket_id FROM users WHERE party_code = ? AND role = ? AND is_online = 1 LIMIT 1',
              [partyCode, 'host']
            );
            if (hostRow && hostRow.length > 0) {
              Logger.info(
                'socket:leader',
                `election canceled party=${partyCode} reason=host-reconnected`
              );
              electionTimers.delete(partyCode);
              return;
            }

            const guests = await query(
              'SELECT user_id, username, socket_id FROM users WHERE party_code = ? AND role = ? AND is_online = 1 ORDER BY joined_at ASC LIMIT 1',
              [partyCode, 'guest']
            );
            if (guests && guests.length > 0) {
              const newHostId = guests[0].user_id;
              cancelNoUsersEndTimer(partyCode);
              await query('UPDATE users SET role = ? WHERE user_id = ?', ['host', newHostId]);
              await query('UPDATE parties SET host_user_id = ? WHERE party_code = ?', [
                newHostId,
                partyCode,
              ]);

              // Keep in-memory socket user role in sync with DB role change.
              if (guests[0].socket_id) {
                const promotedSocket = io.sockets.sockets.get(guests[0].socket_id);
                if (promotedSocket?.user) {
                  promotedSocket.user.role = 'host';
                }
              }

              io.to(partyCode).emit('hostChanged', {
                newHostId,
                newHostUsername: guests[0].username,
                reason: 'disconnect',
              });

              const users = await query(
                'SELECT user_id AS userId, username, role, avatar_color AS avatarColor FROM users WHERE party_code = ? AND is_online = 1 ORDER BY joined_at ASC',
                [partyCode]
              );
              emitPartyUserListIfChanged(io, partyCode, users);

              if (guests[0].socket_id) {
                io.to(guests[0].socket_id).emit('hostGranted', { partyCode, userId: newHostId });
              }
              Logger.info(
                'socket:leader',
                `election promoted party=${partyCode} newHostId=${newHostId}`
              );
            } else {
              // No guests online yet; keep party alive for a grace period to allow host reconnect.
              scheduleNoUsersEndTimer(io, partyCode);
              Logger.info(
                'socket:leader',
                `election pending-end party=${partyCode} reason=no-guests`
              );
            }
            electionTimers.delete(partyCode);
          } catch (err) {
            Logger.error('socket:leader', 'leaderElection delayed handler error', err);
          } finally {
            await releaseElectionLock(partyCode);
          }
        }, HOST_RECONNECT_GRACE_MS);
        timerId.unref();

        const lockOwner = `${socket.id}:${userId}`;
        const hasLock = await tryAcquireElectionLock(partyCode, lockOwner);
        if (!hasLock) {
          Logger.info('socket:leader', `election skipped party=${partyCode} reason=already-owned`);
          clearTimeout(timerId);
        } else {
          electionTimers.set(partyCode, timerId);
          Logger.info(
            'socket:leader',
            `election scheduled party=${partyCode} in=${HOST_RECONNECT_GRACE_MS}ms`
          );
        }
      }
    } catch (err) {
      Logger.error('socket:leader', 'leaderElection error', err);
    }
  });
};

function cancelElectionTimer(partyCode) {
  if (!partyCode) return;
  if (electionTimers.has(partyCode)) {
    clearTimeout(electionTimers.get(partyCode));
    electionTimers.delete(partyCode);
    Logger.info('socket:leader', `cancelElectionTimer party=${partyCode}`);
  }
}

module.exports.cancelElectionTimer = cancelElectionTimer;
module.exports.cancelNoUsersEndTimer = cancelNoUsersEndTimer;
module.exports.releaseElectionLock = releaseElectionLock;
