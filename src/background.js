// MonkeyHub - background service worker.
//
// This is the only place that talks to GitHub. It:
//   - receives captured results from content.js and merges them into the
//     durable local store (chrome.storage.local IS the pending queue - a
//     result is never lost just because a sync attempt fails)
//   - runs the sync engine: ensure repo exists -> reconcile with remote ->
//     write data file + README -> handle every edge case from github-client.js
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
    "lib/pkce.js",
    "lib/storage.js",
    "lib/github-client.js",
    "lib/stats.js",
    "lib/readme-generator.js",
    "lib/oauth.js"
  );
}

let syncInFlight = false;
let syncQueuedAgain = false;

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
  if (config.autoSync) {
    runSync().catch((e) => console.error("[MonkeyHub] auto-sync failed", e));
  }
  return { deduped: false, result };
}

// ---------------------------------------------------------------------------
// Sync engine
// ---------------------------------------------------------------------------

function buildCommitMessage(count) {
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `MonkeyHub: sync ${count} result${count === 1 ? "" : "s"} (${now} UTC)`;
}

async function tryRefreshAuth(auth, config) {
  if (auth.mode !== "oauth" || !auth.refreshToken || !config.proxyUrl) return null;
  try {
    const refreshed = await MH.oauth.refreshAccessToken({
      proxyUrl: config.proxyUrl,
      clientId: config.oauthClientId,
      refreshToken: auth.refreshToken,
    });
    const nextAuth = Object.assign({}, auth, {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || auth.refreshToken,
      expiresAt: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : null,
    });
    await MH.setAuth(nextAuth);
    return nextAuth;
  } catch (e) {
    await MH.appendLog({ type: "auth_refresh_failed", message: e.message });
    return null;
  }
}

