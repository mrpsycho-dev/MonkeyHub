// MonkeyHub - background service worker.
//
// This is the only place that talks to GitHub. It:
//   - receives captured results from content.js and merges them into the
//     durable local store (chrome.storage.local IS the pending queue - a
//     result is never lost just because a sync attempt fails)
//   - debounces bursts of captures into a single sync, and writes every
//     changed file (per-mode data files + README) as ONE commit via the
//     Git Data API - never one commit per file
//   - drives GitHub's device-flow sign-in (no client secret, no proxy, no
//     redirect URI - see lib/oauth.js)
//   - answers state queries from the popup/dashboard
//   - retries on a timer via chrome.alarms, since MV3 service workers can be
//     killed between events and a bare setTimeout would not survive that

// Chrome's MV3 service worker needs each lib loaded via importScripts.
// Firefox's `background.scripts` array (see manifest.firefox.json) loads
// the same files as ordinary classic scripts before this one runs, so
// `importScripts` doesn't exist there - this guard keeps a single
// background.js source working unmodified on both.
if (typeof importScripts === "function") {
  importScripts(
    "lib/constants.js",
    "lib/browser-api.js",
    "lib/util.js",
    "lib/storage.js",
    "lib/github-client.js",
    "lib/stats.js",
    "lib/readme-generator.js",
    "lib/oauth.js"
  );
}

let syncInFlight = false;
let syncQueuedAgain = false;
let syncDebounceTimer = null;

function resolveOwner(config, auth) {
  return (config.owner && config.owner.trim()) || (auth && auth.login) || "";
}

function setBadge(kind) {
  try {
    const action = MH.ext.action || MH.ext.browserAction;
    if (!action) return;
    if (kind === "error") {
      action.setBadgeBackgroundColor({ color: "#EF6F6C" });
      action.setBadgeText({ text: "!" });
    } else if (kind === "syncing") {
      action.setBadgeBackgroundColor({ color: "#F5C453" });
      action.setBadgeText({ text: "\u2022" });
    } else {
      action.setBadgeText({ text: "" });
    }
  } catch (_) {
    /* badge API not available on this platform - non-fatal */
  }
}

async function notifyError(title, message) {
  const config = await MH.getConfig();
  if (!config.notifyOnError) return;
  try {
    await MH.callApi(MH.ext.notifications, "create", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
    });
  } catch (_) {
    /* notifications permission or platform support may be absent */
  }
}

// ---------------------------------------------------------------------------
// Capture handling
// ---------------------------------------------------------------------------

function normalizeCaptured(raw) {
  return Object.assign(
    {
      timestamp: Date.now(),
      wpm: 0,
      rawWpm: 0,
      acc: 0,
      consistency: null,
      mode: "unknown",
      mode2: "",
      language: "english",
      punctuation: false,
      numbers: false,
      difficulty: "normal",
      charStats: null,
      testDuration: null,
      source: "dom",
    },
    raw
  );
}

/** Schedules a sync a few seconds out instead of running one immediately,
 * so several tests finished in quick succession land in one commit instead
 * of one commit each. Repeated calls simply push the timer back. */
function scheduleSync() {
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => {
    syncDebounceTimer = null;
    runSync().catch((e) => console.error("[MonkeyHub] auto-sync failed", e));
  }, MH.SYNC_DEBOUNCE_MS);
}

async function handleCapturedResult(rawResult) {
  const result = normalizeCaptured(rawResult);
  result.id = MH.resultId(result);

  const store = await MH.getResultsStore();
  const existingById = store.results.find((r) => r.id === result.id);
  if (existingById) {
    await MH.appendLog({ type: "capture_duplicate", message: "Ignored an exact duplicate capture." });
    return { deduped: true };
  }

  // Near-duplicate guard: the DOM scraper and the network sniffer can both
  // fire for the same test (by design - see content.js). Prefer whichever
  // capture carries richer data instead of storing both.
  const nearDuplicateIdx = store.results.findIndex(
    (r) =>
      r.mode === result.mode &&
      r.mode2 === result.mode2 &&
      Math.abs(r.wpm - result.wpm) < 0.5 &&
      Math.abs(r.acc - result.acc) < 0.5 &&
      Math.abs(r.timestamp - result.timestamp) < 10000
  );
  if (nearDuplicateIdx !== -1) {
    const existing = store.results[nearDuplicateIdx];
    if (existing.source === "network" || result.source === "dom") {
      await MH.appendLog({ type: "capture_duplicate", message: "Ignored a near-duplicate capture (kept the richer one)." });
      return { deduped: true };
    }
    store.results[nearDuplicateIdx] = result; // network result superseding an earlier dom one
  } else {
    store.results.push(result);
  }

  store.results.sort((a, b) => a.timestamp - b.timestamp);
  await MH.setResultsStore(store);
  await MH.appendLog({
    type: "capture",
    message: `Captured ${MH.bucketLabel(result.mode === "time" || result.mode === "words" ? `${result.mode}:${result.mode2}` : result.mode)} - ${MH.round1(result.wpm)} wpm / ${MH.round1(result.acc)}% (${result.source})`,
  });

  const config = await MH.getConfig();
  if (config.autoSync) scheduleSync();
  return { deduped: false, result };
}

