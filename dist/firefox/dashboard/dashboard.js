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

let forceShowClientIdField = false;

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
  clearChildren(grid);
  clearChildren(monthsRow);

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
  clearChildren(bestsBody);
  const keys = MH.sortedBucketKeys(stats.personalBests);
  if (keys.length === 0) {
    bestsBody.appendChild(emptyRow(6, "No tests yet."));
  }
  for (const key of keys) {
    const r = stats.personalBests[key];
    const tr = document.createElement("tr");
    appendCell(tr, MH.bucketLabel(key), true);
    appendCell(tr, String(MH.round1(r.wpm)));
    appendCell(tr, String(MH.round1(r.rawWpm)));
    appendCell(tr, `${MH.round1(r.acc)}%`);
    appendCell(tr, typeof r.consistency === "number" ? `${MH.round1(r.consistency)}%` : "—");
    appendCell(tr, new Date(r.timestamp).toLocaleDateString());
    bestsBody.appendChild(tr);
  }

  // recent tests
  const recentBody = $("#recentBody");
  clearChildren(recentBody);
  if (stats.recent.length === 0) {
    recentBody.appendChild(emptyRow(4, "Nothing yet."));
  }
  for (const r of stats.recent) {
    const tr = document.createElement("tr");
    appendCell(tr, new Date(r.timestamp).toLocaleString(), true);
    appendCell(tr, MH.bucketLabel(bucketKeyOf(r)), true);
    appendCell(tr, String(MH.round1(r.wpm)));
    appendCell(tr, `${MH.round1(r.acc)}%`);
    recentBody.appendChild(tr);
  }

  // log
  const logList = $("#logList");
  clearChildren(logList);
  if (!log || log.length === 0) {
    const li = document.createElement("li");
    li.className = "log__empty";
    li.textContent = "No activity yet.";
    logList.appendChild(li);
  }
  for (const entry of log || []) {
    const li = document.createElement("li");
    li.dataset.kind = entry.type;
    const time = document.createElement("time");
    time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const dot = document.createElement("span");
    dot.className = "dot";
    const msg = document.createElement("span");
    msg.textContent = entry.message;
    li.append(time, dot, msg);
    logList.appendChild(li);
  }

  // settings
  $("#authCardConnected").hidden = !auth.connected;
  $("#authCardDisconnected").hidden = auth.connected;
  if (auth.connected) {
    $("#accountAvatar").src = auth.avatarUrl || initialsAvatar(auth.name || auth.login);
    $("#accountName").textContent = auth.name || auth.login;
    $("#accountMode").textContent = auth.mode === "oauth" ? "Connected via GitHub sign-in" : "Connected via Personal Access Token";
  }
  renderDeviceFlow(state.deviceFlow);

  const setIfNotFocused = (id, value) => {
    const el = document.getElementById(id);
    if (document.activeElement !== el) el.value = value;
  };
  setIfNotFocused("cfgOwner", config.owner || "");
  setIfNotFocused("cfgRepo", config.repo || "");
  setIfNotFocused("cfgBranch", config.branch || "");
  setIfNotFocused("cfgDataDir", config.dataDir || "");
  setIfNotFocused("cfgReadmePath", config.readmePath || "");
  $("#cfgVisibility").value = config.visibility || "public";
  $("#cfgCreateIfMissing").checked = !!config.createIfMissing;
  $("#cfgAutoSync").checked = !!config.autoSync;
  $("#cfgNotifyOnError").checked = !!config.notifyOnError;

  const haveClientId = !!config.oauthClientId;
  const showClientIdField = forceShowClientIdField || !haveClientId;
  $("#clientIdField").hidden = !showClientIdField;
  $("#useOwnClientIdBtn").hidden = !haveClientId || forceShowClientIdField;
  setIfNotFocused("oauthClientId", config.oauthClientId || "");
  $("#authIntroText").textContent = haveClientId && !forceShowClientIdField
    ? "One-click sign-in - no secrets, no proxy, nothing to fill in."
    : "One-click sign-in - no secrets, no proxy, no redirect URI to register. First time only: create a free GitHub OAuth App and paste its Client ID below (see README, takes about a minute).";
}

function renderDeviceFlow(deviceFlow) {
  const panel = $("#deviceFlowPanel");
  if (!deviceFlow || deviceFlow.status !== "pending") {
    panel.hidden = true;
    $("#connectOAuthBtn").disabled = false;
    if (deviceFlow && deviceFlow.status === "error" && deviceFlow.message && renderDeviceFlow._lastShown !== deviceFlow.message) {
      renderDeviceFlow._lastShown = deviceFlow.message;
      showToast(deviceFlow.message);
    }
    if (deviceFlow && deviceFlow.status === "success" && renderDeviceFlow._lastShown !== "success:" + deviceFlow.login) {
      renderDeviceFlow._lastShown = "success:" + deviceFlow.login;
      showToast(`Connected as @${deviceFlow.login}`);
    }
    return;
  }
  renderDeviceFlow._lastShown = null;
  panel.hidden = false;
  $("#connectOAuthBtn").disabled = true;
  $("#deviceUserCode").textContent = deviceFlow.userCode;
  $("#openDeviceVerifyBtn").href = deviceFlow.verificationUriComplete || deviceFlow.verificationUri;
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function appendCell(tr, text, useSansFont) {
  const td = document.createElement("td");
  td.textContent = text;
  if (useSansFont) td.style.fontFamily = "var(--sans)";
  tr.appendChild(td);
}

function emptyRow(colspan, text) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = colspan;
  td.style.fontFamily = "var(--sans)";
  td.style.color = "var(--text-dim)";
  td.textContent = text;
  tr.appendChild(td);
  return tr;
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

$("#useOwnClientIdBtn").addEventListener("click", () => {
  forceShowClientIdField = true;
  refresh();
});

$("#connectOAuthBtn").addEventListener("click", async () => {
  const clientId = $("#oauthClientId").value.trim();
  if (!clientId) return showToast("Enter your OAuth App's Client ID first");
  await send("MH_UPDATE_CONFIG", { partial: { oauthClientId: clientId } });
  $("#connectOAuthBtn").disabled = true;
  const res = await send("MH_START_DEVICE_FLOW", { clientId });
  if (!res.ok) {
    $("#connectOAuthBtn").disabled = false;
    return showToast(res.error || "Couldn't start GitHub sign-in");
  }
  MH.ext.tabs.create({ url: res.state.verificationUriComplete || res.state.verificationUri });
  refresh();
});

$("#copyDeviceCodeBtn").addEventListener("click", async () => {
  const code = $("#deviceUserCode").textContent;
  try {
    await navigator.clipboard.writeText(code);
    showToast("Code copied");
  } catch (_) {
    showToast("Couldn't copy - select and copy manually");
  }
});

$("#cancelDeviceFlowBtn").addEventListener("click", async () => {
  await send("MH_CANCEL_DEVICE_FLOW");
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
  ["cfgDataDir", "dataDir"],
  ["cfgReadmePath", "readmePath"],
  ["cfgVisibility", "visibility"],
  ["cfgCreateIfMissing", "createIfMissing"],
  ["cfgAutoSync", "autoSync"],
  ["cfgNotifyOnError", "notifyOnError"],
  ["oauthClientId", "oauthClientId"],
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
