require('dotenv').config();
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { io: Client } = require('socket.io-client');
const { query, runTransactionSync } = require('../server/db');
const initSocket = require('../server/sockets');
const { sign } = require('../server/utils/tokenUtils');

describe('Multi-User Distributed Party Operations', () => {
  let server;
  let io;
  let port;
  const partyCode = 'MULTI9';
  let hostId;
  let guest1Id;
  let guest2Id;
  let hostToken;
  let guest1Token;
  let guest2Token;
  let hostClient;
  let guest1Client;
  let guest2Client;

  before(async () => {
    // Setup Express & Socket.IO server on random ephemeral port
    const app = express();
    server = http.createServer(app);
    io = initSocket(server);
    app.set('io', io);

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });

    // Clean any previous test data
    runTransactionSync([
      { sql: 'UPDATE parties SET host_user_id = NULL WHERE party_code = ?', values: [partyCode] },
      { sql: 'DELETE FROM chat_messages WHERE party_code = ?', values: [partyCode] },
      { sql: 'DELETE FROM votes WHERE song_id IN (SELECT song_id FROM songs WHERE party_code = ?)', values: [partyCode] },
      { sql: 'DELETE FROM songs WHERE party_code = ?', values: [partyCode] },
      { sql: 'DELETE FROM users WHERE party_code = ?', values: [partyCode] },
      { sql: 'DELETE FROM parties WHERE party_code = ?', values: [partyCode] },
    ]);

    // Insert party
    query(
      'INSERT INTO parties (party_code, party_name, status, is_public) VALUES (?, ?, ?, ?)',
      [partyCode, 'Multi-User Test Room', 'active', 1]
    );

    // Insert Host
    const hRes = query(
      'INSERT INTO users (username, party_code, role, is_online, avatar_color) VALUES (?, ?, ?, ?, ?)',
      ['HostUser', partyCode, 'host', 1, '#6366f1']
    );
    hostId = hRes.insertId;
    query('UPDATE parties SET host_user_id = ? WHERE party_code = ?', [hostId, partyCode]);

    // Insert Guest 1
    const g1Res = query(
      'INSERT INTO users (username, party_code, role, is_online, avatar_color) VALUES (?, ?, ?, ?, ?)',
      ['GuestOne', partyCode, 'guest', 1, '#ec4899']
    );
    guest1Id = g1Res.insertId;

    // Insert Guest 2
    const g2Res = query(
      'INSERT INTO users (username, party_code, role, is_online, avatar_color) VALUES (?, ?, ?, ?, ?)',
      ['GuestTwo', partyCode, 'guest', 1, '#10b981']
    );
    guest2Id = g2Res.insertId;

    // Generate tokens
    hostToken = sign({ userId: hostId, partyCode, role: 'host', username: 'HostUser' });
    guest1Token = sign({ userId: guest1Id, partyCode, role: 'guest', username: 'GuestOne' });
    guest2Token = sign({ userId: guest2Id, partyCode, role: 'guest', username: 'GuestTwo' });
  });

  after(async () => {
    if (hostClient?.connected) hostClient.disconnect();
    if (guest1Client?.connected) guest1Client.disconnect();
    if (guest2Client?.connected) guest2Client.disconnect();

    const { cancelElectionTimer, cancelNoUsersEndTimer } = require('../server/sockets/leaderElection');
    if (typeof cancelElectionTimer === 'function') cancelElectionTimer(partyCode);
    if (typeof cancelNoUsersEndTimer === 'function') cancelNoUsersEndTimer(partyCode);

    const { clearSafetyTimer } = require('../server/sockets/queueHandler');
    if (typeof clearSafetyTimer === 'function') clearSafetyTimer(partyCode);

    await new Promise((resolve) => {
      io.close(() => {
        server.close(resolve);
      });
    });

    const { redis } = require('../server/utils/redisClient');
    if (redis && typeof redis.quit === 'function') {
      try {
        await redis.quit();
      } catch {}
    }

    runTransactionSync([
      { sql: 'UPDATE parties SET host_user_id = NULL WHERE party_code = ?', values: [partyCode] },
      { sql: 'DELETE FROM chat_messages WHERE party_code = ?', values: [partyCode] },
      { sql: 'DELETE FROM votes WHERE song_id IN (SELECT song_id FROM songs WHERE party_code = ?)', values: [partyCode] },
      { sql: 'DELETE FROM songs WHERE party_code = ?', values: [partyCode] },
      { sql: 'DELETE FROM users WHERE party_code = ?', values: [partyCode] },
      { sql: 'DELETE FROM parties WHERE party_code = ?', values: [partyCode] },
    ]);
  });

  test('Multiple clients connect and establish synchronized presence', async () => {
    const serverUrl = `http://127.0.0.1:${port}`;

    // Connect Host
    hostClient = Client(serverUrl, {
      auth: { token: hostToken },
      transports: ['websocket'],
    });

    // Connect Guest 1
    guest1Client = Client(serverUrl, {
      auth: { token: guest1Token },
      transports: ['websocket'],
    });

    // Connect Guest 2
    guest2Client = Client(serverUrl, {
      auth: { token: guest2Token },
      transports: ['websocket'],
    });

    // Wait for all 3 to connect
    await Promise.all([
      new Promise((res) => hostClient.on('connect', res)),
      new Promise((res) => guest1Client.on('connect', res)),
      new Promise((res) => guest2Client.on('connect', res)),
    ]);

    assert.equal(hostClient.connected, true);
    assert.equal(guest1Client.connected, true);
    assert.equal(guest2Client.connected, true);

    // Wait a brief moment for user list broadcasts
    await new Promise((res) => setTimeout(res, 200));

    // Verify online presence in database
    const onlineUsers = query(
      'SELECT username, role, is_online FROM users WHERE party_code = ? AND is_online = 1 ORDER BY joined_at ASC',
      [partyCode]
    );
    assert.equal(onlineUsers.length, 3);
    assert.equal(onlineUsers[0].username, 'HostUser');
    assert.equal(onlineUsers[0].role, 'host');
    assert.equal(onlineUsers[1].username, 'GuestOne');
    assert.equal(onlineUsers[2].username, 'GuestTwo');
  });

  test('Multi-user real-time collaborative voting dynamically reorders queue for all users', async () => {
    // 1. Insert two songs in queue
    const song1Res = query(
      'INSERT INTO songs (party_code, video_id, title, duration_seconds, added_by, status) VALUES (?, ?, ?, ?, ?, ?)',
      [partyCode, 'video_song_1', 'Alpha Song', 180, hostId, 'queued']
    );
    const song1Id = song1Res.insertId;

    const song2Res = query(
      'INSERT INTO songs (party_code, video_id, title, duration_seconds, added_by, status) VALUES (?, ?, ?, ?, ?, ?)',
      [partyCode, 'video_song_2', 'Beta Song', 200, guest1Id, 'queued']
    );
    const song2Id = song2Res.insertId;

    // Setup listener on hostClient for queueUpdate
    const queueUpdatePromise = new Promise((resolve) => {
      hostClient.on('queueUpdate', (data) => {
        const target = data.songs?.find((s) => s.song_id === song2Id);
        if (target && Number(target.net_score) === 2) {
          resolve(data.songs);
        }
      });
    });

    // Guest 1 upvotes Song 2
    guest1Client.emit('voteSong', { songId: song2Id, voteType: 'up' });

    // Guest 2 upvotes Song 2
    guest2Client.emit('voteSong', { songId: song2Id, voteType: 'up' });

    const updatedQueue = await queueUpdatePromise;
    // Beta Song should now be at position 0 with net_score = 2
    assert.equal(updatedQueue[0].song_id, song2Id);
    assert.equal(updatedQueue[0].title, 'Beta Song');
    assert.equal(Number(updatedQueue[0].net_score), 2);

    // Alpha Song should be at position 1 with net_score = 0
    assert.equal(updatedQueue[1].song_id, song1Id);
    assert.equal(Number(updatedQueue[1].net_score), 0);
  });

  test('Host playback controls broadcast accurately to all connected guests', async () => {
    const guest1PlaybackPromise = new Promise((resolve) => {
      guest1Client.on('playbackControl', (payload) => {
        if (payload.action === 'play') resolve(payload);
      });
    });

    const guest2PlaybackPromise = new Promise((resolve) => {
      guest2Client.on('playbackControl', (payload) => {
        if (payload.action === 'play') resolve(payload);
      });
    });

    // Host sends play instruction at position 32.5 seconds
    hostClient.emit('hostPlaybackControl', {
      action: 'play',
      position: 32.5,
    });

    const [g1Payload, g2Payload] = await Promise.all([guest1PlaybackPromise, guest2PlaybackPromise]);
    assert.equal(g1Payload.action, 'play');
    assert.equal(g1Payload.position, 32.5);
    assert.equal(g2Payload.action, 'play');
    assert.equal(g2Payload.position, 32.5);
  });

  test('Multi-user room chat broadcasts messages across participants', async () => {
    const hostChatPromise = new Promise((resolve) => {
      hostClient.on('chatMessage', (msg) => {
        if (msg.message === 'Hello from GuestTwo!') resolve(msg);
      });
    });

    const guest1ChatPromise = new Promise((resolve) => {
      guest1Client.on('chatMessage', (msg) => {
        if (msg.message === 'Hello from GuestTwo!') resolve(msg);
      });
    });

    // Guest 2 sends a message
    guest2Client.emit('sendChatMessage', { message: 'Hello from GuestTwo!' });

    const [hostMsg, g1Msg] = await Promise.all([hostChatPromise, guest1ChatPromise]);
    assert.equal(hostMsg.username, 'GuestTwo');
    assert.equal(hostMsg.message, 'Hello from GuestTwo!');
    assert.equal(g1Msg.username, 'GuestTwo');
  });

  test('Host handover seamlessly transfers authority to active guest', async () => {
    const hostChangedPromise = new Promise((resolve) => {
      guest2Client.on('hostChanged', (payload) => {
        resolve(payload);
      });
    });

    // Host relinquishes role
    hostClient.emit('relinquishHost');

    const handover = await hostChangedPromise;
    assert.equal(handover.newHostId, guest1Id);
    assert.equal(handover.newHostUsername, 'GuestOne');
    assert.equal(handover.reason, 'host-relinquish');

    // Verify in database that Guest 1 is now host and previous host is guest
    const dbHost = query('SELECT host_user_id FROM parties WHERE party_code = ?', [partyCode]);
    assert.equal(dbHost[0].host_user_id, guest1Id);

    const g1Role = query('SELECT role FROM users WHERE user_id = ?', [guest1Id]);
    assert.equal(g1Role[0].role, 'host');

    const oldHostRole = query('SELECT role FROM users WHERE user_id = ?', [hostId]);
    assert.equal(oldHostRole[0].role, 'guest');
  });
});
