// MonkeyHub - statistics engine.
//
// A normalized result looks like this (see content/content.js and
// content/page-bridge.js for where each field is populated from):
//
// {
//   id: "8f3a1c02",              // stable dedup hash, see util.js#resultId
//   timestamp: 1737490000000,    // ms epoch, when the test finished
//   wpm: 87.4,
//   rawWpm: 91.2,
//   acc: 96.5,                   // 0-100
//   consistency: 78.3,           // 0-100, null if monkeytype didn't show one
//   mode: "time",                // "time" | "words" | "quote" | "zen" | "custom"
//   mode2: "60",                 // duration in seconds, word count, or quote length bucket
//   language: "english",
//   punctuation: false,
//   numbers: false,
//   difficulty: "normal",        // "normal" | "expert" | "master" | null
//   charStats: { correct: 421, incorrect: 8, extra: 1, missed: 2 } | null,
//   testDuration: 60.1,          // seconds, actual elapsed time
//   source: "dom" | "network",   // which capture strategy produced this row
// }

var MH = self.MH || {};

function bucketKey(r) {
  if (r.mode === "time" || r.mode === "words") return `${r.mode}:${r.mode2}`;
  return r.mode; // quote / zen / custom are grouped without a sub-bucket
}

function bucketLabel(key) {
  const [mode, mode2] = key.split(":");
  if (mode === "time") return `${mode2}s`;
  if (mode === "words") return `${mode2} words`;
  return { quote: "Quote", zen: "Zen", custom: "Custom" }[mode] || mode;
}
MH.bucketLabel = bucketLabel;

const BUCKET_MODE_PRIORITY = { time: 0, words: 1, quote: 2, zen: 3, custom: 4 };

/** Sorts personal-best bucket keys ("time:60", "words:25", "quote", ...)
 * into a stable, human-friendly order: time ascending, then words
 * ascending, then quote/zen/custom. Shared by the README and dashboard so
 * both render personal bests in the same order. */
MH.sortedBucketKeys = function sortedBucketKeys(personalBests) {
  return Object.keys(personalBests).sort((a, b) => {
    const [modeA, subA] = a.split(":");
    const [modeB, subB] = b.split(":");
    const pa = BUCKET_MODE_PRIORITY[modeA] ?? 9;
    const pb = BUCKET_MODE_PRIORITY[modeB] ?? 9;
    return pa - pb || (Number(subA) || 0) - (Number(subB) || 0);
  });
};

/** Groups results into per-mode buckets for MonkeyHub's split data files
 * (data/time.json, data/words.json, ...). Anything with an unrecognized or
 * missing mode lands in "unknown" rather than being dropped. */
MH.groupResultsByMode = function groupResultsByMode(results) {
  const buckets = {};
  for (const mode of MH.DATA_FILE_MODES) buckets[mode] = [];
  for (const r of results) {
    const bucket = MH.DATA_FILE_MODES.includes(r.mode) ? r.mode : "unknown";
    buckets[bucket].push(r);
  }
  return buckets;
};

/** Merges freshly captured results into an existing array, de-duplicating
 * by id and keeping the array sorted ascending by timestamp (append-only
 * log semantics, which keeps README/diff history readable on GitHub). */
MH.mergeResults = function mergeResults(existing, incoming) {
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const r of incoming) byId.set(r.id, r);
  return Array.from(byId.values()).sort((a, b) => a.timestamp - b.timestamp);
};

function computeStreak(dateKeys) {
  if (dateKeys.size === 0) return { current: 0, longest: 0 };
  const days = Array.from(dateKeys).sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1]);
    const cur = new Date(days[i]);
    const diffDays = Math.round((cur - prev) / 86400000);
    if (diffDays === 1) {
      run += 1;
    } else if (diffDays > 1) {
      longest = Math.max(longest, run);
      run = 1;
    }
  }
  longest = Math.max(longest, run);

  // current streak: walk back from today/yesterday
  const todayKey = MH.localDateKey(Date.now());
  const yesterdayKey = MH.localDateKey(Date.now() - 86400000);
  let current = 0;
  if (dateKeys.has(todayKey) || dateKeys.has(yesterdayKey)) {
    let cursor = dateKeys.has(todayKey) ? new Date(todayKey) : new Date(yesterdayKey);
    while (dateKeys.has(MH.localDateKey(cursor.getTime()))) {
      current += 1;
      cursor = new Date(cursor.getTime() - 86400000);
    }
  }
  return { current, longest };
}

