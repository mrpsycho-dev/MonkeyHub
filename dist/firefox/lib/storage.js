// MonkeyHub - typed storage helpers.
//
// Everything lives in chrome.storage.local (not .sync): tokens should never
// be silently propagated to other machines via the browser's sync channel,
// and the results cache can grow past the ~100KB sync quota quickly.

var MH = self.MH || {};

MH.storageGet = async function storageGet(key, fallback) {
  const store = MH.ext.storage.local;
  const res = await MH.callApi(store, "get", [key]);
  const val = res && res[key];
  return val === undefined ? fallback : val;
};

MH.storageSet = async function storageSet(key, value) {
  const store = MH.ext.storage.local;
  return MH.callApi(store, "set", { [key]: value });
};

MH.storageRemove = async function storageRemove(key) {
  const store = MH.ext.storage.local;
  return MH.callApi(store, "remove", key);
};

MH.getAuth = () => MH.storageGet(MH.KEYS.AUTH, null);
MH.setAuth = (v) => MH.storageSet(MH.KEYS.AUTH, v);
MH.clearAuth = () => MH.storageRemove(MH.KEYS.AUTH);

MH.getConfig = async () => {
  const stored = await MH.storageGet(MH.KEYS.CONFIG, null);
  const merged = Object.assign({}, MH.DEFAULT_CONFIG, stored || {});
  // A user-entered Client ID always wins; otherwise fall back to a Client
  // ID baked into this build (see constants.js#DEFAULT_OAUTH_CLIENT_ID).
  if (!merged.oauthClientId && MH.DEFAULT_OAUTH_CLIENT_ID) {
    merged.oauthClientId = MH.DEFAULT_OAUTH_CLIENT_ID;
    merged.oauthClientIdIsBundled = true;
  } else {
    merged.oauthClientIdIsBundled = false;
  }
  return merged;
};
MH.setConfig = async (partial) => {
  const current = await MH.getConfig();
  const next = Object.assign({}, current, partial);
  await MH.storageSet(MH.KEYS.CONFIG, next);
  return next;
};

MH.getResultsStore = async () => {
  const stored = await MH.storageGet(MH.KEYS.RESULTS, null);
  return Object.assign({}, MH.DEFAULT_RESULTS, stored || {});
};
MH.setResultsStore = (v) => MH.storageSet(MH.KEYS.RESULTS, v);

MH.getSyncState = async () => {
  const stored = await MH.storageGet(MH.KEYS.SYNC_STATE, null);
  return Object.assign({}, MH.DEFAULT_SYNC_STATE, stored || {});
};
MH.setSyncState = async (partial) => {
  const current = await MH.getSyncState();
  const next = Object.assign({}, current, partial);
  await MH.storageSet(MH.KEYS.SYNC_STATE, next);
  return next;
};

const MAX_LOG_ENTRIES = 60;
MH.appendLog = async function appendLog(entry) {
  const log = await MH.storageGet(MH.KEYS.LOG, []);
  log.unshift(Object.assign({ at: Date.now() }, entry));
  await MH.storageSet(MH.KEYS.LOG, log.slice(0, MAX_LOG_ENTRIES));
};
MH.getLog = () => MH.storageGet(MH.KEYS.LOG, []);

if (typeof module !== "undefined") {
  module.exports = MH;
}
