import { state } from './modules/state.js';
import { DOM } from './modules/dom.js';
import {
  HARD_SYNC_DRIFT_SECONDS,
  SOFT_SYNC_DRIFT_SECONDS,
  SEARCH_DEBOUNCE_MS,
} from './modules/constants.js';
import { showToast, getStoredSession, isHostUser } from './modules/utils.js';
import {
  renderQueue,
  updatePlayIcon,
  updateMuteIcon,
  updateHostControlsVisibility,
  updateConnectionStatus,
} from './modules/ui-render.js';
import {
  syncPlayerWithCurrentSong,
  startProgress,
  stopProgress,
  setVolumeForCurrentUser,
} from './modules/player.js';
import { initSocket, cleanupSocket, flushPendingNowPlaying } from './modules/socket.js';

/* ================= ACTIONS ================= */

async function loadInitialQueue() {
  if (!state.partyCode) return;
  try {
    const r = await fetch(`/api/v1/queue/${encodeURIComponent(state.partyCode)}`);
    const data = await r.json();
    if (!r.ok) return;
    state.queue = data.songs || [];
    renderQueue();
  } catch {
    showToast('Failed to load queue');
  }
}

function handleVote(songId, type) {
  if (!state.socket) return;
  state.socket.emit('voteSong', { songId, voteType: type });
}

function handleSkipVote(songId) {
  if (!state.socket) return;
  state.socket.emit('skipVote', { songId });
}

function handleHostSkip(songId) {
  if (!isHostUser()) return;
  if (state.socket) {
    state.socket.emit('skipSong', { songId });
  }
}

function handleHostSkipCurrent() {
  if (!isHostUser()) return;
  if (!state.currentSong?.song_id) {
    showToast('No song playing to skip');
    return;
  }
  handleHostSkip(state.currentSong.song_id);
}

function handleRelinquishHost() {
  if (!isHostUser() || !state.socket) return;
  state.socket.emit('relinquishHost');
}

function handleReact(songId, emoji) {
  if (!state.socket) return;
  state.socket.emit('reactToSong', { songId, emoji });
}

function deleteMessage(msgId) {
  if (!isHostUser() || !state.socket) return;
  state.socket.emit('deleteChatMessage', { msgId });
}

