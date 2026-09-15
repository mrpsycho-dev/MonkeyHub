// MonkeyHub - popup controller.

const $ = (sel) => document.querySelector(sel);

function send(type, extra) {
  return MH.ext.runtime.sendMessage(Object.assign({ type }, extra));
}

function showToast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (el.hidden = true), 2200);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll(".tabs__btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs__btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.dataset.view === btn.dataset.tab));
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function bucketKeyOf(r) {
  return r.mode === "time" || r.mode === "words" ? `${r.mode}:${r.mode2}` : r.mode;
}

let forceShowClientIdField = false;

function initialsAvatar(name) {
  const letter = (name || "?").trim().charAt(0).toUpperCase() || "?";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="%23232733"/><text x="32" y="42" font-family="sans-serif" font-size="28" font-weight="700" fill="%23F5C453" text-anchor="middle">${letter}</text></svg>`;
  return `data:image/svg+xml,${svg}`;
}

function render(state) {
  const { auth, config, stats, syncState } = state;

  // connection pill
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

  // error banner
  const banner = $("#errorBanner");
  if (syncState.status === "error" && syncState.lastError) {
    banner.hidden = false;
    $("#errorBannerText").textContent = syncState.lastError.message;
  } else {
    banner.hidden = true;
  }

  // hero
  if (stats.bestWpm) {
    $("#heroValue").textContent = MH.round1(stats.bestWpm.wpm);
    $("#heroLabel").textContent = `Best WPM - ${MH.bucketLabel(bucketKeyOf(stats.bestWpm))}`;
  } else {
    $("#heroValue").textContent = "—";
    $("#heroLabel").textContent = "Complete a test on monkeytype.com to get started";
  }

  $("#statTests").textContent = stats.totalTests;
  $("#statAvgWpm").textContent = stats.avgWpm || 0;
  $("#statAvgAcc").textContent = `${stats.avgAcc || 0}%`;
  $("#statStreak").textContent = stats.streak.current;

  // sync line
  const syncText = $("#syncStatusText");
  if (syncState.status === "syncing") {
    syncText.textContent = "Syncing...";
  } else {
    syncText.textContent = `Last synced ${MH.formatRelativeTime(syncState.lastSyncAt)}`;
  }
  const repoLink = $("#repoLink");
  const owner = (config.owner && config.owner.trim()) || (auth && auth.login) || "";
  if (owner && config.repo) {
    repoLink.href = `https://github.com/${owner}/${config.repo}`;
    repoLink.textContent = `${owner}/${config.repo}`;
    repoLink.hidden = false;
  } else {
    repoLink.hidden = true;
  }

  // settings: auth cards
  $("#authCardConnected").hidden = !auth.connected;
  $("#authCardDisconnected").hidden = auth.connected;
  if (auth.connected) {
    $("#accountAvatar").src = auth.avatarUrl || initialsAvatar(auth.name || auth.login);
    $("#accountName").textContent = auth.name || auth.login;
    $("#accountMode").textContent = auth.mode === "oauth" ? "Connected via GitHub sign-in" : "Connected via Personal Access Token";
  }
  renderDeviceFlow(state.deviceFlow);

  // settings: config fields (only set if the user isn't actively typing in them)
  const setIfNotFocused = (id, value) => {
    const el = document.getElementById(id);
    if (document.activeElement !== el) el.value = value;
  };
  setIfNotFocused("cfgOwner", config.owner || "");
  setIfNotFocused("cfgRepo", config.repo || "");
  setIfNotFocused("cfgBranch", config.branch || "");
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
    : "One-click sign-in, no secrets or proxy needed. First time only: paste your GitHub OAuth App's Client ID (create one free, takes a minute - see README).";
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
});
$("#retryBtn").addEventListener("click", () => send("MH_SYNC_NOW").then(refresh));

$("#openDashboardBtn").addEventListener("click", () => {
  MH.ext.tabs.create({ url: MH.ext.runtime.getURL("dashboard/dashboard.html") });
});

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
    showToast(res.error || "Couldn't start GitHub sign-in");
    return;
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
  if (!res.ok) {
    showToast(res.error || "That token didn't work");
    return;
  }
  $("#patInput").value = "";
  showToast(`Connected as @${res.user.login}`);
  refresh();
});

function bindConfigField(id, key, transform) {
  const el = document.getElementById(id);
  const isCheckbox = el.type === "checkbox";
  el.addEventListener(isCheckbox ? "change" : "blur", async () => {
    const raw = isCheckbox ? el.checked : el.value.trim();
    const value = transform ? transform(raw) : raw;
    await send("MH_UPDATE_CONFIG", { partial: { [key]: value } });
    showToast("Saved");
    refresh();
  });
}

bindConfigField("cfgOwner", "owner");
bindConfigField("cfgRepo", "repo");
bindConfigField("cfgBranch", "branch");
bindConfigField("cfgVisibility", "visibility");
bindConfigField("cfgCreateIfMissing", "createIfMissing");
bindConfigField("cfgAutoSync", "autoSync");
bindConfigField("cfgNotifyOnError", "notifyOnError");
bindConfigField("oauthClientId", "oauthClientId");

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

$("#clearBtn").addEventListener("click", async () => {
  if (!confirm("Clear all locally stored results? This won't touch what's already on GitHub.")) return;
  await send("MH_CLEAR_DATA");
  showToast("Local data cleared");
  refresh();
});

refresh();
setInterval(refresh, 4000);