// ---------------------------------------------------------------------------
// Sync engine
// ---------------------------------------------------------------------------

function dataFilePath(config, mode) {
  return `${config.dataDir.replace(/\/+$/, "")}/${mode}.json`;
}

function buildCommitMessage(changedModes, total) {
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  const modesPart = changedModes.length ? ` (${changedModes.join(", ")})` : "";
  return `MonkeyHub: sync${modesPart} - ${total} total result${total === 1 ? "" : "s"} (${now} UTC)`;
}

async function runSync({ isRetry = false } = {}) {
  if (syncInFlight) {
    syncQueuedAgain = true;
    return { queued: true };
  }
  // Defends against MV3 service worker restarts: the in-memory
  // `syncInFlight` flag above only protects against overlap *within one
  // worker lifetime*. If the worker was recycled mid-sync, a fresh
  // instance's `syncInFlight` starts back at `false` even though a sync
  // might still be genuinely in flight (or, more likely, died silently
  // without ever clearing its status). A `syncing` status younger than
  // this is treated as still active; older than it is treated as
  // abandoned and safe to supersede.
  const STALE_LOCK_MS = 45000;
  const existingState = await MH.getSyncState();
  if (existingState.status === "syncing" && existingState.syncLockAt && Date.now() - existingState.syncLockAt < STALE_LOCK_MS) {
    syncQueuedAgain = true;
    return { queued: true };
  }

  syncInFlight = true;
  setBadge("syncing");
  await MH.setSyncState({ status: "syncing", syncLockAt: Date.now() });

  try {
    const auth = await MH.getAuth();
    if (!auth || !auth.accessToken) {
      await MH.setSyncState({ status: "error", lastError: { kind: "no_auth", message: "Not connected to GitHub yet.", at: Date.now() } });
      setBadge("idle");
      return { ok: false, kind: "no_auth" };
    }

    let config = await MH.getConfig();
    const owner = resolveOwner(config, auth);
    const repo = (config.repo || "").trim();
    if (!owner || !repo) {
      await MH.setSyncState({ status: "error", lastError: { kind: "no_repo", message: "Set a repository name in Settings.", at: Date.now() } });
      setBadge("error");
      return { ok: false, kind: "no_repo" };
    }

    // 1. Ensure the repository exists ------------------------------------------------
    let repoInfo;
    try {
      repoInfo = await MH.gh.repoExists(auth, owner, repo);
    } catch (err) {
      return await handleSyncError(err, isRetry);
    }

    if (!repoInfo.exists) {
      if (!config.createIfMissing) {
        await MH.setSyncState({ status: "error", lastError: { kind: "repo_missing", message: `Repository ${owner}/${repo} doesn't exist and auto-create is off.`, at: Date.now() } });
        setBadge("error");
        return { ok: false, kind: "repo_missing" };
      }
      try {
        const created = await MH.gh.createRepo(auth, { name: repo, isPrivate: config.visibility === "private" });
        await MH.appendLog({ type: "repo_created", message: `Created repository ${created.full_name}.` });
        if (created.default_branch && created.default_branch !== config.branch) {
          config = await MH.setConfig({ branch: created.default_branch });
          await MH.appendLog({ type: "branch_adjusted", message: `Using the repo's default branch "${created.default_branch}".` });
        }
      } catch (err) {
        if (err.kind === MH.KIND.UNPROCESSABLE) {
          await MH.setSyncState({ status: "error", lastError: { kind: "repo_create_conflict", message: err.friendly || err.message, at: Date.now() } });
          await notifyError("MonkeyHub couldn't create your repo", err.friendly || err.message);
          setBadge("error");
          return { ok: false, kind: "repo_create_conflict" };
        }
        return await handleSyncError(err, isRetry);
      }
    }

    // 2. Reconcile each non-empty per-mode data file with GitHub ---------------------
    // Always read fresh (no cached sha/etag carried between syncs) so a
    // changed token, a manual edit on GitHub, or a second device never
    // collides with stale state MonkeyHub remembered from earlier.
    const local = await MH.getResultsStore();
    const localBuckets = MH.groupResultsByMode(local.results);
    const changedModes = Object.keys(localBuckets).filter((mode) => localBuckets[mode].length > 0);

    const files = [];
    let mergedAll = [];
    try {
      for (const mode of changedModes) {
        const path = dataFilePath(config, mode);
        const remote = await MH.gh.getFile(auth, owner, repo, path, config.branch);
        let remoteResults = [];
        if (remote.exists) {
          try {
            const parsed = JSON.parse(remote.text);
            remoteResults = Array.isArray(parsed.results) ? parsed.results : [];
          } catch (_) {
            await MH.appendLog({ type: "remote_parse_warning", message: `${path} wasn't valid JSON on GitHub - overwriting with local data.` });
          }
        }
        const merged = MH.mergeResults(remoteResults, localBuckets[mode]);
        mergedAll = mergedAll.concat(merged);
        files.push({
          path,
          content: JSON.stringify(
            { version: 1, generatedBy: "MonkeyHub", mode, generatedAt: new Date().toISOString(), results: merged },
            null,
            2
          ),
        });
      }
    } catch (err) {
      return await handleSyncError(err, isRetry);
    }

    if (mergedAll.length !== local.results.length) {
      mergedAll.sort((a, b) => a.timestamp - b.timestamp);
      await MH.setResultsStore({ version: 1, results: mergedAll });
    }

    // 3. Regenerate the README from the full merged set -------------------------------
    const finalStore = await MH.getResultsStore();
    const finalStats = MH.computeStats(finalStore.results);
    files.push({ path: config.readmePath, content: MH.generateReadme(finalStats, auth, config) });

    // 4. One commit, everything at once ------------------------------------------------
    let commit;
    try {
      commit = await MH.gh.commitFiles(
        auth,
        owner,
        repo,
        config.branch,
        files,
        buildCommitMessage(changedModes, finalStore.results.length)
      );
    } catch (err) {
      return await handleSyncError(err, isRetry);
    }

    await MH.setSyncState({
      status: "idle",
      lastSyncAt: Date.now(),
      lastCommitSha: commit.sha,
      lastError: null,
      consecutiveFailures: 0,
    });
    await MH.appendLog({ type: "sync_success", message: `Committed ${files.length} file${files.length === 1 ? "" : "s"} (${finalStore.results.length} results total) to ${owner}/${repo}.` });
    setBadge("idle");
    return { ok: true };
  } finally {
    syncInFlight = false;
    if (syncQueuedAgain) {
      syncQueuedAgain = false;
      runSync().catch((e) => console.error("[MonkeyHub] queued sync failed", e));
    }
  }
}

