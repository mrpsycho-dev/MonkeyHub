// MonkeyHub - shared constants
// Loaded as a classic script (no ES module system is used anywhere in this
// extension) so every value below is attached to a single global namespace,
// `MH`, to avoid polluting `window`/the service worker's global scope.

var MH = self.MH || {};

MH.EXT_NAME = "MonkeyHub";

// ---------------------------------------------------------------------------
// Storage keys (chrome.storage.local). Keeping them in one place stops typos
// from silently creating a second copy of the config somewhere.
// ---------------------------------------------------------------------------
MH.KEYS = {
  AUTH: "mh_auth", // { mode: 'oauth'|'pat', accessToken, refreshToken, expiresAt, tokenType, scope, login, avatarUrl }
  CONFIG: "mh_config", // { owner, repo, branch, dataPath, readmePath, autoSync, createIfMissing, visibility, proxyUrl }
  RESULTS: "mh_results", // { version, results: [...], resultIds: {...} }
  SYNC_STATE: "mh_sync_state", // { lastSyncAt, lastSha, lastEtagRepo, lastEtagFile, pendingQueue: [...], status }
  LOG: "mh_log", // ring buffer of recent sync events (for the dashboard activity panel)
  OAUTH_TRANSIENT: "mh_oauth_transient", // { state, codeVerifier, createdAt } - short-lived, cleared after use
};

// ---------------------------------------------------------------------------
// GitHub endpoints
// ---------------------------------------------------------------------------
MH.GITHUB_API = "https://api.github.com";
MH.GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
MH.GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
MH.GITHUB_API_VERSION = "2022-11-28";

// Scopes required to read the authenticated user and create/update
// repository contents in both personal and org-owned repositories.
MH.OAUTH_SCOPES = ["repo", "read:user"];

// ---------------------------------------------------------------------------
// Defaults for a brand-new install
// ---------------------------------------------------------------------------
MH.DEFAULT_CONFIG = {
  owner: "",
  repo: "monkeytype-stats",
  branch: "main",
  dataPath: "data/results.json",
  readmePath: "README.md",
  autoSync: true,
  createIfMissing: true,
  visibility: "public", // 'public' | 'private' - only used when MonkeyHub creates the repo
  proxyUrl: "", // token-exchange proxy for the OAuth+PKCE flow, see /proxy in the project
  notifyOnError: true,
  minSecondsBetweenSyncs: 3, // debounce: avoid double-commits if two triggers fire close together
};

MH.DEFAULT_RESULTS = {
  version: 1,
  results: [], // array of normalized result objects, see lib/stats.js for the shape
};

MH.DEFAULT_SYNC_STATE = {
  lastSyncAt: null,
  lastSha: null, // sha of data file as last known on GitHub, used for optimistic-concurrency writes
  lastReadmeSha: null,
  lastEtagRepo: null,
  lastEtagFile: null,
  // The local results store (see MH.KEYS.RESULTS) is itself the durable
  // queue: every captured result is written there immediately regardless
  // of network state, so there's no separate pending-write buffer to lose.
  status: "idle", // 'idle' | 'syncing' | 'error' | 'offline'
  lastError: null, // { kind, message, at }
  consecutiveFailures: 0,
};

// Modes MonkeyHub understands when grouping personal bests, mirroring how
// monkeytype itself buckets a result: mode ("time" | "words" | "quote" |
// "zen" | "custom") plus mode2 (the duration/word-count/quote length).
MH.KNOWN_TIME_BUCKETS = ["15", "30", "60", "120"];
MH.KNOWN_WORD_BUCKETS = ["10", "25", "50", "100"];

MH.ALARM_NAME = "mh-periodic-flush";
MH.ALARM_PERIOD_MINUTES = 5;

if (typeof module !== "undefined") {
  module.exports = MH;
}
