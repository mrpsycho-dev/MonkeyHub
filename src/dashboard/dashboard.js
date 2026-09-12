// MonkeyHub - dashboard controller.

const $ = (sel) => document.querySelector(sel);

function send(type, extra) {
  return MH.ext.runtime.sendMessage(Object.assign({ type }, extra));
}

function showToast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (el.hidden = true), 2400);
}

function bucketKeyOf(r) {
  return r.mode === "time" || r.mode === "words" ? `${r.mode}:${r.mode2}` : r.mode;
}

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------
document.querySelectorAll(".topnav__btn").forEach((btn) => {
  btn.addEventListener("click", () => activateSection(btn.dataset.section));
});
$("#emptyStateSettingsBtn").addEventListener("click", () => activateSection("settings"));

function activateSection(name) {
  document.querySelectorAll(".topnav__btn").forEach((b) => b.classList.toggle("is-active", b.dataset.section === name));
  document.querySelectorAll(".section").forEach((s) => s.classList.toggle("is-active", s.dataset.section === name));
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function renderCalendar(heatmapFlat) {
  const grid = $("#calGrid");
  const monthsRow = $("#calMonths");
  grid.innerHTML = "";
  monthsRow.innerHTML = "";

  let max = 1;
  for (const d of heatmapFlat) if (!d.isFuture) max = Math.max(max, d.count);
  const step = Math.max(1, Math.ceil(max / 4));

  const weeks = MH.groupIntoWeeks(heatmapFlat);
  let lastMonth = -1;
  weeks.forEach((week, w) => {
    const sunday = week[0];
    const label = document.createElement("span");
    label.style.gridColumnStart = w + 1;
    if (sunday.month !== lastMonth && !sunday.isFuture) {
      label.textContent = MONTHS[sunday.month];
      lastMonth = sunday.month;
    }
    monthsRow.appendChild(label);

    week.forEach((day) => {
      const cell = document.createElement("div");
      cell.className = "calendar-cell";
      if (!day.isFuture) {
        const level = day.count === 0 ? 0 : Math.min(4, Math.ceil(day.count / step));
        cell.dataset.level = String(level);
        cell.title = `${day.count} test${day.count === 1 ? "" : "s"} on ${day.date}`;
      } else {
        cell.style.visibility = "hidden";
      }
      grid.appendChild(cell);
    });
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function initialsAvatar(name) {
  const letter = (name || "?").trim().charAt(0).toUpperCase() || "?";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="%23232733"/><text x="32" y="42" font-family="sans-serif" font-size="28" font-weight="700" fill="%23F5C453" text-anchor="middle">${letter}</text></svg>`;
  return `data:image/svg+xml,${svg}`;
}

function render(state) {
  const { auth, config, stats, syncState, log } = state;

  const pill = $("#connPill");
  if (syncState.status === "error") {
    pill.dataset.state = "error";
    $("#connLabel").textContent = "Sync error";
  } else if (auth.connected) {
    pill.dataset.state = "connected";
    $("#connLabel").textContent = `@${auth.login}`;
  } else {
    pill.dataset.state = "disconnected";
    $("#connLabel").textContent = "Not connected";
  }

  const banner = $("#errorBanner");
  if (syncState.status === "error" && syncState.lastError) {
    banner.hidden = false;
    $("#errorBannerText").textContent = syncState.lastError.message;
  } else {
    banner.hidden = true;
  }

  const hasAnything = auth.connected || stats.totalTests > 0;
  $("#emptyState").hidden = hasAnything;
  $("#overviewContent").style.display = hasAnything ? "" : "none";

  if (stats.bestWpm) {
    $("#heroValue").textContent = MH.round1(stats.bestWpm.wpm);
    $("#heroLabel").textContent = `Best WPM · ${MH.bucketLabel(bucketKeyOf(stats.bestWpm))}`;
  } else {
    $("#heroValue").textContent = "—";
    $("#heroLabel").textContent = "Best WPM";
  }
  $("#statTests").textContent = stats.totalTests;
  $("#statTime").textContent = MH.formatDuration(stats.totalTimeTypedSeconds);
  $("#statAvgWpm").textContent = stats.avgWpm || 0;
  $("#statAvgAcc").textContent = `${stats.avgAcc || 0}%`;
  $("#statStreak").textContent = stats.streak.current;
  $("#statLongestStreak").textContent = stats.streak.longest;

  $("#syncStatusText").textContent =
    syncState.status === "syncing" ? "Syncing..." : `Last synced ${MH.formatRelativeTime(syncState.lastSyncAt)}`;

  renderCalendar(stats.heatmap);

  // personal bests
  const bestsBody = $("#bestsBody");
  bestsBody.innerHTML = "";
  const keys = MH.sortedBucketKeys(stats.personalBests);
  if (keys.length === 0) {
    bestsBody.innerHTML = `<tr><td colspan="6" style="font-family:var(--sans);color:var(--text-dim);">No tests yet.</td></tr>`;
  }
  for (const key of keys) {
    const r = stats.personalBests[key];
    const tr = document.createElement("tr");
    tr.innerHTML = `<td style="font-family:var(--sans);">${MH.bucketLabel(key)}</td><td>${MH.round1(r.wpm)}</td><td>${MH.round1(r.rawWpm)}</td><td>${MH.round1(r.acc)}%</td><td>${typeof r.consistency === "number" ? MH.round1(r.consistency) + "%" : "—"}</td><td>${new Date(r.timestamp).toLocaleDateString()}</td>`;
    bestsBody.appendChild(tr);
  }

  // recent tests
  const recentBody = $("#recentBody");
  recentBody.innerHTML = "";
  if (stats.recent.length === 0) {
    recentBody.innerHTML = `<tr><td colspan="4" style="font-family:var(--sans);color:var(--text-dim);">Nothing yet.</td></tr>`;
  }
  for (const r of stats.recent) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td style="font-family:var(--sans);">${new Date(r.timestamp).toLocaleString()}</td><td style="font-family:var(--sans);">${MH.bucketLabel(bucketKeyOf(r))}</td><td>${MH.round1(r.wpm)}</td><td>${MH.round1(r.acc)}%</td>`;
    recentBody.appendChild(tr);
  }

  // log
  const logList = $("#logList");
  logList.innerHTML = "";
  if (!log || log.length === 0) {
    logList.innerHTML = `<li class="log__empty">No activity yet.</li>`;
  }
  for (const entry of log || []) {
    const li = document.createElement("li");
    li.dataset.kind = entry.type;
    const time = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    li.innerHTML = `<time>${time}</time><span class="dot"></span><span>${escapeHtml(entry.message)}</span>`;
    logList.appendChild(li);
  }

  // settings
  $("#authCardConnected").hidden = !auth.connected;
  $("#authCardDisconnected").hidden = auth.connected;
  if (auth.connected) {
    $("#accountAvatar").src = auth.avatarUrl || initialsAvatar(auth.name || auth.login);
    $("#accountName").textContent = auth.name || auth.login;
    $("#accountMode").textContent = auth.mode === "oauth" ? "Connected via OAuth2 + PKCE" : "Connected via Personal Access Token";
  }

  const setIfNotFocused = (id, value) => {
    const el = document.getElementById(id);
    if (document.activeElement !== el) el.value = value;
  };
  setIfNotFocused("cfgOwner", config.owner || "");
  setIfNotFocused("cfgRepo", config.repo || "");
  setIfNotFocused("cfgBranch", config.branch || "");
  setIfNotFocused("cfgDataPath", config.dataPath || "");
  setIfNotFocused("cfgReadmePath", config.readmePath || "");
  $("#cfgVisibility").value = config.visibility || "public";
  $("#cfgCreateIfMissing").checked = !!config.createIfMissing;
  $("#cfgAutoSync").checked = !!config.autoSync;
  $("#cfgNotifyOnError").checked = !!config.notifyOnError;
  setIfNotFocused("oauthClientId", config.oauthClientId || "");
  setIfNotFocused("proxyUrl", config.proxyUrl || "");
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

async function refresh() {
  const res = await send("MH_GET_STATE");
  if (res && res.ok) render(res.state);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
$("#syncNowBtn").addEventListener("click", async () => {
  $("#syncNowBtn").disabled = true;
  await send("MH_SYNC_NOW");
  $("#syncNowBtn").disabled = false;
  refresh();
  showToast("Sync requested");
});
$("#retryBtn").addEventListener("click", () => send("MH_SYNC_NOW").then(refresh));

$("#signOutBtn").addEventListener("click", async () => {
  await send("MH_SIGN_OUT");
  showToast("Disconnected from GitHub");
  refresh();
});

$("#connectOAuthBtn").addEventListener("click", async () => {
  const clientId = $("#oauthClientId").value.trim();
  const proxyUrl = $("#proxyUrl").value.trim();
  if (!clientId) return showToast("Enter your OAuth App's Client ID first");
  await send("MH_UPDATE_CONFIG", { partial: { oauthClientId: clientId, proxyUrl } });
  $("#connectOAuthBtn").disabled = true;
  $("#connectOAuthBtn").textContent = "Waiting for GitHub...";
  const res = await send("MH_SIGN_IN_OAUTH", { payload: { clientId, proxyUrl } });
  $("#connectOAuthBtn").disabled = false;
  $("#connectOAuthBtn").textContent = "Connect with GitHub";
  if (!res.ok) return showToast(res.error || "Couldn't connect to GitHub");
  showToast(`Connected as @${res.user.login}`);
  refresh();
});

$("#connectPatBtn").addEventListener("click", async () => {
  const token = $("#patInput").value.trim();
  if (!token) return showToast("Paste a token first");
  $("#connectPatBtn").disabled = true;
  const res = await send("MH_SIGN_IN_PAT", { token });
  $("#connectPatBtn").disabled = false;
  if (!res.ok) return showToast(res.error || "That token didn't work");
  $("#patInput").value = "";
  showToast(`Connected as @${res.user.login}`);
  refresh();
});

function bindConfigField(id, key) {
  const el = document.getElementById(id);
  const isCheckbox = el.type === "checkbox";
  el.addEventListener(isCheckbox ? "change" : "blur", async () => {
    const value = isCheckbox ? el.checked : el.value.trim();
    await send("MH_UPDATE_CONFIG", { partial: { [key]: value } });
    showToast("Saved");
    refresh();
  });
}
[
  ["cfgOwner", "owner"],
  ["cfgRepo", "repo"],
  ["cfgBranch", "branch"],
  ["cfgDataPath", "dataPath"],
  ["cfgReadmePath", "readmePath"],
  ["cfgVisibility", "visibility"],
  ["cfgCreateIfMissing", "createIfMissing"],
  ["cfgAutoSync", "autoSync"],
  ["cfgNotifyOnError", "notifyOnError"],
  ["oauthClientId", "oauthClientId"],
  ["proxyUrl", "proxyUrl"],
].forEach(([id, key]) => bindConfigField(id, key));

$("#exportBtn").addEventListener("click", async () => {
  const res = await send("MH_EXPORT_DATA");
  if (!res.ok) return showToast("Export failed");
  const blob = new Blob([res.json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "monkeyhub-export.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const res = await send("MH_IMPORT_DATA", { json: text });
  if (!res.ok) return showToast("Import failed - is that a MonkeyHub export?");
  showToast(`Imported - ${res.count} results total`);
  refresh();
  e.target.value = "";
});

$("#clearBtn").addEventListener("click", async () => {
  if (!confirm("Clear all locally stored results? This won't touch what's already on GitHub.")) return;
  await send("MH_CLEAR_DATA");
  showToast("Local data cleared");
  refresh();
});

refresh();
setInterval(refresh, 4000);