async function handleSyncError(err, isRetry) {
  const kind = err.kind || MH.KIND.UNKNOWN;
  const message = MH.describeError(err);

  const syncState = await MH.getSyncState();
  await MH.setSyncState({
    status: "error",
    lastError: { kind, message, at: Date.now() },
    consecutiveFailures: (syncState.consecutiveFailures || 0) + 1,
  });
  await MH.appendLog({ type: "sync_error", message: `${kind}: ${message}` });
  setBadge("error");

  if (kind === MH.KIND.UNAUTHORIZED) {
    await notifyError("MonkeyHub needs you to reconnect", message);
  } else if (![MH.KIND.OFFLINE, MH.KIND.FORBIDDEN_SECONDARY_RATE_LIMIT, MH.KIND.SERVER_ERROR].includes(kind)) {
    // Transient kinds already retried internally by ghRequest - only
    // notify for things a retry won't fix on its own.
    await notifyError("MonkeyHub sync problem", message);
  }
  return { ok: false, kind, message };
}

// ---------------------------------------------------------------------------
// Device flow orchestration
// ---------------------------------------------------------------------------

async function startDeviceFlowAndPoll(clientId) {
  const state = await MH.oauth.startDeviceFlow({ clientId });
  // Fire-and-forget: keeps polling every `interval` seconds while this
  // service worker instance is alive. If it gets recycled mid-wait, the
  // periodic alarm below resumes polling from the persisted state.
  MH.oauth.runFastPollLoop().then(async (finalState) => {
    if (finalState && finalState.status === "success") {
      await MH.appendLog({ type: "sync_success", message: `Connected to GitHub as @${finalState.login}.` });
      scheduleSync();
    }
  }).catch((e) => console.error("[MonkeyHub] device flow poll failed", e));
  return state;
}