function applyPlaybackAction(action, payload = {}) {
  const usingStream = state.playbackMode === 'stream' && state.audioFallback;
  if (!usingStream && (!state.player || !window.YT?.PlayerState)) return;
  const normalizedAction = String(action || '').toLowerCase();
  const remotePosition = Number(payload?.position);
  const hasRemotePosition = Number.isFinite(remotePosition);
  const hostTimestamp = Number(payload?.hostTimestamp) || Date.now();
  const networkDelay = Math.max(0, (Date.now() - hostTimestamp) / 1000);

  // Sync state logic
  if (normalizedAction === 'play' || normalizedAction === 'sync' || normalizedAction === 'seek') {
    const baseSeconds = hasRemotePosition
      ? Math.max(0, remotePosition)
      : Number(state.player?.getCurrentTime?.() || 0);
    const estimatedHostSeconds = baseSeconds + (normalizedAction === 'seek' ? 0 : networkDelay);
    state.currentStartedAt = Date.now() - Math.floor(Math.max(0, estimatedHostSeconds) * 1000);
    // BUG 1 FIX: Seek should also set currentIsPlaying = true (the song keeps playing during seek)
    state.currentIsPlaying = true;
    if (normalizedAction === 'seek') {
      state.currentResumeSeconds = Math.max(0, baseSeconds);
    }
  }
  if (normalizedAction === 'pause') {
    const pausedAt = hasRemotePosition
      ? Math.max(0, remotePosition)
      : Number(state.player?.getCurrentTime?.() || 0);
    state.currentStartedAt = Date.now() - Math.floor(Math.max(0, pausedAt) * 1000);
    state.currentResumeSeconds = pausedAt;
    state.currentIsPlaying = false;
  }

  // Host is source-of-truth; guests keep correcting to host timeline.
  if (
    !isHostUser() &&
    (normalizedAction === 'sync' || normalizedAction === 'play' || normalizedAction === 'seek')
  ) {
    const currentTime = usingStream
      ? Number(state.streamStartOffsetSeconds || 0) + Number(state.audioFallback?.currentTime || 0)
      : Number(state.player?.getCurrentTime?.() || 0);
    const expectedTime = hasRemotePosition
      ? Math.max(0, remotePosition + networkDelay)
      : currentTime;
    const drift = Math.abs(currentTime - expectedTime);

    if (normalizedAction === 'seek' || drift > HARD_SYNC_DRIFT_SECONDS) {
      if (usingStream) {
        // BUG 2 FIX: For stream mode, reload src AND play
        state._isReloadingStream = true;
        state.streamStartOffsetSeconds = Math.floor(expectedTime);
        state.audioFallback.src = `/api/v1/stream/${state.currentSong?.video_id}?start=${Math.floor(expectedTime)}`;
        state.audioFallback.play().catch(() => {});
        setTimeout(() => {
          state._isReloadingStream = false;
        }, 3000);
      } else {
        state.player?.seekTo?.(expectedTime, true);
      }
    } else if (normalizedAction === 'sync' && drift > SOFT_SYNC_DRIFT_SECONDS) {
      if (usingStream) {
        state.audioFallback.currentTime = expectedTime;
      } else {
        state.player?.seekTo?.(expectedTime, true);
      }
    }
  }

  if (normalizedAction === 'seek') {
    // Seek player actions are already applied:
    //  - HOST: handled locally in seek() before emitting
    //  - GUEST (stream): reloaded stream at L120-127 above
    //  - GUEST (API): seekTo at L128-129 above
    // Only update state and restart progress here.
    state.isPlaying = true;
    updatePlayIcon(true);
    startProgress();
    return;
  }

  if (normalizedAction === 'sync') return;

  if (normalizedAction === 'pause') {
    if (usingStream) {
      state.audioFallback.pause();
    } else {
      state.player?.pauseVideo?.();
    }
    state.isPlaying = false;
    updatePlayIcon(false);
    stopProgress();
    return;
  }

  if (normalizedAction === 'play') {
    if (hasRemotePosition) {
      if (usingStream) {
        // Ensure accurate resume from pause in Stream Mode, but avoid unnecessarily completely resetting the source on unpause
        // which causes buffering issues. Re-seek only if drift is large.
        const streamOffset = Number(state.streamStartOffsetSeconds || 0);
        const actualStreamTime = streamOffset + Number(state.audioFallback?.currentTime || 0);
        const drift = Math.abs(actualStreamTime - remotePosition);
        if (drift > 4) {
          state._isReloadingStream = true;
          state.streamStartOffsetSeconds = Math.floor(remotePosition);
          state.audioFallback.src = `/api/v1/stream/${state.currentSong?.video_id}?start=${Math.floor(remotePosition)}`;
          setTimeout(() => {
            state._isReloadingStream = false;
          }, 3000);
        }
      } else {
        state.player?.seekTo?.(remotePosition, true);
      }
    }
    if (usingStream) {
      if (state.audioFallback.muted) state.audioFallback.muted = false;
      state.audioFallback.play().catch(() => {
        showToast('Tap anywhere on the screen to unlock audio...');
      });
    } else {
      if (typeof state.player?.unMute === 'function') {
        state.player.unMute();
      }
      state.player?.playVideo?.();
    }
    state.isPlaying = true;
    state.currentIsPlaying = true;
    updatePlayIcon(true);
    startProgress();
  }
}

