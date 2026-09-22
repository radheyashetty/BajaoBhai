const test = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();

const { generatePartyCode, generateUniquePartyCode } = require('../server/utils/codeGenerator');
const { query, initSchema } = require('../server/db');

test('Party Operations & Code Generation', async (t) => {
  await initSchema();

  await t.test('generatePartyCode produces 6-character uppercase alphanumeric strings', () => {
    for (let i = 0; i < 20; i++) {
      const code = generatePartyCode();
      assert.equal(typeof code, 'string');
      assert.equal(code.length, 6);
      assert.match(code, /^[A-Z0-9]{6}$/);
    }
  });

  await t.test('generateUniquePartyCode checks database and returns unique code', async () => {
    const code1 = await generateUniquePartyCode();
    assert.equal(code1.length, 6);

    // Insert into DB
    query('INSERT INTO parties (party_code, status) VALUES (?, ?)', [code1, 'active']);

    // Next unique code should not collide with code1
    const code2 = await generateUniquePartyCode();
    assert.notEqual(code1, code2);
  });

  await t.test('sanitizes party name and username correctly', () => {
    const { sanitizeString } = require('../server/utils/validators');
    const dirtyPartyName = '  <b>Rock Party</b> <script>alert(1)</script> ';
    const cleanPartyName = sanitizeString(dirtyPartyName, 60);
    assert.equal(cleanPartyName, 'Rock Party');

    const dirtyUsername = '   <img src="x" onerror="alert(1)">DJ Cool   ';
    const cleanUsername = sanitizeString(dirtyUsername, 20);
    assert.equal(cleanUsername, 'DJ Cool');
  });
});
