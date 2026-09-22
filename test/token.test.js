const test = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config();

const { sign, verify } = require('../server/utils/tokenUtils');

test('TokenUtils: sign and verify', async (t) => {
  const samplePayload = {
    userId: 42,
    partyCode: 'TEST99',
    role: 'host',
    username: 'DJ_Tester',
  };

  await t.test('signs payload and returns a valid 3-part JWT', () => {
    const token = sign(samplePayload);
    assert.equal(typeof token, 'string');
    const parts = token.split('.');
    assert.equal(parts.length, 3);
  });

  await t.test('verifies valid token and recovers payload with claims', () => {
    const token = sign(samplePayload);
    const decoded = verify(token);
    assert.ok(decoded);
    assert.equal(decoded.userId, samplePayload.userId);
    assert.equal(decoded.partyCode, samplePayload.partyCode);
    assert.equal(decoded.role, samplePayload.role);
    assert.equal(decoded.username, samplePayload.username);
    assert.ok(Number.isInteger(decoded.exp));
    assert.ok(Number.isInteger(decoded.iat));
  });

  await t.test('rejects tampered signature', () => {
    const token = sign(samplePayload);
    const [header, body, sig] = token.split('.');
    const tamperedSig = sig.slice(0, -2) + 'XX';
    const tamperedToken = `${header}.${body}.${tamperedSig}`;
    assert.equal(verify(tamperedToken), null);
  });

  await t.test('rejects tampered payload body', () => {
    const token = sign(samplePayload);
    const [header, , sig] = token.split('.');
    const fakeBody = Buffer.from(
      JSON.stringify({ ...samplePayload, role: 'host', userId: 1 })
    ).toString('base64url');
    const tamperedToken = `${header}.${fakeBody}.${sig}`;
    assert.equal(verify(tamperedToken), null);
  });

  await t.test('rejects invalid or malformed tokens', () => {
    assert.equal(verify(''), null);
    assert.equal(verify(null), null);
    assert.equal(verify('not.a.jwt.token'), null);
    assert.equal(verify('abc.def'), null);
  });
});