function togglePlay() {
  const usingStream = state.playbackMode === 'stream' && state.audioFallback;
  if (!usingStream && (!state.player || !window.YT?.PlayerState)) return;
  const isCurrentlyPlaying = usingStream
    ? !state.audioFallback.paused
    : state.player?.getPlayerState?.() === window.YT?.PlayerState?.PLAYING;
  if (!isHostUser()) {
    showToast('Only host can control party playback');
    return;
  }

  if (!state.currentSong?.song_id && state.socket?.connected) {
    state.socket.emit('syncNowPlaying');
  }

  const action = isCurrentlyPlaying ? 'pause' : 'play';
  applyPlaybackAction(action);

  if (state.socket?.connected) {
    // BUG 3 FIX: Always send a valid position — fallback to currentResumeSeconds or startedAt calculation
    let position;
    if (usingStream) {
      // Add stream offset: audioFallback.currentTime is relative to the byte-range start
      position =
        Number(state.streamStartOffsetSeconds || 0) + Number(state.audioFallback?.currentTime || 0);
    } else {
      position = Number(state.player?.getCurrentTime?.() || 0);
    }
    // Fallback if player didn't return a valid position
    if (!Number.isFinite(position) || position <= 0) {
      if (Number.isFinite(state.currentResumeSeconds) && state.currentResumeSeconds !== null) {
        position = state.currentResumeSeconds;
      } else if (state.currentStartedAt) {
        position = Math.max(0, (Date.now() - Number(state.currentStartedAt)) / 1000);
      } else {
        position = 0;
      }
    }
    state.socket.emit('hostPlaybackControl', {
      action,
      songId: state.currentSong?.song_id || null,
      position,
    });
  }
}

function toggleMute() {
  const usingStream = state.playbackMode === 'stream' && state.audioFallback;
  if (usingStream) {
    state.audioFallback.muted = !state.audioFallback.muted;
    updateMuteIcon(state.audioFallback.muted);
    return;
  }
  if (!state.player) return;
  if (typeof state.player.isMuted === 'function' && state.player.isMuted()) {
    state.player.unMute();
    updateMuteIcon(false);
    return;
  }

  if (typeof state.player.mute === 'function') {
    state.player.mute();
    updateMuteIcon(true);
  }
}

function seek(event) {
  const usingStream = state.playbackMode === 'stream' && state.audioFallback;
  if (!usingStream && !state.player?.getDuration) return;
  if (!isHostUser()) {
    showToast('Only host can control timeline');
    return;
  }
  const target = event.currentTarget;
  if (!target) return;

  const rect = target.getBoundingClientRect();
  const pointerClientX =
    event.clientX ?? event.touches?.[0]?.clientX ?? event.changedTouches?.[0]?.clientX;
  if (typeof pointerClientX !== 'number') return;

  const ratio = Math.min(Math.max((pointerClientX - rect.left) / rect.width, 0), 1);
  const duration = usingStream
    ? Number(state.currentSong?.duration_seconds || state.audioFallback.duration || 0)
    : state.player?.getDuration?.() || 0;
  if (!duration || duration <= 0) return;
  const nextPosition = duration * ratio;
  if (usingStream) {
    // Stream mode: reload the source at the new position since chunked streams don't support currentTime seek
    state._isReloadingStream = true;
    state.streamStartOffsetSeconds = Math.floor(nextPosition);
    state.audioFallback.src = `/api/v1/stream/${state.currentSong?.video_id}?start=${Math.floor(nextPosition)}`;
    state.audioFallback.play().catch(() => {});
    setTimeout(() => {
      state._isReloadingStream = false;
    }, 3000);
  } else {
    state.player?.seekTo?.(nextPosition, true);
  }

  // Immediately update local sync state so the progress bar reflects the new
  // position without waiting for the server broadcast roundtrip.
  state.currentStartedAt = Date.now() - Math.floor(Math.max(0, nextPosition) * 1000);
  state.currentResumeSeconds = nextPosition;
  state.currentIsPlaying = true;
  startProgress();

  if (state.socket?.connected) {
    state.socket.emit('hostPlaybackControl', {
      action: 'seek',
      songId: state.currentSong?.song_id || null,
      position: nextPosition,
    });
  }
}