/**
 * Week-aligned daily test counts, oldest first, for the activity calendar
 * shown in both the README and the dashboard. The range always starts on a
 * Sunday and ends on the Saturday of the *current* week so downstream
 * renderers can group the flat array into `weeks` even-width columns
 * without doing any date math themselves. Days after today are marked
 * `isFuture` so renderers can leave them blank instead of drawing a "0".
 */
MH.buildHeatmap = function buildHeatmap(results, weeks = 53) {
  const counts = new Map();
  for (const r of results) {
    const key = MH.localDateKey(r.timestamp);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(today);
  endOfWeek.setDate(today.getDate() + (6 - today.getDay()));
  const totalDays = weeks * 7;
  const start = new Date(endOfWeek);
  start.setDate(endOfWeek.getDate() - totalDays + 1);

  const out = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = MH.localDateKey(d.getTime());
    out.push({
      date: key,
      month: d.getMonth(),
      weekday: d.getDay(),
      isFuture: d.getTime() > today.getTime(),
      count: counts.get(key) || 0,
    });
  }
  return out;
};

/** Groups a flat, Sunday-aligned day array (as produced by buildHeatmap)
 * into week columns of 7 entries (Sun..Sat) each. */
MH.groupIntoWeeks = function groupIntoWeeks(flatDays) {
  const weeksArr = [];
  for (let i = 0; i < flatDays.length; i += 7) weeksArr.push(flatDays.slice(i, i + 7));
  return weeksArr;
};

MH.computeStats = function computeStats(results) {
  if (!results || results.length === 0) {
    return {
      totalTests: 0,
      totalTimeTypedSeconds: 0,
      firstTestAt: null,
      lastTestAt: null,
      avgWpm: 0,
      avgAcc: 0,
      avgConsistency: null,
      bestWpm: null,
      bestAcc: null,
      bestConsistency: null,
      personalBests: {},
      modeBreakdown: {},
      streak: { current: 0, longest: 0 },
      heatmap: MH.buildHeatmap([]),
      recent: [],
    };
  }

  let totalWpm = 0;
  let totalAcc = 0;
  let totalConsistency = 0;
  let consistencyCount = 0;
  let totalTime = 0;
  let bestWpm = results[0];
  let bestAcc = results[0];
  let bestConsistency = null;
  const personalBests = {};
  const modeBreakdown = {};
  const dateKeys = new Set();

  for (const r of results) {
    totalWpm += r.wpm;
    totalAcc += r.acc;
    if (typeof r.consistency === "number") {
      totalConsistency += r.consistency;
      consistencyCount += 1;
      if (!bestConsistency || r.consistency > bestConsistency.consistency) bestConsistency = r;
    }
    totalTime += r.testDuration || 0;
    if (r.wpm > bestWpm.wpm) bestWpm = r;
    if (r.acc > bestAcc.acc) bestAcc = r;

    const key = bucketKey(r);
    modeBreakdown[r.mode] = (modeBreakdown[r.mode] || 0) + 1;
    if (!personalBests[key] || r.wpm > personalBests[key].wpm) {
      personalBests[key] = r;
    }
    dateKeys.add(MH.localDateKey(r.timestamp));
  }

  const recent = [...results].sort((a, b) => b.timestamp - a.timestamp).slice(0, 15);

  return {
    totalTests: results.length,
    totalTimeTypedSeconds: totalTime,
    firstTestAt: results[0].timestamp,
    lastTestAt: results[results.length - 1].timestamp,
    avgWpm: MH.round1(totalWpm / results.length),
    avgAcc: MH.round1(totalAcc / results.length),
    avgConsistency: consistencyCount ? MH.round1(totalConsistency / consistencyCount) : null,
    bestWpm,
    bestAcc,
    bestConsistency,
    personalBests,
    modeBreakdown,
    streak: computeStreak(dateKeys),
    heatmap: MH.buildHeatmap(results),
    recent,
  };
};

if (typeof module !== "undefined") {
  module.exports = MH;
}
