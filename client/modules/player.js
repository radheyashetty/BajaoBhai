import { state } from './state.js';
import { DOM } from './dom.js';
import { 
  PROGRESS_INTERVAL_MS, 
  HARD_SYNC_COOLDOWN_MS, 
  RATE_SYNC_DRIFT_SECONDS, 
  SMOOTH_SYNC_DRIFT_SECONDS
} from './constants.js';
import { updatePlayIcon } from './ui-render.js';
import { formatTime, clampNumber } from './utils.js';
import { Logger } from './logger.js';

/* ================= PLAYER LOGIC ================= */

export function startProgress() {
  stopProgress();
  state.isPlaying = true;
  updatePlayIcon(true);

  state.progressInterval = setInterval(() => {
    updateProgressUI();
    checkGuestPlaybackSync();
  }, PROGRESS_INTERVAL_MS);
}

export function stopProgress() {
  if (state.progressInterval) {
    clearInterval(state.progressInterval);
    state.progressInterval = null;
    Logger.info('player', 'Progress interval stopped');
  }
}

/**
 * Ensures all audio sources are aggressively stopped and cleared to avoid 'double audio' glitches.
 */
export function stopAllPlayers() {
  Logger.info('player', 'stopAllPlayers: Killing all active audio instances');
  
  // 1. Kill HTML5 Audio
  if (state.audioFallback) {
    try {
      state.audioFallback.pause();
      state.audioFallback.src = ''; 
      state.audioFallback.load(); // Forces cleanup
      state.audioFallback.removeAttribute('src');
    } catch (err) {
      Logger.warn('player', 'Error clearing audioFallback');
    }
  }

  // 2. Kill YouTube
  if (state.player && typeof state.player.stopVideo === 'function') {
    try {
      state.player.stopVideo();
      if (typeof state.player.pauseVideo === 'function') state.player.pauseVideo();
    } catch (err) {
      Logger.warn('player', 'Error stopping YT player');
    }
  }
}

function updateProgressUI() {
  if (!DOM.progressBar || !DOM.timeDisplay || !state.currentSong) return;

  const duration = Number(state.currentSong.duration_seconds) || 0;
  if (duration <= 0) return;

  const startedAt = Number(state.currentStartedAt) || Date.now();
  let elapsed;
  if (state.currentIsPlaying) {
    elapsed = (Date.now() - startedAt) / 1000;
  } else if (Number.isFinite(state.currentResumeSeconds) && state.currentResumeSeconds !== null) {
    elapsed = Number(state.currentResumeSeconds);
  } else {
    // BUG 9 FIX: When paused with no explicit resumeSeconds (e.g. after seek then pause),
    // calculate from startedAt instead of defaulting to 0
    elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
  }

  const percent = clampNumber((elapsed / duration) * 100, 0, 100);
  DOM.progressBar.style.width = `${percent}%`;
  DOM.timeDisplay.textContent = formatTime(elapsed);
}