function toggleSidebar() {
  const overlay = document.getElementById('sidebar-overlay');
  const isMobile = window.innerWidth < 992; // lg breakpoint

  if (isMobile && overlay) {
    const isOpen = overlay.classList.contains('active');
    if (isOpen) {
      overlay.classList.remove('active');
    } else {
      // Clone sidebar content into overlay
      const usersContainer = document.getElementById('mobile-users-container');
      const chatContainer = document.getElementById('mobile-chat-container');
      const sidebarUsers = document.querySelector('#users-sidebar .glass-panel:first-child');
      const sidebarChat = document.querySelector('#users-sidebar .glass-panel:nth-child(2)');
      if (usersContainer && sidebarUsers) usersContainer.innerHTML = sidebarUsers.innerHTML;
      if (chatContainer && sidebarChat) chatContainer.innerHTML = sidebarChat.innerHTML;
      overlay.classList.add('active');
    }
    if (DOM.toggleSidebarBtn) {
      DOM.toggleSidebarBtn.setAttribute('aria-expanded', !isOpen ? 'true' : 'false');
    }
  } else {
    // Desktop: inline toggle
    const sidebar = document.getElementById('users-sidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('d-none');
    sidebar.classList.toggle('d-lg-block');
    const isVisible = !sidebar.classList.contains('d-none');
    if (DOM.toggleSidebarBtn) {
      DOM.toggleSidebarBtn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
    }
  }
}

/* ================= SEARCH LOGIC ================= */
let debounceTimer;
let searchAbortController;
let searchRequestSeq = 0;

function clearSearchResults(resultsEl) {
  if (!resultsEl) return;
  resultsEl.innerHTML = '';
  resultsEl.classList.add('d-none');
}

function createSearchResultItem(result) {
  const item = document.createElement('div');
  item.className = 'search-result-item d-flex gap-2';
  item.setAttribute('role', 'button');
  item.setAttribute('tabindex', '0');

  const img = document.createElement('img');
  img.src = result.thumbnail || '';
  img.alt = result.title;
  img.loading = 'lazy';
  img.className = 'search-result-thumb';
  item.appendChild(img);

  const textDiv = document.createElement('div');
  textDiv.className = 'search-result-text';

  const titleEl = document.createElement('div');
  titleEl.textContent = result.title;
  titleEl.className = 'search-result-title';

  const channelEl = document.createElement('div');
  channelEl.textContent = result.channel_name || 'Unknown';
  channelEl.className = 'text-muted small search-result-channel';

  textDiv.appendChild(titleEl);
  textDiv.appendChild(channelEl);
  item.appendChild(textDiv);

  item.addEventListener('click', () => {
    addSong(
      result.videoId,
      result.title,
      result.channel_name,
      result.thumbnail,
      result.duration_seconds
    );
    clearSearchResults(DOM.searchResults);
    if (DOM.searchInput) DOM.searchInput.value = '';
  });

  return item;
}

async function handleSearch(event) {
  const query = event.target.value.trim();
  if (!query) {
    clearSearchResults(DOM.searchResults);
    return;
  }

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    if (searchAbortController) searchAbortController.abort();
    searchAbortController = new AbortController();
    searchRequestSeq++;
    const currentSeq = searchRequestSeq;

    try {
      if (DOM.searchResults) {
        DOM.searchResults.innerHTML =
          '<div class="p-3 text-muted small"><i class="fa fa-spinner fa-spin me-2"></i>Searching YouTube...</div>';
        DOM.searchResults.classList.remove('d-none');
      }

      const res = await fetch(`/api/v1/search?q=${encodeURIComponent(query)}`, {
        signal: searchAbortController.signal,
        headers: { Authorization: `Bearer ${state.session?.token || ''}` },
      });
      const data = await res.json();

      if (currentSeq !== searchRequestSeq) return;
      if (!DOM.searchResults) return;

      DOM.searchResults.innerHTML = '';
      if (!data.results || !data.results.length) {
        DOM.searchResults.innerHTML = '<div class="p-3 text-muted small">No results.</div>';
        return;
      }

      data.results.forEach((r) => DOM.searchResults.appendChild(createSearchResultItem(r)));
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('search failed:', err);
      if (DOM.searchResults) {
        DOM.searchResults.innerHTML = '<div class="p-2 text-danger small">Search failed.</div>';
      }
    }
  }, SEARCH_DEBOUNCE_MS);
}

