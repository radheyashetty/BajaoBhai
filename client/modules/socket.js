import { state } from './state.js';
import { DOM } from './dom.js';
import { 
  updateConnectionStatus, 
  renderQueue, 
  renderUsers, 
  updatePlayIcon, 
  updateHostControlsVisibility, 
  renderChatMessage,
  renderTypingIndicator
} from './ui-render.js';
import { showToast, persistSession, isHostUser } from './utils.js';
import { loadNowPlaying, startProgress, stopProgress, syncPlayerWithCurrentSong } from './player.js';
import { Logger } from './logger.js';

function isPlayerReady() {
  // Stream mode: audioFallback element must exist
  if (state.playbackMode === 'stream' && state.audioFallback) return true;
  // API mode: YouTube player must be initialized and have loadVideoById
  if (state.player && typeof state.player.loadVideoById === 'function') return true;
  return false;
}

/* ================= SOCKET LOGIC ================= */

export function initSocket() {
  cleanupSocket();

  if (typeof io === 'undefined') {
    console.error('[socket] io is not defined! Check if socket.io.js is loaded.');
    return;
  }

  state.socket = io(window.location.origin, {
    auth: {
      token: state.session?.token,
    },
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity
  });

  state.socket.on('connect', () => {
    Logger.info('socket', `Connected with ID: ${state.socket.id}`);
    updateConnectionStatus(true);
    showToast('Connected');
    state.socket.emit('syncNowPlaying');
    state.socket.emit('syncChatHistory');
    state.socket.emit('reconnectHeartbeat');
  });

  state.socket.on('connect_error', (err) => {
    Logger.error('socket', `connect_error: ${err.message}`, err);
    updateConnectionStatus(false);

    const errMsg = String(err?.message || '').toLowerCase();
    if (errMsg.includes('unauthorized') || errMsg.includes('auth')) {
      showToast('Session expired or invalid. Please join again.');
      setTimeout(() => {
        localStorage.removeItem('bb_user');
        sessionStorage.removeItem('bb_user');
        window.location.href = '/';
      }, 800);
    } else {
      showToast(`Connection failed: ${err.message}`);
    }
  });

  state.socket.on('disconnect', () => {
    updateConnectionStatus(false);
  });

  state.socket.on('playbackModeChanged', (payload) => {
    Logger.info('socket', `playbackModeChanged: ${payload?.mode}`);
    if (payload?.mode && payload.mode !== state.playbackMode) {
      state.playbackMode = payload.mode;
      if (state.currentSong?.video_id) {
        showToast(`Switched to ${payload.mode === 'stream' ? 'Stream Mode' : 'API Mode'}`);
        syncPlayerWithCurrentSong(null, true);
      }
    }
  });

  state.socket.on('queueUpdate', (data) => {
    state.queue = data?.songs || [];
    renderQueue();
  });

  state.socket.on('userList', (data) => {
    state.users = data?.users || [];
    renderUsers();
    // Logic from app.js syncRoleFromUsers
    syncRoleFromUsers();
  });

  state.socket.on('nowPlaying', (payload) => {
    if (!payload?.song) return;
    Logger.info('socket', `nowPlaying: ${payload.song.title} startedAt=${payload.startedAt} resumeSeconds=${payload.resumeSeconds}`);

    // If player isn't ready yet (late-joiner, player still loading), buffer the payload
    if (!isPlayerReady()) {
      Logger.info('socket', 'Player not ready yet — buffering nowPlaying for later flush');
      state.pendingNowPlaying = {
        song: payload.song,
        startedAt: payload.startedAt,
        resumeSeconds: payload.resumeSeconds,
        isPlaying: payload.isPlaying,
        receivedAt: Date.now(),
      };
      // Also update state so progress UI works immediately
      state.currentSong = payload.song;
      state.currentStartedAt = Number(payload.startedAt) || Date.now();
      state.currentIsPlaying = payload.isPlaying !== false;
      if (DOM.nowPlayingTitle) DOM.nowPlayingTitle.textContent = payload.song.title || 'No song';
      if (DOM.nowPlayingThumb && payload.song.thumbnail) {
        DOM.nowPlayingThumb.src = payload.song.thumbnail;
        DOM.nowPlayingThumb.alt = payload.song.title || 'Song thumbnail';
      }
      return;
    }

    loadNowPlaying(payload.song, payload.startedAt, payload.resumeSeconds, payload.isPlaying);
    if (payload.isPlaying !== false) {
      startProgress();
    }
  });

  state.socket.on('playbackControl', (payload) => {
    if (!payload) return;

    const normalizedAction = String(payload.action || '').toLowerCase();
    if (normalizedAction === 'play' && !state.currentSong?.song_id) {
      state.socket.emit('syncNowPlaying');
      return;
    }

    if (normalizedAction === 'stop') {
      stopProgress();
      if (state.player?.stopVideo) {
        state.player.stopVideo();
      } else if (state.player?.pauseVideo) {
        state.player.pauseVideo();
      }
      // Also stop the HTML5 audio element for stream mode
      if (state.audioFallback) {
        state.audioFallback.pause();
        state.audioFallback.removeAttribute('src');
        state.audioFallback.load();
      }
      state.currentSong = null;
      state.currentStartedAt = null;
      state.currentResumeSeconds = null;
      state.currentIsPlaying = false;
      state.isPlaying = false;
      state.queue = [];
      updatePlayIcon(false);
      if (DOM.nowPlayingTitle) {
        DOM.nowPlayingTitle.textContent = 'No song';
      }
      if (DOM.nowPlayingThumb) {
        DOM.nowPlayingThumb.removeAttribute('src');
        DOM.nowPlayingThumb.alt = 'Current song thumbnail';
      }
      if (DOM.progressBar) {
        DOM.progressBar.style.width = '0%';
      }
      if (DOM.timeDisplay) {
        DOM.timeDisplay.textContent = '0:00';
      }
      renderQueue();
      return;
    }

    const incomingSongId = Number(payload.songId);
    const currentSongId = Number(state.currentSong?.song_id);
    if (incomingSongId && currentSongId && incomingSongId !== currentSongId) {
      return;
    }

    // This handles the actual player action
    window.applyPlaybackAction(normalizedAction, payload);
  });

  state.socket.on('skipVoteUpdate', (data) => {
    if (!DOM.skipVoteRatio) return;
    const count = Number(data?.count) || 0;
    const needed = Number(data?.needed) || 0;
    DOM.skipVoteRatio.textContent = `Skip votes: ${count}/${needed}`;
    DOM.skipVoteRatio.classList.remove('d-none');

    // Notify the host so they are aware users want to skip
    if (isHostUser() && count > 0) {
      showToast(`⚠️ The crowd is restless! (${count}/${needed} skip votes)`);
    }
  });

  state.socket.on('hostGranted', () => {
    state.session = { ...state.session, role: 'host' };
    persistSession();
    updateHostControlsVisibility();
    renderQueue();
    state.socket.emit('syncNowPlaying');
    showToast('Host controls granted');
  });

  state.socket.on('hostChanged', (payload) => {
    const nextHostId = Number(payload?.newHostId);
    const isMe = Number(state.session?.userId) === nextHostId;
    state.session = { ...state.session, role: isMe ? 'host' : 'guest' };
    persistSession();
    updateHostControlsVisibility();
    renderQueue();
    if (isMe) {
      state.socket.emit('syncNowPlaying');
    }
    if (payload?.newHostUsername) {
      showToast(`Host: ${payload.newHostUsername}`);
    }
  });

  state.socket.on('reactionUpdate', (data) => {
    if (!data?.emoji) return;
    showToast(`${data.from || ''} ${data.emoji}`.trim());
  });

  state.socket.on('songAddFailed', (data) => {
    showToast(`❌ ${data?.message || 'Failed to add song'}`);
  });

  state.socket.on('actionError', (data) => {
    showToast(`❌ ${data?.message || 'Action failed'}`);
  });

  state.socket.on('partyEnded', () => {
    showToast('Party ended');
    stopProgress();
    cleanupSocket();
    setTimeout(() => {
        localStorage.removeItem('bb_user');
        sessionStorage.removeItem('bb_user');
        window.location.href = '/';
    }, 900);
  });

  state.socket.on('chatMessage', (data) => {
    Logger.info('socket', `chatMessage received: ${data?.msg_id}`);
    renderChatMessage(data);
  });

  state.socket.on('chatHistory', (data) => {
    const messages = data?.messages || [];
    Logger.info('socket', `chatHistory received: ${messages.length} msgs`);
    if (DOM.chatMessages) {
      DOM.chatMessages.innerHTML = '';
      messages.forEach(m => renderChatMessage(m));
    }
  });

  state.socket.on('chatMessageDeleted', (data) => {
    const msgId = data?.msgId;
    Logger.info('socket', `chatMessageDeleted: ${msgId}`);
    const msgEl = document.querySelector(`.chat-msg[data-msg-id="${msgId}"]`);
    if (msgEl) {
      msgEl.style.transition = 'opacity 0.3s, height 0.3s';
      msgEl.style.opacity = '0';
      setTimeout(() => msgEl.remove(), 300);
    }
  });

  state.socket.on('userTyping', (data) => {
    const username = data?.username;
    Logger.info('socket', `${username} is typing...`);
    renderTypingIndicator(username);
    // BUG 11 FIX: Auto-clear typing indicator after 3 seconds
    if (state.typingClearTimer) {
      clearTimeout(state.typingClearTimer);
    }
    state.typingClearTimer = setTimeout(() => {
      renderTypingIndicator(null);
      state.typingClearTimer = null;
    }, 3000);
  });
}

