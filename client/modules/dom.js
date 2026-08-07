/* ================= DOM CACHE (Lazy Initialization) ================= */
// ES modules execute before DOMContentLoaded, so we can't call getElementById
// at import time. This pattern caches on first access after the DOM is ready.

const _cache = {};

function lazyGet(id) {
  if (!(id in _cache)) {
    _cache[id] = document.getElementById(id);
  }
  return _cache[id];
}

export const DOM = new Proxy({}, {
  get(_target, prop) {
    const map = {
      progressBar: 'progress-bar',
      progressTrack: 'progress-track',
      timeDisplay: 'time-display',
      toast: 'toast',
      toastMsg: 'toast-msg',
      nowPlayingTitle: 'now-playing-title',
      nowPlayingThumb: 'now-playing-thumb',
      queueList: 'queue-list',
      queueCount: 'queue-count',
      queueLoading: 'queue-loading',
      usersList: 'users-list',
      searchInput: 'search-input',
      searchResults: 'search-results',
      navPartyCode: 'nav-party-code',
      userAvatar: 'user-avatar',
      connectionStatus: 'connection-status',
      playBtn: 'play-btn',
      playIcon: 'play-icon',
      muteBtn: 'mute-btn',
      muteIcon: 'mute-icon',
      volumeSlider: 'volume-slider',
      hostSkipBtn: 'host-skip-btn',
      skipVoteRatio: 'skip-vote-ratio',
      relinquishHostBtn: 'relinquish-host-btn',
      toggleSidebarBtn: 'toggle-sidebar-btn',
      chatMessages: 'chat-messages',
      chatForm: 'chat-form',
      chatInput: 'chat-input',
      chatTyping: 'chat-typing',
    };
    const id = map[prop];
    if (id) return lazyGet(id);
    return undefined;
  },
});
