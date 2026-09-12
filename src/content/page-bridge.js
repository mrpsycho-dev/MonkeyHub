// MonkeyHub - page bridge.
//
// Runs inside monkeytype.com's own page context (injected by content.js,
// NOT the isolated content-script world), so it can see the real
// `window.fetch` / `XMLHttpRequest` before monkeytype's bundle wraps them.
// When monkeytype is logged in, completing a test triggers a request to
// its own backend to save the result to your account history - this file
// watches for that shape of payload (in either the request body or the
// response) and hands it to content.js, which has no other way to see it
// since content scripts run in an isolated JS world with a different
// `window.fetch` reference.
//
// This is a *supplement* to DOM scraping, not a replacement: if you aren't
// logged into monkeytype (so no save request is ever made) content.js's
// MutationObserver-based reader is what actually captures the test.

(function () {
  const SOURCE = "monkeyhub-bridge";

  function safeJsonParse(text) {
    if (typeof text !== "string" || !text.trim().startsWith("{")) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  /** Scores how "result-shaped" an object is. Requires the two fields that
   * are meaningless to fake by coincidence (wpm + accuracy in a plausible
   * numeric range) plus at least two more corroborating fields, to avoid
   * false-positiving on unrelated JSON floating around the page. */
  function scoreCandidate(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return 0;
    const wpm = obj.wpm;
    const acc = obj.acc ?? obj.accuracy;
    if (typeof wpm !== "number" || wpm <= 0 || wpm > 500) return 0;
    if (typeof acc !== "number" || acc < 0 || acc > 100) return 0;
    let score = 2;
    if (typeof (obj.rawWpm ?? obj.raw) === "number") score++;
    if (typeof obj.consistency === "number") score++;
    if (typeof obj.mode === "string") score++;
    if (obj.mode2 !== undefined) score++;
    if (typeof (obj.testDuration ?? obj.duration) === "number") score++;
    if (obj.charStats !== undefined) score++;
    return score;
  }

  function normalize(obj) {
    let charStats = null;
    if (Array.isArray(obj.charStats) && obj.charStats.length >= 4) {
      const [correct, incorrect, extra, missed] = obj.charStats;
      charStats = { correct, incorrect, extra, missed };
    } else if (obj.charStats && typeof obj.charStats === "object") {
      charStats = obj.charStats;
    }
    return {
      timestamp: obj.timestamp || obj.t || Date.now(),
      wpm: obj.wpm,
      rawWpm: obj.rawWpm ?? obj.raw ?? obj.wpm,
      acc: obj.acc ?? obj.accuracy,
      consistency: typeof obj.consistency === "number" ? obj.consistency : null,
      mode: obj.mode || "unknown",
      mode2: obj.mode2 !== undefined ? String(obj.mode2) : "",
      language: obj.language || "english",
      punctuation: !!obj.punctuation,
      numbers: !!obj.numbers,
      difficulty: obj.difficulty || "normal",
      charStats,
      testDuration: obj.testDuration ?? obj.duration ?? null,
      source: "network",
    };
  }

  function emit(obj) {
    const score = scoreCandidate(obj);
    if (score < 4) return;
    window.postMessage({ source: SOURCE, type: "RESULT_CANDIDATE", payload: normalize(obj) }, window.location.origin);
  }

  function inspectText(text) {
    const obj = safeJsonParse(text);
    if (!obj) return;
    // Some APIs wrap the payload, e.g. { message, data: {...} } or { result: {...} }.
    emit(obj);
    if (obj && typeof obj === "object") {
      for (const key of ["data", "result", "results"]) {
        if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) emit(obj[key]);
      }
    }
  }

  // --- fetch -----------------------------------------------------------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function patchedFetch(input, init) {
      const method = (init && init.method) || (typeof input === "object" && input.method) || "GET";
      const reqBodyText = init && typeof init.body === "string" ? init.body : null;
      if (method.toUpperCase() !== "GET" && reqBodyText) inspectText(reqBodyText);

      const promise = nativeFetch.apply(this, arguments);
      promise
        .then((response) => {
          try {
            response
              .clone()
              .text()
              .then(inspectText)
              .catch(() => {});
          } catch (_) {
            /* body already consumed elsewhere - nothing we can do */
          }
        })
        .catch(() => {});
      return promise;
    };
  }

  // --- XMLHttpRequest ----------------------------------------------------
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__monkeyhub_method = method;
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function patchedSend(body) {
    if (this.__monkeyhub_method && this.__monkeyhub_method.toUpperCase() !== "GET" && typeof body === "string") {
      inspectText(body);
    }
    this.addEventListener("load", function () {
      try {
        inspectText(this.responseText);
      } catch (_) {
        /* ignore */
      }
    });
    return nativeSend.call(this, body);
  };
})();