async function resumePendingDeviceFlowIfAny() {
  const state = await MH.oauth.getDeviceFlowState();
  if (state && state.status === "pending") {
    await MH.oauth.pollOnce();
  }
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

async function getFullState() {
  const [auth, config, store, syncState, log, deviceFlow] = await Promise.all([
    MH.getAuth(),
    MH.getConfig(),
    MH.getResultsStore(),
    MH.getSyncState(),
    MH.getLog(),
    MH.oauth.getDeviceFlowState(),
  ]);
  const stats = MH.computeStats(store.results);
  const safeAuth = auth
    ? { mode: auth.mode, login: auth.login, name: auth.name, avatarUrl: auth.avatarUrl, connected: true }
    : { connected: false };
  return { auth: safeAuth, config, stats, syncState, log, resultCount: store.results.length, deviceFlow };
}

MH.ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message && message.type) {
        case "MH_RESULT_CAPTURED": {
          const res = await handleCapturedResult(message.result);
          sendResponse({ ok: true, ...res });
          break;
        }
        case "MH_GET_STATE": {
          sendResponse({ ok: true, state: await getFullState() });
          break;
        }
        case "MH_SYNC_NOW": {
          const res = await runSync();
          sendResponse({ ok: true, result: res });
          break;
        }
        case "MH_UPDATE_CONFIG": {
          const next = await MH.setConfig(message.partial || {});
          sendResponse({ ok: true, config: next });
          break;
        }
        case "MH_START_DEVICE_FLOW": {
          const state = await startDeviceFlowAndPoll(message.clientId);
          sendResponse({ ok: true, state });
          break;
        }
        case "MH_GET_DEVICE_FLOW_STATUS": {
          const state = await MH.oauth.getDeviceFlowState();
          sendResponse({ ok: true, state });
          break;
        }
        case "MH_CANCEL_DEVICE_FLOW": {
          await MH.oauth.cancelDeviceFlow();
          sendResponse({ ok: true });
          break;
        }
        case "MH_SIGN_IN_PAT": {
          const { auth, user } = await MH.oauth.signInWithPat(message.token);
          sendResponse({ ok: true, auth, user });
          scheduleSync();
          break;
        }
        case "MH_SIGN_OUT": {
          await MH.oauth.signOut();
          sendResponse({ ok: true });
          break;
        }
        case "MH_EXPORT_DATA": {
          const store = await MH.getResultsStore();
          sendResponse({ ok: true, json: JSON.stringify(store, null, 2) });
          break;
        }
        case "MH_IMPORT_DATA": {
          const incoming = JSON.parse(message.json);
          const store = await MH.getResultsStore();
          const merged = MH.mergeResults(store.results, incoming.results || []);
          await MH.setResultsStore({ version: 1, results: merged });
          sendResponse({ ok: true, count: merged.length });
          break;
        }
        case "MH_CLEAR_DATA": {
          await MH.setResultsStore({ version: 1, results: [] });
          await MH.setSyncState(MH.DEFAULT_SYNC_STATE);
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message && message.type}` });
      }
    } catch (err) {
      console.error("[MonkeyHub] message handler error", err);
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // keep the message channel open for the async response above
});

// ---------------------------------------------------------------------------
// Lifecycle: alarms keep retrying (and resume an interrupted device-flow
// poll) even if the service worker was asleep. onInstalled opens the
// dashboard so first-run setup is discoverable.
// ---------------------------------------------------------------------------

MH.ext.runtime.onInstalled.addListener((details) => {
  MH.ext.alarms.create(MH.ALARM_NAME, { periodInMinutes: MH.ALARM_PERIOD_MINUTES });
  if (details.reason === "install") {
    MH.ext.tabs.create({ url: MH.ext.runtime.getURL("dashboard/dashboard.html") });
  }
});

MH.ext.runtime.onStartup.addListener(() => {
  MH.ext.alarms.create(MH.ALARM_NAME, { periodInMinutes: MH.ALARM_PERIOD_MINUTES });
});

MH.ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== MH.ALARM_NAME) return;
  (async () => {
    await resumePendingDeviceFlowIfAny();
    const [auth, config, syncState, store] = await Promise.all([
      MH.getAuth(),
      MH.getConfig(),
      MH.getSyncState(),
      MH.getResultsStore(),
    ]);
    if (!auth) return;
    // Retry a genuine failure, or catch up on results captured after the
    // last successful sync whose scheduled sync never actually ran (e.g.
    // the service worker was recycled mid-debounce and the setTimeout was
    // lost with it). Otherwise, nothing changed - don't sync just because
    // five minutes passed.
    const hasUnsynced = store.results.some((r) => !syncState.lastSyncAt || r.timestamp > syncState.lastSyncAt);
    if (syncState.status === "error" || (config.autoSync && hasUnsynced)) {
      runSync().catch((e) => console.error("[MonkeyHub] periodic sync failed", e));
    }
  })();
});