function addSong(videoId, title, channelName, thumbnail, duration) {
  // BUG 12 FIX: Use socket emit instead of REST to avoid double queue updates
  // (the REST endpoint triggers socket events internally, causing duplicates)
  if (!state.socket?.connected) {
    showToast('❌ Not connected. Please wait...');
    return;
  }

  if (!videoId || !title) {
    showToast('❌ Invalid song data');
    return;
  }

  state.socket.emit('addSong', {
    videoId,
    title,
    channel_name: channelName || 'Unknown',
    thumbnail: thumbnail || '',
    duration_seconds: duration || 0,
  });

  showToast(`✓ Adding "${title.substring(0, 40)}..."`);
}

/* ================= CHAT LOGIC ================= */

function processChatSubmit(e) {
  e.preventDefault();
  if (!DOM.chatInput || !state.socket) return;
  const msg = DOM.chatInput.value.trim();
  if (!msg) return;

  state.socket.emit('sendChatMessage', { message: msg });
  DOM.chatInput.value = '';
  if (state.typingTimer) {
    clearTimeout(state.typingTimer);
    state.typingTimer = null;
  }
}

function emitTypingIndicator() {
  if (!state.socket) return;
  if (state.typingTimer) return;

  state.socket.emit('typingIndicator', { isTyping: true });
  state.typingTimer = setTimeout(() => {
    state.typingTimer = null;
  }, 2000);
}

/* ================= UTILS & HELPERS (PARTIAL) ================= */

function readPartyCodeFromUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  const code =
    urlParams.get('join') || urlParams.get('code') || window.location.pathname.split('/').pop();
  return code && code.length === 6 ? code.toUpperCase() : null;
}

function hasValidSessionShape(s) {
  return s && typeof s.userId !== 'undefined' && s.token;
}

function clearSessionAndGoHome() {
  localStorage.removeItem('bb_user');
  sessionStorage.removeItem('bb_user'); // Legacy cleanup
  window.location.href = '/';
}

