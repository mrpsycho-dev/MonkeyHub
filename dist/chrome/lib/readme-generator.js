// MonkeyHub - README.md generator.
//
// Turns the local results log into a monkeytype-profile-style README: hero
// badges, personal bests per mode, a year activity calendar (rendered as a
// monospace grid, since README.md can't run JS), and a recent-tests table.

var MH = self.MH || {};

const LEVEL_GLYPHS = [" ", "░", "▒", "▓", "█"];
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function renderCalendar(heatmapFlat) {
  const weeksArr = MH.groupIntoWeeks(heatmapFlat);
  let max = 1;
  for (const week of weeksArr) for (const c of week) if (!c.isFuture) max = Math.max(max, c.count);
  const step = Math.max(1, Math.ceil(max / 4));
  const glyphFor = (c) => {
    if (c.isFuture) return " ";
    if (c.count === 0) return LEVEL_GLYPHS[0];
    return LEVEL_GLYPHS[Math.min(4, Math.ceil(c.count / step))];
  };

  // Month header: place a 3-letter label above the first week whose Sunday
  // falls in a new month.
  let monthRow = "";
  let lastMonth = -1;
  for (const week of weeksArr) {
    const sunday = week[0];
    if (sunday.month !== lastMonth && !sunday.isFuture) {
      monthRow += MONTH_LABELS[sunday.month];
      lastMonth = sunday.month;
    } else {
      monthRow += " ";
    }
  }

  const lines = [];
  lines.push(`     ${monthRow}`);
  for (let d = 0; d < 7; d++) {
    const label = d % 2 === 1 ? WEEKDAY_LABELS[d] : "   ";
    let row = "";
    for (const week of weeksArr) row += glyphFor(week[d]);
    lines.push(`${label.padEnd(5)}${row}`);
  }
  lines.push("");
  lines.push(`Less ${LEVEL_GLYPHS.join(" ")} More`);
  return lines.join("\n");
}

function badge(label, value, color) {
  const enc = (s) => encodeURIComponent(String(s).replace(/-/g, "--").replace(/_/g, "__"));
  return `![${label}](https://img.shields.io/badge/${enc(label)}-${enc(value)}-${color}?style=for-the-badge)`;
}

function bucketKeyOf(r) {
  return r.mode === "time" || r.mode === "words" ? `${r.mode}:${r.mode2}` : r.mode;
}

function personalBestsTable(personalBests) {
  const keys = MH.sortedBucketKeys(personalBests);
  if (keys.length === 0) return "_No tests recorded yet - finish a test on monkeytype.com to get started._";

  const rows = keys.map((key) => {
    const r = personalBests[key];
    const acc = `${MH.round1(r.acc)}%`;
    const cons = typeof r.consistency === "number" ? `${MH.round1(r.consistency)}%` : "—";
    const date = new Date(r.timestamp).toISOString().slice(0, 10);
    return `| ${MH.bucketLabel(key)} | **${MH.round1(r.wpm)}** | ${MH.round1(r.rawWpm)} | ${acc} | ${cons} | ${date} |`;
  });
  return [
    "| Mode | WPM | Raw | Accuracy | Consistency | Date |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function recentTestsTable(recent) {
  if (recent.length === 0) return "_Nothing yet._";
  const rows = recent.slice(0, 10).map((r) => {
    const when = new Date(r.timestamp).toISOString().replace("T", " ").slice(0, 16);
    const mods = [r.punctuation ? "punctuation" : null, r.numbers ? "numbers" : null]
      .filter(Boolean)
      .join(", ") || "—";
    return `| ${when} UTC | ${MH.bucketLabel(bucketKeyOf(r))} | ${MH.round1(r.wpm)} | ${MH.round1(r.acc)}% | ${mods} |`;
  });
  return [
    "| When | Mode | WPM | Accuracy | Modifiers |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

/**
 * @param {object} stats   output of MH.computeStats(results)
 * @param {object} user    { login, name, avatarUrl } from GitHub, or null
 * @param {object} config  the sync config (used for the data-file self-link)
 */
MH.generateReadme = function generateReadme(stats, user, config) {
  const title = (user && (user.name || user.login)) || "My";
  const generatedAt = `${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`;

  const badges = [
    badge("tests typed", stats.totalTests, "1B1E27"),
    stats.bestWpm ? badge("best wpm", MH.round1(stats.bestWpm.wpm), "F5C453") : "",
    stats.totalTests ? badge("avg accuracy", `${stats.avgAcc}%`, "5FD1A4") : "",
    stats.streak.current ? badge("streak", `${stats.streak.current} days`, "EF6F6C") : "",
  ]
    .filter(Boolean)
    .join(" ");

  const overviewRows = [
    ["Tests completed", stats.totalTests],
    ["Time spent typing", MH.formatDuration(stats.totalTimeTypedSeconds)],
    ["Average WPM", stats.avgWpm],
    ["Average accuracy", `${stats.avgAcc}%`],
    ["Average consistency", stats.avgConsistency !== null ? `${stats.avgConsistency}%` : "—"],
    [
      "Best single test",
      stats.bestWpm ? `${MH.round1(stats.bestWpm.wpm)} wpm (${MH.bucketLabel(bucketKeyOf(stats.bestWpm))})` : "—",
    ],
    ["Highest accuracy", stats.bestAcc ? `${MH.round1(stats.bestAcc.acc)}%` : "—"],
    ["Highest consistency", stats.bestConsistency ? `${MH.round1(stats.bestConsistency.consistency)}%` : "—"],
    ["Current streak", `${stats.streak.current} day${stats.streak.current === 1 ? "" : "s"}`],
    ["Longest streak", `${stats.streak.longest} day${stats.streak.longest === 1 ? "" : "s"}`],
    ["First test on record", stats.firstTestAt ? new Date(stats.firstTestAt).toISOString().slice(0, 10) : "—"],
  ];
  const overviewTable = [
    "| Stat | Value |",
    "| --- | --- |",
    ...overviewRows.map(([k, v]) => `| ${k} | ${v} |`),
  ].join("\n");

  return `# ⌨️ ${title}'s Monkeytype Stats

${badges}

_Automatically generated and kept in sync by MonkeyHub - last updated **${generatedAt}**._

## Overview

${overviewTable}

## Personal bests

${personalBestsTable(stats.personalBests)}

## Activity

\`\`\`text
${renderCalendar(stats.heatmap)}
\`\`\`

## Recent tests

${recentTestsTable(stats.recent)}

---

<sub>This file is machine-generated from the raw results in <code>${config.dataDir}/</code> (split by test type). Don't edit it by hand - your changes will be overwritten on the next sync. Want to stop syncing? Remove the MonkeyHub extension or disconnect it from Settings.</sub>
`;
};

if (typeof module !== "undefined") {
  module.exports = MH;
}
