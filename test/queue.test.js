const test = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();

const { query, initSchema, runTransactionSync } = require('../server/db');

function uniqueCode() {
  return 'Q' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

test('Queue & Voting Logic', async (t) => {
  await initSchema();

  const partyCode = uniqueCode();
  query('INSERT INTO parties (party_code, status) VALUES (?, ?)', [partyCode, 'active']);

  const hostUser = query(
    'INSERT INTO users (username, party_code, role) VALUES (?, ?, ?)',
    ['HostAlice', partyCode, 'host']
  );
  const guestUser1 = query(
    'INSERT INTO users (username, party_code, role) VALUES (?, ?, ?)',
    ['GuestBob', partyCode, 'guest']
  );
  const guestUser2 = query(
    'INSERT INTO users (username, party_code, role) VALUES (?, ?, ?)',
    ['GuestCharlie', partyCode, 'guest']
  );

  await t.test('calculates net score properly (up=+1, down=-1) and ranks queue', () => {
    // Add two songs
    const s1 = query(
      'INSERT INTO songs (party_code, video_id, title, status, added_by) VALUES (?, ?, ?, ?, ?)',
      [partyCode, 'v1111111111', 'Song Low', 'queued', guestUser1.insertId]
    );
    const s2 = query(
      'INSERT INTO songs (party_code, video_id, title, status, added_by) VALUES (?, ?, ?, ?, ?)',
      [partyCode, 'v2222222222', 'Song High', 'queued', guestUser2.insertId]
    );

    // Guest 1 upvotes song 2
    query('INSERT INTO votes (user_id, song_id, vote_type) VALUES (?, ?, ?)', [
      guestUser1.insertId,
      s2.insertId,
      'up',
    ]);
    // Guest 2 upvotes song 2
    query('INSERT INTO votes (user_id, song_id, vote_type) VALUES (?, ?, ?)', [
      guestUser2.insertId,
      s2.insertId,
      'up',
    ]);
    // Host downvotes song 1
    query('INSERT INTO votes (user_id, song_id, vote_type) VALUES (?, ?, ?)', [
      hostUser.insertId,
      s1.insertId,
      'down',
    ]);

    const ranked = query(
      `
      SELECT s.song_id, s.title,
        COALESCE(SUM(CASE WHEN v.vote_type='up' THEN 1 WHEN v.vote_type='down' THEN -1 ELSE 0 END), 0) AS net_score
      FROM songs s
      LEFT JOIN votes v ON v.song_id = s.song_id
      WHERE s.party_code = ? AND s.status = 'queued'
      GROUP BY s.song_id
      ORDER BY net_score DESC, s.added_at ASC
    `,
      [partyCode]
    );

    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].song_id, s2.insertId);
    assert.equal(ranked[0].net_score, 2);
    assert.equal(ranked[1].song_id, s1.insertId);
    assert.equal(ranked[1].net_score, -1);
  });

  await t.test('vote toggle logic: same removes, opposite updates, new inserts', () => {
    const s3 = query(
      'INSERT INTO songs (party_code, video_id, title, status, added_by) VALUES (?, ?, ?, ?, ?)',
      [partyCode, 'v3333333333', 'Song Toggle', 'queued', hostUser.insertId]
    );

    function toggleVote(userId, songId, voteType) {
      return runTransactionSync(() => {
        const existing = query(
          'SELECT vote_type FROM votes WHERE user_id = ? AND song_id = ? LIMIT 1',
          [userId, songId]
        );

        if (existing.length > 0) {
          if (existing[0].vote_type === voteType) {
            query('DELETE FROM votes WHERE user_id = ? AND song_id = ?', [userId, songId]);
            return 'removed';
          } else {
            query('UPDATE votes SET vote_type = ? WHERE user_id = ? AND song_id = ?', [
              voteType,
              userId,
              songId,
            ]);
            return 'updated';
          }
        } else {
          query('INSERT INTO votes (user_id, song_id, vote_type) VALUES (?, ?, ?)', [
            userId,
            songId,
            voteType,
          ]);
          return 'created';
        }
      });
    }

    // 1. Initial upvote -> created
    assert.equal(toggleVote(guestUser1.insertId, s3.insertId, 'up'), 'created');
    let v = query('SELECT vote_type FROM votes WHERE user_id = ? AND song_id = ?', [
      guestUser1.insertId,
      s3.insertId,
    ]);
    assert.equal(v[0].vote_type, 'up');

    // 2. Switch to downvote -> updated
    assert.equal(toggleVote(guestUser1.insertId, s3.insertId, 'down'), 'updated');
    v = query('SELECT vote_type FROM votes WHERE user_id = ? AND song_id = ?', [
      guestUser1.insertId,
      s3.insertId,
    ]);
    assert.equal(v[0].vote_type, 'down');

    // 3. Repeat downvote -> removed (toggled off)
    assert.equal(toggleVote(guestUser1.insertId, s3.insertId, 'down'), 'removed');
    v = query('SELECT vote_type FROM votes WHERE user_id = ? AND song_id = ?', [
      guestUser1.insertId,
      s3.insertId,
    ]);
    assert.equal(v.length, 0);
  });
});
