const partyUserListSignatures = new Map();

function normalizeUser(user = {}) {
  const userId = Number(user.userId || user.user_id || 0);
  return {
    userId,
    username: String(user.username || ''),
    role: String(user.role || 'guest'),
    avatarColor: String(user.avatarColor || user.avatar_color || ''),
  };
}

function buildSignature(users = []) {
  const normalized = users.map(normalizeUser).sort((a, b) => a.userId - b.userId);
  return JSON.stringify(normalized);
}

function emitPartyUserListIfChanged(io, partyCode, users = []) {
  if (!io || !partyCode) return false;

  const normalized = users.map(normalizeUser);
  const signature = buildSignature(normalized);
  const previous = partyUserListSignatures.get(partyCode);

  if (signature === previous) {
    return false;
  }

  partyUserListSignatures.set(partyCode, signature);
  io.to(partyCode).emit('userList', { users: normalized });
  return true;
}

function clearPartyUserListCache(partyCode) {
  if (!partyCode) return;
  partyUserListSignatures.delete(partyCode);
}

module.exports = {
  emitPartyUserListIfChanged,
  clearPartyUserListCache,
};
