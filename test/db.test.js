const test = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();

const { query, initSchema, runTransactionSync } = require('../server/db');

function uniqueCode() {
  return 'T' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

test('Database Layer: Schema, Migrations, and Constraints', async (t) => {
  await initSchema();

  await t.test('initializes schema successfully', async () => {
    const tables = query("SELECT name FROM sqlite_master WHERE type='table'");
    const tableNames = tables.map((tbl) => tbl.name);
    assert.ok(tableNames.includes('parties'), 'parties table should exist');
    assert.ok(tableNames.includes('users'), 'users table should exist');
    assert.ok(tableNames.includes('songs'), 'songs table should exist');
    assert.ok(tableNames.includes('votes'), 'votes table should exist');
    assert.ok(tableNames.includes('skip_votes'), 'skip_votes table should exist');
    assert.ok(tableNames.includes('chat_messages'), 'chat_messages table should exist');
    assert.ok(tableNames.includes('audit_log'), 'audit_log table should exist');
  });

  await t.test('enforces atomic transaction commit and rollback', () => {
    // Commit test
    const partyCode = uniqueCode();
    runTransactionSync(() => {
      query('INSERT INTO parties (party_code, status) VALUES (?, ?)', [partyCode, 'active']);
      query('INSERT INTO users (username, party_code, role) VALUES (?, ?, ?)', ['HostUser', partyCode, 'host']);
    });

    const check = query('SELECT party_code FROM parties WHERE party_code = ?', [partyCode]);
    assert.equal(check.length, 1);

    // Rollback test on error
    const rollbackCode = uniqueCode();
    assert.throws(() => {
      runTransactionSync(() => {
        query('INSERT INTO parties (party_code, status) VALUES (?, ?)', [rollbackCode, 'active']);
        throw new Error('Forced rollback error');
      });
    });

    const checkRollback = query('SELECT party_code FROM parties WHERE party_code = ?', [rollbackCode]);
    assert.equal(checkRollback.length, 0, 'Rolled back party should not exist');
  });

  await t.test('prevents duplicate queued songs of same video in same party', () => {
    const partyCode = uniqueCode();
    query('INSERT INTO parties (party_code, status) VALUES (?, ?)', [partyCode, 'active']);
    const user = query('INSERT INTO users (username, party_code, role) VALUES (?, ?, ?)', ['Alice', partyCode, 'guest']);

    // First queued entry succeeds
    query(
      'INSERT INTO songs (party_code, video_id, title, status, added_by) VALUES (?, ?, ?, ?, ?)',
      [partyCode, 'vid_dup_test', 'Duplicate Test Song', 'queued', user.insertId]
    );

    // Second simultaneous queued entry for same video must fail unique constraint
    assert.throws(() => {
      query(
        'INSERT INTO songs (party_code, video_id, title, status, added_by) VALUES (?, ?, ?, ?, ?)',
        [partyCode, 'vid_dup_test', 'Duplicate Test Song Again', 'queued', user.insertId]
      );
    }, /UNIQUE constraint/);
  });

  await t.test('CRITICAL FIX: allows previously played songs to be re-queued and played without constraint error', () => {
    const partyCode = uniqueCode();
    query('INSERT INTO parties (party_code, status) VALUES (?, ?)', [partyCode, 'active']);
    const user = query('INSERT INTO users (username, party_code, role) VALUES (?, ?, ?)', ['Bob', partyCode, 'host']);
    const videoId = 'repeat_hit_vid';

    // 1. Add song first time -> queued
    const song1 = query(
      'INSERT INTO songs (party_code, video_id, title, status, added_by) VALUES (?, ?, ?, ?, ?)',
      [partyCode, videoId, 'Repeat Hit', 'queued', user.insertId]
    );

    // 2. Advance to playing
    query("UPDATE songs SET status='playing' WHERE song_id=?", [song1.insertId]);

    // 3. Song finishes -> played
    query("UPDATE songs SET status='played' WHERE song_id=?", [song1.insertId]);

    // 4. Later in the party, users queue the same hit song again -> queued
    const song2 = query(
      'INSERT INTO songs (party_code, video_id, title, status, added_by) VALUES (?, ?, ?, ?, ?)',
      [partyCode, videoId, 'Repeat Hit', 'queued', user.insertId]
    );
    assert.ok(song2.insertId > song1.insertId);

    // 5. Song plays again -> playing
    query("UPDATE songs SET status='playing' WHERE song_id=?", [song2.insertId]);

    // 6. Song finishes again -> played (This previously CRASHED due to broad UNIQUE constraint)
    assert.doesNotThrow(() => {
      query("UPDATE songs SET status='played' WHERE song_id=?", [song2.insertId]);
    });

    const playedRows = query(
      "SELECT song_id, status FROM songs WHERE party_code=? AND video_id=? AND status='played'",
      [partyCode, videoId]
    );
    assert.equal(playedRows.length, 2, 'Both plays should be successfully recorded as played');
  });
});
