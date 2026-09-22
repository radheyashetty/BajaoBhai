const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidVideoId, isValidPartyCode, sanitizeString } = require('../server/utils/validators');

test('Validators: isValidVideoId', async (t) => {
  await t.test('accepts valid 11-char YouTube video IDs', () => {
    assert.equal(isValidVideoId('dQw4w9WgXcQ'), true);
    assert.equal(isValidVideoId('hoA4WMUFDCQ'), true);
    assert.equal(isValidVideoId('a_B-1234567'), true);
  });

  await t.test('rejects empty or non-string video IDs', () => {
    assert.equal(isValidVideoId(''), false);
    assert.equal(isValidVideoId(null), false);
    assert.equal(isValidVideoId(undefined), false);
    assert.equal(isValidVideoId(12345), false);
  });

  await t.test('rejects command injection or malformed strings', () => {
    assert.equal(isValidVideoId('dQw4w9WgXcQ; rm -rf /'), false);
    assert.equal(isValidVideoId('--dump-json'), false);
    assert.equal(isValidVideoId('vid<script>'), false);
    assert.equal(isValidVideoId('too_short'), false);
    assert.equal(isValidVideoId('way_too_long_video_identifier_123456789'), false);
  });
});

test('Validators: isValidPartyCode', async (t) => {
  await t.test('accepts valid 6-character alphanumeric codes', () => {
    assert.equal(isValidPartyCode('ABC123'), true);
    assert.equal(isValidPartyCode('XYZ999'), true);
    assert.equal(isValidPartyCode('6H7K9L'), true);
  });

  await t.test('rejects codes of wrong length or invalid characters', () => {
    assert.equal(isValidPartyCode(''), false);
    assert.equal(isValidPartyCode('ABC12'), false);
    assert.equal(isValidPartyCode('ABC1234'), false);
    assert.equal(isValidPartyCode('ABC-12'), false);
    assert.equal(isValidPartyCode('ABC!23'), false);
  });
});

test('Validators: sanitizeString', async (t) => {
  await t.test('strips HTML tags and trims whitespace', () => {
    assert.equal(sanitizeString('  <b>Hello</b>  '), 'Hello');
    assert.equal(sanitizeString('<script>alert(1)</script>Title'), 'Title');
  });

  await t.test('truncates to specified max length', () => {
    const longStr = 'a'.repeat(300);
    assert.equal(sanitizeString(longStr, 50).length, 50);
  });

  await t.test('handles null and undefined gracefully', () => {
    assert.equal(sanitizeString(null), '');
    assert.equal(sanitizeString(undefined), '');
  });
});