export function checkGuestPlaybackSync(nowTs = Date.now()) {
  if (document.hidden || !state.socket?.connected || !state.currentSong?.song_id || !state.currentIsPlaying || !state.currentStartedAt) {
    if (state.playbackMode === 'stream' && state.audioFallback) {
       state.audioFallback.playbackRate = 1.0;
    }
    return;
  }

  const expectedTime = Math.max(0, (Number(nowTs) - Number(state.currentStartedAt)) / 1000);

  if (state.playbackMode === 'stream') {
    if (!state.audioFallback || state.audioFallback.paused) return;
    const rawCurrentTime = Number(state.audioFallback.currentTime || 0);

    // The browser's currentTime is relative to the byte-range start, NOT the
    // absolute position in the song. Add the stream start offset to get the
    // true playback position.
    const streamOffset = Number(state.streamStartOffsetSeconds || 0);
    const actualTime = streamOffset + rawCurrentTime;
    const drift = expectedTime - actualTime;

    if (Math.abs(drift) > 6) {
       // Massive drift usually from buffering stalls; hard reset the stream
       if (nowTs - (state.lastHardSyncAt || 0) >= 6000) {
          Logger.warn('player', `Stream hard sync triggered: drift=${drift.toFixed(2)}s (expected=${expectedTime.toFixed(1)} actual=${actualTime.toFixed(1)} offset=${streamOffset})`);
          state._isReloadingStream = true;
          state.streamStartOffsetSeconds = Math.floor(expectedTime);
          state.audioFallback.src = `/api/v1/stream/${state.currentSong.video_id}?start=${Math.floor(expectedTime)}`;
          state.audioFallback.play().catch(() => {});
          state.lastHardSyncAt = nowTs;
       }
    } else if (drift > 0.4) {
       state.audioFallback.playbackRate = 1.08;
    } else if (drift < -0.4) {
       state.audioFallback.playbackRate = 0.92;
    } else {
       state.audioFallback.playbackRate = 1.0;
    }
    return;
  }

  // API MODE
  if (!state.player?.getCurrentTime || !window.YT?.PlayerState) return;

  const playerState = state.player.getPlayerState?.();
  if (playerState !== window.YT.PlayerState.PLAYING) return;

  const currentTime = Number(state.player.getCurrentTime() || 0);
  const drift = expectedTime - currentTime;
  const absDrift = Math.abs(drift);

  if (absDrift >= 2.5) {
    if (nowTs - (state.lastHardSyncAt || 0) >= HARD_SYNC_COOLDOWN_MS) {
      Logger.warn('player', `Hard sync triggered (API Mode): drift=${drift.toFixed(2)}s`);
      state.player.seekTo(expectedTime, true);
      state.lastHardSyncAt = nowTs;
    }
  } else if (absDrift > RATE_SYNC_DRIFT_SECONDS) {
    // BUG 4 FIX: Micro-adjust playback rate for API mode to correct small drifts
    // without the jarring jump of a hard seek
    if (typeof state.player.setPlaybackRate === 'function') {
      const rate = drift > 0 ? 1.05 : 0.95;
      state.player.setPlaybackRate(rate);
    }
  } else if (absDrift > SMOOTH_SYNC_DRIFT_SECONDS) {
    if (typeof state.player.setPlaybackRate === 'function') {
      const rate = drift > 0 ? 1.03 : 0.97;
      state.player.setPlaybackRate(rate);
    }
  } else {
    // Drift is within acceptable range — reset to normal rate
    if (typeof state.player.setPlaybackRate === 'function') {
      state.player.setPlaybackRate(1.0);
    }
    state.stableSyncTicks = (state.stableSyncTicks || 0) + 1;
  }
}

export function loadNowPlaying(song, startedAt, resumeSeconds = null, isPlaying = true) {
  const previousVideoId = state.currentSong?.video_id || null;
  state.currentSong = song;
  state.currentStartedAt = Number(startedAt) || Date.now();
  state.currentResumeSeconds = Number.isFinite(Number(resumeSeconds)) ? Number(resumeSeconds) : null;
  state.currentIsPlaying = isPlaying !== false;
  
  if (DOM.nowPlayingTitle) {
    DOM.nowPlayingTitle.textContent = song?.title || 'No song';
  }
  if (DOM.nowPlayingThumb) {
    DOM.nowPlayingThumb.src = song?.thumbnail || '';
    DOM.nowPlayingThumb.alt = song?.title || 'Song thumbnail';
    DOM.nowPlayingThumb.loading = 'lazy';
  }

  updateMediaSession(song);
  syncPlayerWithCurrentSong(previousVideoId);
}

function updateMediaSession(song) {
  if ('mediaSession' in navigator) {
    if (!song) {
      navigator.mediaSession.playbackState = 'none';
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || 'Bajao Bhai Party',
      artist: song.channel_name || 'Now Playing',
      album: 'Bajao Bhai Stream',
      artwork: [
        { src: song.thumbnail || '/data/bajaobhaicreators.jpeg', sizes: '512x512', type: 'image/jpeg' }
      ]
    });
    navigator.mediaSession.playbackState = state.currentIsPlaying ? 'playing' : 'paused';
  }
}

