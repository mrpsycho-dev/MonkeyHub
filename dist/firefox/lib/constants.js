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
  AUTH: "mh_auth", // { mode: 'oauth'|'pat', accessToken, tokenType, scope, login, name, avatarUrl }
  CONFIG: "mh_config", // { owner, repo, branch, dataDir, readmePath, autoSync, createIfMissing, visibility, oauthClientId }
  RESULTS: "mh_results", // { version, results: [...] }
  SYNC_STATE: "mh_sync_state", // { lastSyncAt, lastCommitSha, status, lastError, consecutiveFailures }
  LOG: "mh_log", // ring buffer of recent sync events (for the dashboard activity panel)
  DEVICE_FLOW: "mh_device_flow", // transient GitHub device-flow state, see lib/oauth.js
};

// ---------------------------------------------------------------------------
// GitHub endpoints
// ---------------------------------------------------------------------------
MH.GITHUB_API = "https://api.github.com";
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
  dataDir: "data", // one JSON file per test mode lives here: data/time.json, data/words.json, ...
  readmePath: "README.md",
  autoSync: true,
  createIfMissing: true,
  visibility: "public", // 'public' | 'private' - only used when MonkeyHub creates the repo
  oauthClientId: "", // resolved from MH.DEFAULT_OAUTH_CLIENT_ID if that's set, see storage.js#getConfig
  notifyOnError: true,
};

// GitHub's OAuth endpoints always require *a* client_id - that's not
// optional for any flow, including the device flow. It isn't sensitive
// information the way a client_secret is, though, so a build of MonkeyHub
// can ship with one baked in: fill this in with your own OAuth App's
// Client ID (GitHub -> Settings -> Developer settings -> OAuth Apps -> New
// OAuth App; the callback URL field is unused by the device flow, any
// value satisfies it) and every user of this build gets a single
// "Authorize with GitHub" button with no Client ID box to fill in at all.
// Left blank, MonkeyHub falls back to asking the user for their own -
// still a one-time, no-secret, no-proxy setup, just one extra field.
MH.DEFAULT_OAUTH_CLIENT_ID = "";

MH.DEFAULT_RESULTS = {
  version: 1,
  results: [], // array of normalized result objects, see lib/stats.js for the shape
};

MH.DEFAULT_SYNC_STATE = {
  lastSyncAt: null,
  lastCommitSha: null, // last commit MonkeyHub made, mostly informational
  // The local results store (see MH.KEYS.RESULTS) is itself the durable
  // queue: every captured result is written there immediately regardless
  // of network state, so there's no separate pending-write buffer to lose.
  status: "idle", // 'idle' | 'syncing' | 'error' | 'offline'
  syncLockAt: null, // timestamp the current 'syncing' status was set, used to detect an abandoned lock after a service-worker restart
  lastError: null, // { kind, message, at }
  consecutiveFailures: 0,
};

// Modes MonkeyHub understands when grouping personal bests, mirroring how
// monkeytype itself buckets a result: mode ("time" | "words" | "quote" |
// "zen" | "custom") plus mode2 (the duration/word-count/quote length).
MH.KNOWN_TIME_BUCKETS = ["15", "30", "60", "120"];
MH.KNOWN_WORD_BUCKETS = ["10", "25", "50", "100"];

// Every mode bucket MonkeyHub will split data/*.json into. "unknown" catches
// anything the capture pipeline couldn't classify, so no result is ever
// silently dropped just because its mode couldn't be determined.
MH.DATA_FILE_MODES = ["time", "words", "quote", "zen", "custom", "unknown"];

MH.ALARM_NAME = "mh-periodic-flush";
MH.ALARM_PERIOD_MINUTES = 5;

// A completed test triggers a sync after this short debounce instead of
// immediately, so back-to-back tests land in one commit instead of one
// commit each.
MH.SYNC_DEBOUNCE_MS = 4000;

if (typeof module !== "undefined") {
  module.exports = MH;
}
