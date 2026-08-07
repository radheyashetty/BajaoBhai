/* ================= STATE ================= */
export let state = {
  isPlaying: false,
  progressInterval: null,
  queue: [],
  users: [],
  currentSong: null,
  currentStartedAt: null,
  currentResumeSeconds: null,
  currentIsPlaying: true,
  socket: null,
  player: null,
  lastProgressEmitAt: 0,
  partyCode: null,
  session: null,
  toastTimer: null,
  isAddingSong: false,
  lastEndedSongId: null,
  lastEndedAt: 0,
  lastGuestSyncCheckAt: 0,
  lastHardSyncAt: 0,
  stableSyncTicks: 0,
  playbackMode: 'api', // 'api' or 'stream'
  audioFallback: null,
  pendingNowPlaying: null, // Buffers nowPlaying if player not ready yet
  streamStartOffsetSeconds: 0, // Tracks the ?start= offset for stream mode currentTime correction
  typingTimer: null,
  typingClearTimer: null,
  logs: [],
  MAX_LOGS: 100,
};