function ensureYouTubeHostNode() {
  if (!document.getElementById('yt-player')) {
    const container = document.querySelector('.main-content');
    if (container) {
      const wrapper = document.createElement('div');
      wrapper.id = 'yt-player-wrapper';
      wrapper.className = 'yt-player-wrapper';
      wrapper.innerHTML = '<div id="yt-player"></div>';
      document.body.appendChild(wrapper);
    }
  }

  if (!document.getElementById('audio-fallback')) {
    const audio = document.createElement('audio');
    audio.id = 'audio-fallback';
    audio.className = 'audio-fallback-el';
    audio.controls = false;
    audio.playsInline = true;
    audio.setAttribute('playsinline', ''); // REQUIRED FOR IOS SAFARI AUTOPLAY
    audio.setAttribute('webkit-playsinline', '');

    // Auto-recovery for stream errors (e.g., YouTube 403 / URL expiry)
    audio.addEventListener('error', () => {
      const currentSrc = audio.src;
      if (currentSrc && state.playbackMode === 'stream') {
        setTimeout(() => {
          if (state.playbackMode !== 'stream' || audio.src !== currentSrc) return;
          state._isReloadingStream = true;
          const separator = currentSrc.includes('?') ? '&' : '?';
          audio.src = `${currentSrc.split('&__retry')[0]}${separator}__retry=${Date.now()}`;
          if (state.currentIsPlaying) audio.play().catch(() => {});
        }, 2000);
      }
    });

    audio.addEventListener('play', () => {
      state.currentIsPlaying = true;
      state.isPlaying = true;
      updatePlayIcon(true);
      startProgress();
    });

    audio.addEventListener('pause', () => {
      // BUG 8 FIX: Don't flag as paused when pause is caused by stream src reload
      // (setting .src triggers pause -> load -> play cycle, which was falsely killing sync)
      if (state._isReloadingStream) return;
      state.currentIsPlaying = false;
      state.isPlaying = false;
      updatePlayIcon(false);
    });

    audio.addEventListener('ended', () => {
      stopProgress();
      if (isHostUser() && state.socket?.connected) {
        const endedSongId = Number(state.currentSong?.song_id);
        const now = Date.now();
        const duplicateEndEvent =
          Number.isInteger(endedSongId) &&
          state.lastEndedSongId === endedSongId &&
          now - state.lastEndedAt < 2500;
        if (!duplicateEndEvent) {
          state.socket.emit('songEnded', {
            songId: Number.isInteger(endedSongId) ? endedSongId : null,
          });
          state.lastEndedSongId = Number.isInteger(endedSongId) ? endedSongId : null;
          state.lastEndedAt = now;
        }
      }
    });

    // Clear _isReloadingStream as soon as new source is playable (replaces brittle timeout)
    audio.addEventListener('canplay', () => {
      if (state._isReloadingStream) {
        state._isReloadingStream = false;
      }
    });

    document.body.appendChild(audio);
    state.audioFallback = audio;

    // Flush any nowPlaying event that arrived before audio element was ready
    flushPendingNowPlaying();
  }
}

function setupAudioUnlockOnInteraction() {
  const tryUnlock = () => {
    // 1. Force WebAudio un-muting and context unlocking on every tap
    if (state.audioFallback && state.audioFallback.muted) {
      state.audioFallback.muted = false;
    }

    // 2. If a song is actively supposed to be playing but was blocked, force a targeted execution
    if (state.currentSong?.video_id && state.currentIsPlaying) {
      if (state.playbackMode === 'stream' && state.audioFallback) {
        state.audioFallback.play().catch(() => {});
        document.removeEventListener('pointerdown', tryUnlock, true);
        document.removeEventListener('touchstart', tryUnlock, true);
        document.removeEventListener('click', tryUnlock, true);
        document.removeEventListener('keydown', tryUnlock, true);
      } else if (state.player?.playVideo) {
        if (typeof state.player.unMute === 'function') state.player.unMute();
        state.player.playVideo();
        document.removeEventListener('pointerdown', tryUnlock, true);
        document.removeEventListener('touchstart', tryUnlock, true);
        document.removeEventListener('click', tryUnlock, true);
        document.removeEventListener('keydown', tryUnlock, true);
      }
    }
  };

  document.addEventListener('pointerdown', tryUnlock, true);
  document.addEventListener('touchstart', tryUnlock, true);
  document.addEventListener('click', tryUnlock, true);
  document.addEventListener('keydown', tryUnlock, true);
}

/* ================= YOUTUBE API CALLBACK ================= */