export function syncPlayerWithCurrentSong(previousVideoId = null, forceReload = false) {
  if (!state.currentSong?.video_id) return;
  const durationSeconds = Number(state.currentSong?.duration_seconds) || 0;
  const startedAt = Number(state.currentStartedAt) || Date.now();
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const preferredSeek = Number.isFinite(state.currentResumeSeconds) ? state.currentResumeSeconds : elapsedSeconds;
  const seekTo = durationSeconds > 0
    ? Math.min(Math.max(preferredSeek, 0), Math.max(durationSeconds - 1, 0))
    : Math.max(preferredSeek, 0);

  const currentVideoId = previousVideoId || state.player?.getVideoData?.()?.video_id || null;
  const sameTrack = !forceReload && currentVideoId && currentVideoId === state.currentSong.video_id;

  if (!sameTrack) {
    Logger.info('player', `Loading new track: ${state.currentSong.video_id} mode=${state.playbackMode}`);
    stopAllPlayers();

    if (state.playbackMode === 'stream' && state.audioFallback) {
      state.audioFallback.dataset.videoId = state.currentSong.video_id;
      // Track the time offset so sync can calculate the true position
      state._isReloadingStream = true;
      state.streamStartOffsetSeconds = Math.floor(seekTo);
      const streamUrl = `/api/v1/stream/${state.currentSong.video_id}?start=${Math.floor(seekTo)}`;
      Logger.info('player', `Starting stream source: ${streamUrl} (offset=${state.streamStartOffsetSeconds}s)`);
      state.audioFallback.src = streamUrl;
      state.lastPlayedSongId = state.currentSong.song_id;
    } else if (state.player?.loadVideoById) {
      Logger.info('player', `Loading YT video: ${state.currentSong.video_id} at ${seekTo}s`);
      if (state.currentIsPlaying) {
        state.player.loadVideoById(state.currentSong.video_id, seekTo);
      } else if (typeof state.player.cueVideoById === 'function') {
        state.player.cueVideoById(state.currentSong.video_id, seekTo);
      } else {
        state.player.loadVideoById(state.currentSong.video_id, seekTo);
      }
      state.lastPlayedSongId = state.currentSong.song_id;
      state.pendingSeekSeconds = seekTo;
    }
  } else if (seekTo > 0) {
    if (state.playbackMode === 'stream' && state.audioFallback) {
      const streamOffset = Number(state.streamStartOffsetSeconds || 0);
      const actualTime = streamOffset + Number(state.audioFallback.currentTime || 0);
      if (Math.abs(actualTime - seekTo) > 4) {
        Logger.info('player', `Re-loading stream for major seek: ${seekTo}s (was at ${actualTime.toFixed(1)}s)`);
        // For Stream Mode, re-opening the source is better than setting currentTime on a piped live stream.
        state._isReloadingStream = true;
        state.streamStartOffsetSeconds = Math.floor(seekTo);
        state.audioFallback.src = `/api/v1/stream/${state.currentSong.video_id}?start=${Math.floor(seekTo)}`;
      }
    } else if (state.player?.seekTo) {
      const currentTime = typeof state.player.getCurrentTime === 'function' ? state.player.getCurrentTime() : null;
      if (currentTime === null || Math.abs(currentTime - seekTo) > 2) {
        Logger.info('player', `Seeking YT video to ${seekTo}s`);
        state.player.seekTo(seekTo, true);
      }
    }
    state.pendingSeekSeconds = null;
  }
  
  state.currentResumeSeconds = null;
  if (state.currentIsPlaying) {
    if (state.playbackMode === 'stream' && state.audioFallback) {
      if (state.audioFallback.muted) state.audioFallback.muted = false;
      state.audioFallback.play().catch(() => {});
    } else if (state.player?.playVideo) {
      if (typeof state.player.unMute === 'function') state.player.unMute();
      state.player.playVideo();
    }
    state.isPlaying = true;
    updatePlayIcon(true);
  } else {
    if (state.playbackMode === 'stream' && state.audioFallback) {
      state.audioFallback.pause();
    } else if (state.player?.pauseVideo) {
      state.player.pauseVideo();
    }
    state.isPlaying = false;
    updatePlayIcon(false);
  }
}

export function setVolumeForCurrentUser(volume) {
  const safeVolume = Math.min(Math.max(Number(volume) || 0, 0), 100);
  if (DOM.volumeSlider) {
    DOM.volumeSlider.value = String(safeVolume);
  }
  localStorage.setItem('bb_volume', String(safeVolume));
  try {
    if (state.playbackMode === 'stream' && state.audioFallback) {
      state.audioFallback.volume = safeVolume / 100;
      if (safeVolume > 0 && state.audioFallback.muted) {
        state.audioFallback.muted = false;
      }
    }
    if (state.player?.setVolume) {
      if (safeVolume > 0 && typeof state.player.isMuted === 'function' && state.player.isMuted()) {
        if (typeof state.player.unMute === 'function') state.player.unMute();
      }
      state.player.setVolume(safeVolume);
    }
  } catch (err) {
    // Ignore volume set errors
  }
}

