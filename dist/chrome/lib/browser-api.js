// MonkeyHub - tiny cross-browser shim.
//
// Firefox's `browser.*` namespace is promise-based natively. Chrome's
// `chrome.*` namespace supports promises for most calls in modern versions,
// but a handful of call sites (notably identity.launchWebAuthFlow on older
// Chrome, and any callback-only API) still expect a callback + lastError
// check. `callApi` below normalizes both into a single promise-returning
// call so the rest of the codebase never has to branch on browser.

var MH = self.MH || {};

MH.ext = typeof browser !== "undefined" ? browser : chrome;
MH.isFirefox = typeof browser !== "undefined";

/**
 * Calls `obj[method](...args)` and returns a Promise. Both Firefox's
 * `browser.*` (always promise-based) and current Chrome's `chrome.*`
 * (promise-based since well before this extension's minimum supported
 * version, when no trailing callback is passed) resolve this the same way,
 * so there's no need for a callback/lastError dance here.
 */
MH.callApi = function callApi(obj, method, ...args) {
  return Promise.resolve(obj[method](...args));
};

if (typeof module !== "undefined") {
  module.exports = MH;
}