function initYouTubePlayer() {
  ensureYouTubeHostNode();
  if (state.player || !window.YT?.Player || document.querySelector('iframe#yt-player')) return;

  state.player = new window.YT.Player('yt-player', {
    height: '300',
    width: '300',
    playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1, mute: 1, playsinline: 1 },
    events: {
      onReady: () => {
        if (typeof state.player.unMute === 'function') state.player.unMute();
        updateMuteIcon(false);
        updatePlayIcon(false);
        const savedVolume = Number(localStorage.getItem('bb_volume') || 80);
        setVolumeForCurrentUser(savedVolume);

        // Ensure the initial song metadata is handled once the player is ready
        if (state.currentSong?.video_id) {
          syncPlayerWithCurrentSong();
        }
        // Flush any nowPlaying event that arrived before YT player was ready
        flushPendingNowPlaying();
      },
      onStateChange: (e) => {
        if (!window.YT?.PlayerState) return;
        if (e.data === window.YT.PlayerState.PLAYING) {
          if (Number.isFinite(Number(state.pendingSeekSeconds))) {
            const target = Math.max(0, Number(state.pendingSeekSeconds));
            const current = Number(state.player?.getCurrentTime?.() || 0);
            if (Math.abs(current - target) > 0.75) state.player.seekTo(target, true);
            state.pendingSeekSeconds = null;
          }

          // Intercept native play from Host
          if (isHostUser() && !state.currentIsPlaying) {
            const pos = Number(state.player?.getCurrentTime?.() || 0);
            applyPlaybackAction('play', { position: pos, hostTimestamp: Date.now() });
            if (state.socket?.connected) {
              state.socket.emit('hostPlaybackControl', {
                action: 'play',
                songId: state.currentSong?.song_id || null,
                position: pos,
              });
            }
          }

          state.isPlaying = true;
          updatePlayIcon(true);
          startProgress();
        } else if (
          e.data === window.YT.PlayerState.PAUSED ||
          e.data === window.YT.PlayerState.ENDED
        ) {
          state.isPlaying = false;
          updatePlayIcon(false);

          if (e.data === window.YT.PlayerState.PAUSED) {
            stopProgress(); // Fix Progress Interval leak

            // Intercept native pause from Host
            if (isHostUser() && state.currentIsPlaying) {
              const pos = Number(state.player?.getCurrentTime?.() || 0);
              applyPlaybackAction('pause', { position: pos, hostTimestamp: Date.now() });
              if (state.socket?.connected) {
                state.socket.emit('hostPlaybackControl', {
                  action: 'pause',
                  songId: state.currentSong?.song_id || null,
                  position: pos,
                });
              }
            }
          }

          if (e.data === window.YT.PlayerState.ENDED) {
            stopProgress();
            if (isHostUser() && state.socket?.connected) {
              const endedSongId = Number(state.currentSong?.song_id);
              const now = Date.now();
              const duplicateEndEvent =
                Number.isInteger(endedSongId) &&
                state.lastEndedSongId === endedSongId &&
                now - state.lastEndedAt < 2500;
              if (!duplicateEndEvent) {
                state.socket.emit('songEnded', {
                  songId: Number.isInteger(endedSongId) ? endedSongId : null,
                });
                state.lastEndedSongId = Number.isInteger(endedSongId) ? endedSongId : null;
                state.lastEndedAt = now;
              }
            }
          }
        }
      },
    },
  });
}

window.onYouTubeIframeAPIReady = function onYouTubeIframeAPIReady() {
  initYouTubePlayer();
};

/* ================= INITIALIZATION ================= */

function initPageMeta() {
  if (DOM.navPartyCode) DOM.navPartyCode.textContent = state.partyCode || '-';
  const initial = String(state.session?.username || '?')
    .charAt(0)
    .toUpperCase();
  if (DOM.userAvatar) DOM.userAvatar.textContent = initial || '?';
}

