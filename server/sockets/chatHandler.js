const { query } = require('../db');
const { enforceEventLimit } = require('../utils/rateLimiter');
const xss = require('xss');
const Logger = require('../utils/logger');

function fetchChatHistory(partyCode) {
  return query(
    `
    SELECT c.msg_id, c.message, c.sent_at, u.user_id, u.username, u.avatar_color, u.role
    FROM chat_messages c
    JOIN users u ON c.user_id = u.user_id
    WHERE c.party_code = ?
    ORDER BY c.sent_at DESC
    LIMIT 50
  `,
    [partyCode]
  ).reverse(); // Return chronological
}

module.exports = function chatHandler(io, socket) {
  socket.on('syncChatHistory', async () => {
    const { partyCode } = socket.user || {};
    if (!partyCode) return;

    try {
      const history = fetchChatHistory(partyCode);
      Logger.info('socket:chat', `Syncing history for ${socket.id} (${history.length} msgs)`);
      socket.emit('chatHistory', { messages: history });
    } catch (err) {
      Logger.error('socket:chat', 'syncChatHistory error', err);
    }
  });

  socket.on('sendChatMessage', async (payload) => {
    try {
      const { partyCode, userId } = socket.user || {};
      if (!partyCode || !userId) return;

      const rateLimitError = await enforceEventLimit(socket, 'chat-input', 7, 10);
      if (rateLimitError) {
        return socket.emit('actionError', { message: rateLimitError });
      }

      const rawMessage = payload?.message;
      if (!rawMessage || typeof rawMessage !== 'string') return;

      const safeMessage = xss(rawMessage.trim().substring(0, 500));
      if (!safeMessage) return;

      // Insert into DB
      const result = query(
        'INSERT INTO chat_messages (party_code, user_id, message) VALUES (?, ?, ?)',
        [partyCode, userId, safeMessage]
      );

      // Fetch the full details to broadcast
      const inserted = query(
        `
        SELECT c.msg_id, c.message, c.sent_at, u.user_id, u.username, u.avatar_color, u.role
        FROM chat_messages c
        JOIN users u ON c.user_id = u.user_id
        WHERE c.msg_id = ?
      `,
        [result.insertId]
      )[0];

      if (inserted) {
        io.to(partyCode).emit('chatMessage', inserted);
        Logger.info('socket:chat', `Broadcasted msg from ${userId}`);
      }
    } catch (err) {
      Logger.error('socket:chat', 'sendChatMessage error', err);
      socket.emit('actionError', { message: 'Failed to send message.' });
    }
  });

  socket.on('deleteChatMessage', async (payload) => {
    const { partyCode, userId, role } = socket.user || {};
    if (!partyCode || !userId) return;

    const msgId = Number(payload?.msgId);
    if (!Number.isInteger(msgId) || msgId <= 0) return;

    // Only host can delete messages
    if (role !== 'host') {
      return socket.emit('actionError', { message: 'Only the host can delete messages.' });
    }

    try {
      const rows = query('SELECT msg_id FROM chat_messages WHERE msg_id = ? AND party_code = ?', [
        msgId,
        partyCode,
      ]);
      if (!rows.length) return;

      query('DELETE FROM chat_messages WHERE msg_id = ?', [msgId]);
      io.to(partyCode).emit('chatMessageDeleted', { msgId });
      Logger.info('socket:chat', `Deleted msg ${msgId} by ${userId}`);
    } catch (err) {
      Logger.error('socket:chat', 'deleteChatMessage error', err);
    }
  });

  socket.on('typingIndicator', () => {
    try {
      const { partyCode, username } = socket.user || {};
      if (!partyCode || !username) return;

      // Broadcast to everyone else in the room (not the sender)
      socket.to(partyCode).emit('userTyping', { username });
    } catch (err) {
      Logger.error('socket:chat', 'typingIndicator error', err);
    }
  });
};