export function cleanupSocket() {
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }
}

/**
 * Flush any buffered nowPlaying event. Call this once the player is ready
 * (YT onReady or audio element created) so late-joiners get synced.
 */
export function flushPendingNowPlaying() {
  const pending = state.pendingNowPlaying;
  if (!pending?.song) return;

  Logger.info('socket', 'Flushing buffered nowPlaying payload');

  // Recalculate resumeSeconds: the original resumeSeconds was computed at
  // server send-time. Add the time the client spent waiting for the player.
  const startedAt = Number(pending.startedAt) || Date.now();
  const isPlaying = pending.isPlaying !== false;
  const durationSeconds = Number(pending.song.duration_seconds) || 0;

  let resumeSeconds;
  if (isPlaying) {
    // Song has been playing; calculate where it should be NOW
    const elapsedSinceStart = Math.max(0, (Date.now() - startedAt) / 1000);
    resumeSeconds = durationSeconds > 0
      ? Math.min(elapsedSinceStart, Math.max(durationSeconds - 1, 0))
      : elapsedSinceStart;
  } else {
    // Song is paused; use the original resumeSeconds
    resumeSeconds = Number(pending.resumeSeconds) || 0;
  }

  state.pendingNowPlaying = null;
  loadNowPlaying(pending.song, startedAt, resumeSeconds, isPlaying);
  if (isPlaying) {
    startProgress();
  }
}

function syncRoleFromUsers() {
  const myId = Number(state.session?.userId);
  if (!myId || !Array.isArray(state.users)) return;

  const me = state.users.find((u) => Number(u.userId || u.user_id) === myId);
  if (!me?.role) return;

  const nextRole = String(me.role).toLowerCase();
  const currentRole = String(state.session?.role || '').toLowerCase();

  // Update if role is missing OR if server role differs from local role
  if (nextRole && nextRole !== currentRole) {
    state.session = { ...state.session, role: nextRole };
    persistSession();
    updateHostControlsVisibility();
    renderQueue();
    if (!currentRole) {
      showToast(nextRole === 'host' ? 'You are now the host' : 'Session role restored');
    }
  }
}