document.addEventListener('DOMContentLoaded', async () => {
  state.session = getStoredSession();
  state.partyCode = readPartyCodeFromUrl() || String(state.session?.partyCode || '').toUpperCase();

  if (!hasValidSessionShape(state.session) || !state.partyCode) {
    clearSessionAndGoHome();
    return;
  }

  initPageMeta();
  updateConnectionStatus(false);
  updateHostControlsVisibility();
  ensureYouTubeHostNode();
  if (window.YT && window.YT.Player) {
    initYouTubePlayer();
  }
  setupAudioUnlockOnInteraction();

  // Re-sync playback when returning from a background tab
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.currentIsPlaying && state.currentSong?.video_id) {
      if (state.socket?.connected) {
        state.socket.emit('syncNowPlaying');
      }
    }
  });

  initSocket();
  await loadInitialQueue();

  // If the YouTube API is already ready (e.g. cached or fast load), sync immediately.
  // Otherwise, the onReady listener inside onYouTubeIframeAPIReady will catch it.
  if (state.player && typeof state.player.loadVideoById === 'function') {
    syncPlayerWithCurrentSong();
  }

  /* Button Listeners */
  if (DOM.playBtn) DOM.playBtn.addEventListener('click', togglePlay);
  if (DOM.muteBtn) DOM.muteBtn.addEventListener('click', toggleMute);
  if (DOM.hostSkipBtn) DOM.hostSkipBtn.addEventListener('click', handleHostSkipCurrent);
  if (DOM.relinquishHostBtn) DOM.relinquishHostBtn.addEventListener('click', handleRelinquishHost);
  if (DOM.toggleSidebarBtn) DOM.toggleSidebarBtn.addEventListener('click', toggleSidebar);
  if (DOM.progressTrack) DOM.progressTrack.addEventListener('pointerdown', seek);

  if (DOM.volumeSlider) {
    const initialVolume = Number(localStorage.getItem('bb_volume') || 80);
    DOM.volumeSlider.value = String(initialVolume);
    DOM.volumeSlider.addEventListener('input', (e) => setVolumeForCurrentUser(e.target.value));
  }

  setupMediaSessionHandlers();

  if (DOM.searchInput) DOM.searchInput.addEventListener('input', handleSearch);
  if (DOM.chatForm) DOM.chatForm.addEventListener('submit', processChatSubmit);
  if (DOM.chatInput) DOM.chatInput.addEventListener('input', emitTypingIndicator);

  // Mobile sidebar overlay close handlers
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  const sidebarCloseBtn = document.getElementById('sidebar-close-btn');
  if (sidebarCloseBtn)
    sidebarCloseBtn.addEventListener('click', () => sidebarOverlay?.classList.remove('active'));
  if (sidebarOverlay)
    sidebarOverlay.addEventListener('click', (e) => {
      if (e.target === sidebarOverlay) sidebarOverlay.classList.remove('active');
    });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      clearSearchResults(DOM.searchResults);
      sidebarOverlay?.classList.remove('active');
    }
  });

  document.addEventListener('click', (e) => {
    if (!DOM.searchResults || !DOM.searchInput) return;
    if (!DOM.searchResults.contains(e.target) && !DOM.searchInput.contains(e.target)) {
      clearSearchResults(DOM.searchResults);
    }
  });
});

function setupMediaSessionHandlers() {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => {
      // If client is host, togglePlay acts normally, broadcasting to the party.
      // If guest, standard playback restrictions apply natively via togglePlay's internal checks.
      togglePlay();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      togglePlay();
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      handleHostSkipCurrent();
    });
  }
}

window.addEventListener('beforeunload', () => {
  cleanupSocket();
  if (searchAbortController) searchAbortController.abort();
  stopProgress();
});

/* ================= GLOBAL EXPORTS ================= */
window.handleVote = handleVote;
window.handleSkipVote = handleSkipVote;
window.handleHostSkip = handleHostSkip;
window.handleHostSkipCurrent = handleHostSkipCurrent;
window.handleRelinquishHost = handleRelinquishHost;
window.handleReact = handleReact;
window.handleSearch = handleSearch;
window.addSong = addSong;
window.togglePlay = togglePlay;
window.toggleMute = toggleMute;
window.seek = seek;
window.deleteMessage = deleteMessage;
window.toggleSidebar = toggleSidebar;
window.applyPlaybackAction = applyPlaybackAction;