async function runSync({ isRetry = false } = {}) {
  if (syncInFlight) {
    syncQueuedAgain = true;
    return { queued: true };
  }
  syncInFlight = true;
  setBadge("syncing");
  await MH.setSyncState({ status: "syncing" });

  try {
    let auth = await MH.getAuth();
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

    let syncState = await MH.getSyncState();

    // 1. Ensure the repository exists ------------------------------------------------
    let repoInfo;
    try {
      repoInfo = await MH.gh.repoExists(auth, owner, repo, syncState.lastEtagRepo);
    } catch (err) {
      return await handleSyncError(err, auth, config, isRetry);
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
        return await handleSyncError(err, auth, config, isRetry);
      }
    } else if (!repoInfo.cached) {
      await MH.setSyncState({ lastEtagRepo: repoInfo.etag });
    }

    // 2. Reconcile the data file with whatever's on GitHub already ------------------
    const local = await MH.getResultsStore();
    let remoteFile;
    try {
      remoteFile = await MH.gh.getFile(auth, owner, repo, config.dataPath, config.branch, syncState.lastEtagFile);
    } catch (err) {
      return await handleSyncError(err, auth, config, isRetry);
    }

    let remoteResults = [];
    let dataSha = null;
    if (remoteFile.exists && remoteFile.cached) {
      remoteResults = local.results; // unchanged since our last read - nothing new to merge in
      dataSha = syncState.lastSha;
    } else if (remoteFile.exists) {
      dataSha = remoteFile.sha;
      try {
        const parsed = JSON.parse(remoteFile.text);
        remoteResults = Array.isArray(parsed.results) ? parsed.results : [];
      } catch (_) {
        await MH.appendLog({ type: "remote_parse_warning", message: "Remote data file wasn't valid JSON - overwriting with local data." });
        remoteResults = [];
      }
    }

    const merged = MH.mergeResults(remoteResults, local.results);
    if (merged.length !== local.results.length) {
      await MH.setResultsStore({ version: 1, results: merged });
    }

    const stats = MH.computeStats(merged);
    const dataText = JSON.stringify(
      { version: 1, generatedBy: "MonkeyHub", generatedAt: new Date().toISOString(), results: merged },
      null,
      2
    );

    // 3. Write the data file ----------------------------------------------------------
    let putDataResult;
    try {
      putDataResult = await MH.gh.putFile(
        auth,
        owner,
        repo,
        { path: config.dataPath, branch: config.branch, message: buildCommitMessage(merged.length), content: dataText, sha: dataSha },
        async () => {
          const fresh = await MH.gh.getFile(auth, owner, repo, config.dataPath, config.branch);
          const freshResults = fresh.exists ? JSON.parse(fresh.text).results || [] : [];
          const reMerged = MH.mergeResults(freshResults, merged);
          await MH.setResultsStore({ version: 1, results: reMerged });
          const retryText = JSON.stringify(
            { version: 1, generatedBy: "MonkeyHub", generatedAt: new Date().toISOString(), results: reMerged },
            null,
            2
          );
          const res = await MH.ghRequest(`/repos/${owner}/${repo}/contents/${config.dataPath}`, {
            method: "PUT",
            auth,
            body: { message: buildCommitMessage(reMerged.length), content: MH.utf8ToBase64(retryText), branch: config.branch, sha: fresh.sha },
          });
          return res.json;
        }
      );
    } catch (err) {
      return await handleSyncError(err, auth, config, isRetry);
    }

    // 4. Write the README --------------------------------------------------------------
    const finalStore = await MH.getResultsStore();
    const finalStats = MH.computeStats(finalStore.results);
    const readmeText = MH.generateReadme(finalStats, auth, config);
    let readmeSha = syncState.lastReadmeSha;
    if (!readmeSha) {
      const readmeFile = await MH.gh.getFile(auth, owner, repo, config.readmePath, config.branch).catch(() => ({ exists: false }));
      readmeSha = readmeFile.exists ? readmeFile.sha : null;
    }
    let putReadmeResult;
    try {
      putReadmeResult = await MH.gh.putFile(
        auth,
        owner,
        repo,
        { path: config.readmePath, branch: config.branch, message: "MonkeyHub: update stats README", content: readmeText, sha: readmeSha },
        async () => {
          const fresh = await MH.gh.getFile(auth, owner, repo, config.readmePath, config.branch);
          const res = await MH.ghRequest(`/repos/${owner}/${repo}/contents/${config.readmePath}`, {
            method: "PUT",
            auth,
            body: { message: "MonkeyHub: update stats README", content: MH.utf8ToBase64(readmeText), branch: config.branch, sha: fresh.sha },
          });
          return res.json;
        }
      );
    } catch (err) {
      return await handleSyncError(err, auth, config, isRetry);
    }

    await MH.setSyncState({
      status: "idle",
      lastSyncAt: Date.now(),
      lastSha: putDataResult.content.sha,
      lastReadmeSha: putReadmeResult.content.sha,
      lastEtagFile: null, // content just changed under us; drop the etag rather than risk a stale 304 next time
      lastError: null,
      consecutiveFailures: 0,
    });
    await MH.appendLog({ type: "sync_success", message: `Synced ${merged.length} results to ${owner}/${repo}.` });
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

async function handleSyncError(err, auth, config, isRetry) {
  const kind = err.kind || MH.KIND.UNKNOWN;
  const message = MH.describeError(err);

  if (kind === MH.KIND.UNAUTHORIZED && !isRetry) {
    const refreshed = await tryRefreshAuth(auth, config);
    if (refreshed) {
      syncInFlight = false; // allow the retry below to actually run
      return runSync({ isRetry: true });
    }
  }

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
// Message router
// ---------------------------------------------------------------------------

async function getFullState() {
  const [auth, config, store, syncState, log] = await Promise.all([
    MH.getAuth(),
    MH.getConfig(),
    MH.getResultsStore(),
    MH.getSyncState(),
    MH.getLog(),
  ]);
  const stats = MH.computeStats(store.results);
  const safeAuth = auth ? { mode: auth.mode, login: auth.login, name: auth.name, avatarUrl: auth.avatarUrl, connected: true } : { connected: false };
  return { auth: safeAuth, config, stats, syncState, log, resultCount: store.results.length };
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
        case "MH_SIGN_IN_OAUTH": {
          const { auth, user } = await MH.oauth.signInWithOAuth(message.payload);
          sendResponse({ ok: true, auth, user });
          runSync().catch(() => {});
          break;
        }
        case "MH_SIGN_IN_PAT": {
          const { auth, user } = await MH.oauth.signInWithPat(message.token);
          sendResponse({ ok: true, auth, user });
          runSync().catch(() => {});
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
// Lifecycle: alarms keep retrying even if the service worker was asleep,
// and onInstalled opens the dashboard so first-run setup is discoverable.
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
    const [auth, config, syncState] = await Promise.all([MH.getAuth(), MH.getConfig(), MH.getSyncState()]);
    if (!auth) return;
    if (syncState.status === "error" || config.autoSync) {
      runSync().catch((e) => console.error("[MonkeyHub] periodic sync failed", e));
    }
  })();
});
