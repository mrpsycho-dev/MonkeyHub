// MonkeyHub - small stateless helpers shared by every context.

var MH = self.MH || {};

/**
 * btoa()/atob() only understand Latin-1. GitHub's Contents API expects (and
 * returns) base64 of the *raw bytes* of the file, so any README containing
 * an emoji, accented name, or non-ASCII language sample has to go through a
 * real UTF-8 encoder first or the commit will silently corrupt those bytes.
 */
MH.utf8ToBase64 = function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

MH.base64ToUtf8 = function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

/** Stable, dependency-free 32-bit string hash (FNV-1a). Good enough for
 * de-duplicating results locally; not cryptographic. */
MH.fnv1a = function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/** Builds a stable dedup id for a captured result so retries, the DOM
 * fallback, and the network sniffer all converge on the same id for the
 * same test instead of committing duplicates. */
MH.resultId = function resultId(r) {
  const key = [
    r.timestamp,
    r.mode,
    r.mode2,
    r.wpm,
    r.rawWpm,
    r.acc,
    r.testDuration,
  ].join("|");
  return MH.fnv1a(key);
};

MH.clamp = (n, min, max) => Math.min(max, Math.max(min, n));

MH.round1 = (n) => Math.round((Number(n) + Number.EPSILON) * 10) / 10;

MH.debounce = function debounce(fn, ms) {
  let t = null;
  return function debounced(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
};

MH.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ISO date (YYYY-MM-DD) in the *local* timezone, used for streaks/heatmap
 * bucketing so a test at 11:58pm and one at 12:02am on the same evening for
 * the user land on the day the user actually experienced. */
MH.localDateKey = function localDateKey(tsMs) {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

MH.formatRelativeTime = function formatRelativeTime(tsMs) {
  if (!tsMs) return "never";
  const diff = Date.now() - tsMs;
  const sec = Math.round(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(tsMs).toLocaleDateString();
};

MH.formatDuration = function formatDuration(totalSeconds) {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
};

/** Cryptographically random URL-safe string, used for PKCE verifiers and
 * the OAuth `state` nonce. */
MH.randomUrlSafeString = function randomUrlSafeString(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

if (typeof module !== "undefined") {
  module.exports = MH;
}
