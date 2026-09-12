// MonkeyHub - content script (isolated world).
//
// Responsibilities:
//   1. Inject page-bridge.js into the page's own JS context so it can sniff
//      monkeytype's network traffic for a result payload (see that file for
//      why this needs a separate injected script rather than just patching
//      fetch from here).
//   2. Watch the DOM for the results screen as a fallback that works even
//      when the user isn't logged into monkeytype (so no network save ever
//      happens) or if monkeytype changes its network layer.
//   3. Whichever source wins the short race below, normalize + forward the
//      captured result to the background service worker for de-duplication,
//      local storage, and the GitHub sync.
//
// If monkeytype redesigns their results screen, update SELECTORS below -
// everything else (network capture, the background sync engine) keeps
// working unchanged. Set `window.__monkeyHubDebug = true` in the page
// console for verbose logging of each extraction attempt.

(function () {
  const DOM_SCRAPE_GRACE_MS = 1400; // wait this long for a network candidate before trusting the DOM scrape
  const REPEAT_SUPPRESS_MS = 4000; // ignore a second capture with an identical signature this soon after the first

  // Best-effort selectors based on monkeytype's long-standing DOM
  // conventions. Wrapped in try/catch everywhere and backed by a
  // label-text scan fallback (see extractByLabelScan) so a class rename
  // degrades gracefully instead of breaking capture entirely.
  const SELECTORS = {
    resultContainer: ["#result", "[data-testid='result']", "#resultWordsHistory"].join(","),
    wpm: "#result .group.wpm .bottom, #result .wpm .top .text, #result [data-testid='wpm']",
    raw: "#result .group.raw .bottom, #result .raw .top .text, #result [data-testid='raw']",
    acc: "#result .group.acc .bottom, #result .acc .top .text, #result [data-testid='acc']",
    consistency: "#result .group.consistency .bottom, #result .consistency .top .text",
    charStats: "#result .group.chars .bottom, #result .chars .top .text",
    testType: "#result .testType, #result [data-testid='testType']",
    time: "#result .group.time .bottom, #result .time .top .text",
  };

  function log(...args) {
    if (window.__monkeyHubDebug) console.log("[MonkeyHub]", ...args);
  }

  function getDirectText(el) {
    let text = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    }
    return text.trim();
  }

  function firstNumber(str) {
    if (!str) return null;
    const m = String(str).match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && el.offsetParent !== null;
  }

  function getResultContainer() {
    const el = document.querySelector(SELECTORS.resultContainer);
    return isVisible(el) ? el : null;
  }

  /** Generic fallback: scan every element under `container` for one whose
   * own (non-nested) text matches a known label, then look for a numeric
   * value among its parent's or grandparent's other children - covers both
   * "value above / label below" and "label above / value below" layouts
   * without hard-coding either. */
  function extractByLabelScan(container, labelPattern) {
    const all = container.querySelectorAll("*");
    for (const el of all) {
      const own = getDirectText(el);
      if (!own || !labelPattern.test(own)) continue;
      const candidates = [];
      if (el.parentElement) candidates.push(...el.parentElement.children);
      if (el.parentElement && el.parentElement.parentElement) {
        candidates.push(...el.parentElement.parentElement.children);
      }
      for (const sib of candidates) {
        if (sib === el) continue;
        const num = firstNumber(getDirectText(sib) || sib.textContent);
        if (num !== null) return num;
      }
    }
    return null;
  }

  function trySelectorThenScan(container, selector, labelPattern) {
    try {
      const el = container.querySelector(selector);
      const val = el ? firstNumber(getDirectText(el) || el.textContent) : null;
      if (val !== null) return val;
    } catch (_) {
      /* selector list can partially fail across monkeytype versions */
    }
    return extractByLabelScan(container, labelPattern);
  }

  function extractCharStats(container) {
    try {
      const el = container.querySelector(SELECTORS.charStats);
      const text = el ? el.textContent : container.textContent;
      const m = text.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/);
      if (m) return { correct: +m[1], incorrect: +m[2], extra: +m[3], missed: +m[4] };
    } catch (_) {
      /* fall through */
    }
    return null;
  }

  function extractModeInfo(container) {
    try {
      const el = container.querySelector(SELECTORS.testType);
      const text = (el ? el.textContent : "").toLowerCase();
      const m = text.match(/(time|words|quote|zen|custom)\s*([0-9]+)?/);
      if (m) return { mode: m[1], mode2: m[2] || "" };
    } catch (_) {
      /* fall through */
    }
    return { mode: "unknown", mode2: "" };
  }

  function scrapeResultFromDom() {
    const container = getResultContainer();
    if (!container) return null;

    const wpm = trySelectorThenScan(container, SELECTORS.wpm, /^wpm$/i);
    const acc = trySelectorThenScan(container, SELECTORS.acc, /^acc(uracy)?$/i);
    if (wpm === null || acc === null) {
      log("DOM scrape aborted: could not find wpm/acc in the visible result screen", { wpm, acc });
      return null;
    }
    const raw = trySelectorThenScan(container, SELECTORS.raw, /^raw( wpm)?$/i);
    const consistency = trySelectorThenScan(container, SELECTORS.consistency, /^consistency$/i);
    const time = trySelectorThenScan(container, SELECTORS.time, /^time$/i);
    const { mode, mode2 } = extractModeInfo(container);

    const bodyText = container.textContent.toLowerCase();
    const result = {
      timestamp: Date.now(),
      wpm,
      rawWpm: raw !== null ? raw : wpm,
      acc,
      consistency,
      mode,
      mode2,
      language: "english", // not reliably exposed in the DOM; refined by the network capture when available
      punctuation: bodyText.includes("punctuation"),
      numbers: /\bnumbers\b/.test(bodyText),
      difficulty: "normal",
      charStats: extractCharStats(container),
      testDuration: time,
      source: "dom",
    };
    log("DOM scrape produced", result);
    return result;
  }

  // ---------------------------------------------------------------------
  // Inject the page-context bridge so we can also sniff network traffic.
  // ---------------------------------------------------------------------
  const MH_RUNTIME = typeof browser !== "undefined" ? browser.runtime : chrome.runtime;

  function injectPageBridge() {
    try {
      const script = document.createElement("script");
      script.src = MH_RUNTIME.getURL("content/page-bridge.js");
      script.onload = function () {
        this.remove();
      };
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      log("failed to inject page bridge", e);
    }
  }

  function signatureOf(r) {
    return `${r.mode}:${r.mode2}:${Math.round(r.wpm)}:${Math.round(r.acc)}`;
  }

  let lastEmittedSignature = null;
  let lastEmittedAt = 0;

  function sendResult(result) {
    const sig = signatureOf(result);
    const now = Date.now();
    if (sig === lastEmittedSignature && now - lastEmittedAt < REPEAT_SUPPRESS_MS) {
      log("suppressed duplicate emission", sig);
      return;
    }
    lastEmittedSignature = sig;
    lastEmittedAt = now;
    log("sending captured result to background", result);
    MH_RUNTIME.sendMessage({ type: "MH_RESULT_CAPTURED", result }).catch((e) => log("sendMessage failed", e));
  }

  // ---------------------------------------------------------------------
  // Network candidate listener (from page-bridge.js).
  // ---------------------------------------------------------------------
  let pendingDomTimer = null;
  let networkWonThisRound = false;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "monkeyhub-bridge" || data.type !== "RESULT_CANDIDATE") return;
    log("network candidate received", data.payload);
    networkWonThisRound = true;
    if (pendingDomTimer) {
      clearTimeout(pendingDomTimer);
      pendingDomTimer = null;
    }
    sendResult(data.payload);
  });

  // ---------------------------------------------------------------------
  // DOM fallback: observe for the results screen becoming visible.
  // ---------------------------------------------------------------------
  let resultCurrentlyVisible = false;

  function onResultScreenAppeared() {
    networkWonThisRound = false;
    if (pendingDomTimer) clearTimeout(pendingDomTimer);
    pendingDomTimer = setTimeout(() => {
      pendingDomTimer = null;
      if (networkWonThisRound) return; // network capture already handled it
      const scraped = scrapeResultFromDom();
      if (scraped) sendResult(scraped);
    }, DOM_SCRAPE_GRACE_MS);
  }

  const observer = new MutationObserver(() => {
    const visible = !!getResultContainer();
    if (visible && !resultCurrentlyVisible) {
      resultCurrentlyVisible = true;
      onResultScreenAppeared();
    } else if (!visible && resultCurrentlyVisible) {
      resultCurrentlyVisible = false;
    }
  });

  function start() {
    injectPageBridge();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    log("MonkeyHub content script active");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
