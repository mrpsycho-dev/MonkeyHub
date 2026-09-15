// MonkeyHub - GitHub REST API client.
//
// Every request goes through `ghRequest`, which is the single place that:
//   - attaches auth + version headers
//   - understands conditional requests (ETag / If-None-Match -> 304)
//   - reads rate-limit headers and backs off before GitHub has to tell us to
//   - retries transient failures (network drop, 5xx, secondary rate limit)
//   - turns every non-2xx/304 response into a `GitHubError` with a stable
//     `.kind` so callers (and the UI) can react without re-parsing bodies.
//
// This file intentionally has zero framework dependencies so it can be
// loaded as a plain classic script in the MV3 service worker.

var MH = self.MH || {};

class GitHubError extends Error {
  constructor(status, kind, message, opts = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.kind = kind; // see KIND_* constants below
    this.retryable = !!opts.retryable;
    this.retryAfterMs = opts.retryAfterMs || 0;
    this.githubMessage = opts.githubMessage || "";
    this.documentationUrl = opts.documentationUrl || "";
  }
}
MH.GitHubError = GitHubError;

MH.KIND = {
  OFFLINE: "offline",
  NOT_MODIFIED: "not_modified", // 304 - not really an error, exposed for symmetry
  BAD_REQUEST: "bad_request", // 400
  UNAUTHORIZED: "unauthorized", // 401
  FORBIDDEN_SCOPE: "forbidden_scope", // 403 - token missing required scope
  FORBIDDEN_RATE_LIMIT: "forbidden_rate_limit", // 403 - primary rate limit exhausted
  FORBIDDEN_SECONDARY_RATE_LIMIT: "forbidden_secondary_rate_limit", // 403/429 - abuse detection
  FORBIDDEN_SSO: "forbidden_sso", // 403 - org requires SAML SSO authorization for this token
  FORBIDDEN_OTHER: "forbidden_other",
  NOT_FOUND: "not_found", // 404
  CONFLICT: "conflict", // 409
  UNPROCESSABLE: "unprocessable", // 422
  SERVER_ERROR: "server_error", // 5xx
  UNKNOWN: "unknown",
};

const RETRYABLE_KINDS = new Set([
  MH.KIND.SERVER_ERROR,
  MH.KIND.FORBIDDEN_SECONDARY_RATE_LIMIT,
  MH.KIND.OFFLINE,
]);

function parseRateLimit(headers) {
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  return {
    remaining: remaining !== null ? Number(remaining) : null,
    resetAt: reset !== null ? Number(reset) * 1000 : null,
  };
}

async function classify(response) {
  const status = response.status;
  const headers = response.headers;
  let body = null;
  try {
    body = await response.clone().json();
  } catch (_) {
    // no/invalid JSON body (e.g. 304, or a plain-text 5xx from a proxy)
  }
  const githubMessage = (body && (body.message || body.error_description)) || "";
  const documentationUrl = (body && body.documentation_url) || "";
  const retryAfterHeader = headers.get("retry-after");
  const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 0;

  if (status === 304) {
    return { kind: MH.KIND.NOT_MODIFIED, githubMessage, documentationUrl, body };
  }
  if (status === 400) {
    return { kind: MH.KIND.BAD_REQUEST, githubMessage, documentationUrl, body };
  }
  if (status === 401) {
    return { kind: MH.KIND.UNAUTHORIZED, githubMessage, documentationUrl, body };
  }
  if (status === 403) {
    const { remaining } = parseRateLimit(headers);
    const msg = githubMessage.toLowerCase();
    if (msg.includes("saml") || msg.includes("sso")) {
      return { kind: MH.KIND.FORBIDDEN_SSO, githubMessage, documentationUrl, body };
    }
    if (remaining === 0) {
      const { resetAt } = parseRateLimit(headers);
      return {
        kind: MH.KIND.FORBIDDEN_RATE_LIMIT,
        githubMessage,
        documentationUrl,
        body,
        retryAfterMs: Math.max(0, (resetAt || Date.now()) - Date.now()),
      };
    }
    if (msg.includes("secondary rate limit") || msg.includes("abuse")) {
      return {
        kind: MH.KIND.FORBIDDEN_SECONDARY_RATE_LIMIT,
        githubMessage,
        documentationUrl,
        body,
        retryAfterMs: retryAfterMs || 60000,
      };
    }
    if (msg.includes("scope")) {
      return { kind: MH.KIND.FORBIDDEN_SCOPE, githubMessage, documentationUrl, body };
    }
    return { kind: MH.KIND.FORBIDDEN_OTHER, githubMessage, documentationUrl, body };
  }
  if (status === 404) {
    return { kind: MH.KIND.NOT_FOUND, githubMessage, documentationUrl, body };
  }
  if (status === 409) {
    return { kind: MH.KIND.CONFLICT, githubMessage, documentationUrl, body };
  }
  if (status === 422) {
    return { kind: MH.KIND.UNPROCESSABLE, githubMessage, documentationUrl, body };
  }
  if (status === 429) {
    return {
      kind: MH.KIND.FORBIDDEN_SECONDARY_RATE_LIMIT,
      githubMessage,
      documentationUrl,
      body,
      retryAfterMs: retryAfterMs || 30000,
    };
  }
  if (status >= 500) {
    return { kind: MH.KIND.SERVER_ERROR, githubMessage, documentationUrl, body };
  }
  return { kind: MH.KIND.UNKNOWN, githubMessage, documentationUrl, body };
}

/**
 * User-facing copy for every error kind. Kept centralized so the popup,
 * dashboard, and background retry logic all describe the same failure the
 * same way.
 */
MH.describeError = function describeError(err) {
  const map = {
    [MH.KIND.OFFLINE]: "You're offline. MonkeyHub queued this result and will sync it once you're back online.",
    [MH.KIND.BAD_REQUEST]: "GitHub rejected the request as malformed. This is usually a MonkeyHub bug - please open an issue with the details below.",
    [MH.KIND.UNAUTHORIZED]: "Your GitHub connection expired or was revoked. Reconnect in Settings to keep syncing.",
    [MH.KIND.FORBIDDEN_SCOPE]: "Your GitHub token doesn't have permission to write repositories. Reconnect and grant the 'repo' scope.",
    [MH.KIND.FORBIDDEN_RATE_LIMIT]: "GitHub's hourly rate limit is exhausted for this token. MonkeyHub will retry automatically once it resets.",
    [MH.KIND.FORBIDDEN_SECONDARY_RATE_LIMIT]: "GitHub asked MonkeyHub to slow down. Retrying shortly with backoff.",
    [MH.KIND.FORBIDDEN_SSO]: "Your organization requires SSO authorization for this token. Authorize it from your GitHub organization settings, then retry.",
    [MH.KIND.FORBIDDEN_OTHER]: "GitHub refused the request (403). Check that the repository exists and your account has push access.",
    [MH.KIND.NOT_FOUND]: "The repository or file wasn't found.",
    [MH.KIND.CONFLICT]: "The branch moved on GitHub since MonkeyHub last read it (another device, or a manual commit). Rebuilt the commit on the new branch head and retried.",
    [MH.KIND.UNPROCESSABLE]: "GitHub rejected the commit (422) - usually the branch moved between MonkeyHub's read and write. Retried on the fresh branch head automatically.",
    [MH.KIND.SERVER_ERROR]: "GitHub is having issues on its end (5xx). Retrying with backoff.",
    [MH.KIND.UNKNOWN]: "Something unexpected happened talking to GitHub.",
  };
  const base = map[err.kind] || err.message || "Unknown error.";
  return err.githubMessage ? `${base} (GitHub said: "${err.githubMessage}")` : base;
};

function buildHeaders(auth, extra) {
  const headers = new Headers(extra || {});
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", MH.GITHUB_API_VERSION);
  if (auth && auth.accessToken) {
    headers.set("Authorization", `Bearer ${auth.accessToken}`);
  }
  return headers;
}

/**
 * Low-level request wrapper. Resolves with `{ status, json, headers }` for
 * 2xx/304 responses; rejects with a `GitHubError` for everything else.
 * Retries transient failures automatically (network error, 5xx, secondary
 * rate limit) up to `maxRetries` times with exponential backoff, honoring
 * `Retry-After` when GitHub sends one.
 */
MH.ghRequest = async function ghRequest(path, { method = "GET", auth, body, etag, extraHeaders, maxRetries = 3 } = {}) {
  const url = path.startsWith("http") ? path : `${MH.GITHUB_API}${path}`;
  const headers = buildHeaders(auth, extraHeaders);
  if (etag) headers.set("If-None-Match", etag);
  if (body !== undefined) headers.set("Content-Type", "application/json");

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (networkError) {
      if (attempt <= maxRetries) {
        await MH.sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw new GitHubError(0, MH.KIND.OFFLINE, "Network request failed", { retryable: true });
    }

    if (response.status === 304) {
      return { status: 304, json: null, headers: response.headers, etag: response.headers.get("etag") };
    }
    if (response.ok) {
      let json = null;
      try {
        json = await response.json();
      } catch (_) {
        json = null;
      }
      return { status: response.status, json, headers: response.headers, etag: response.headers.get("etag") };
    }

    const info = await classify(response);
    const err = new GitHubError(response.status, info.kind, info.githubMessage || `HTTP ${response.status}`, {
      retryable: RETRYABLE_KINDS.has(info.kind),
      retryAfterMs: info.retryAfterMs,
      githubMessage: info.githubMessage,
      documentationUrl: info.documentationUrl,
    });
    err.body = info.body;

    if (err.retryable && attempt <= maxRetries) {
      const backoff = err.retryAfterMs || 500 * 2 ** (attempt - 1);
      await MH.sleep(Math.min(backoff, 30000));
      continue;
    }
    throw err;
  }
};

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

MH.gh = {
  /** Confirms the token is live and returns the authenticated user. */
  async getUser(auth) {
    const res = await MH.ghRequest("/user", { auth });
    return res.json;
  },

  /**
   * Checks whether {owner}/{repo} exists. Uses a cached ETag so repeat
   * checks (e.g. before every sync) usually cost a cheap 304 instead of a
   * full rate-limited request.
   */
  async repoExists(auth, owner, repo, cachedEtag) {
    try {
      const res = await MH.ghRequest(`/repos/${owner}/${repo}`, { auth, etag: cachedEtag });
      if (res.status === 304) {
        return { exists: true, cached: true, etag: cachedEtag };
      }
      return {
        exists: true,
        cached: false,
        etag: res.etag,
        defaultBranch: res.json.default_branch,
        private: res.json.private,
        fullName: res.json.full_name,
      };
    } catch (err) {
      if (err.kind === MH.KIND.NOT_FOUND) return { exists: false };
      throw err;
    }
  },

  /** Creates a repository under the authenticated user's account. */
  async createRepo(auth, { name, isPrivate, description }) {
    try {
      const res = await MH.ghRequest("/user/repos", {
        method: "POST",
        auth,
        body: {
          name,
          private: !!isPrivate,
          description: description || "Typing statistics, synced automatically by MonkeyHub.",
          auto_init: true, // guarantees a default branch exists before our first Contents API write
        },
      });
      return res.json;
    } catch (err) {
      if (err.kind === MH.KIND.UNPROCESSABLE) {
        // Most common cause: a repo with this name already exists on the
        // account (possibly created seconds ago by a concurrent sync, or
        // the user already has one from before installing MonkeyHub).
        err.friendly = `A repository named "${name}" already exists, or the name is invalid. Pick another name in Settings, or use the existing repository as-is.`;
      }
      throw err;
    }
  },

  /**
   * Fetches a file's contents + sha. Returns `{ exists:false }` on 404 so
   * callers can distinguish "first sync ever" from a real error.
   */
  async getFile(auth, owner, repo, path, branch, cachedEtag) {
    const qs = branch ? `?ref=${encodeURIComponent(branch)}` : "";
    try {
      const res = await MH.ghRequest(`/repos/${owner}/${repo}/contents/${path}${qs}`, {
        auth,
        etag: cachedEtag,
      });
      if (res.status === 304) {
        return { exists: true, cached: true, etag: cachedEtag };
      }
      if (Array.isArray(res.json)) {
        throw new GitHubError(422, MH.KIND.UNPROCESSABLE, `${path} is a directory, not a file`);
      }
      if (!res.json.content) {
        // File exists but is too large for the Contents API to inline
        // (>1MB) - fall back to the raw media type.
        const raw = await MH.ghRequest(`/repos/${owner}/${repo}/contents/${path}${qs}`, {
          auth,
          extraHeaders: { Accept: "application/vnd.github.raw+json" },
        });
        return { exists: true, cached: false, sha: res.json.sha, etag: res.etag, text: raw.json };
      }
      return {
        exists: true,
        cached: false,
        sha: res.json.sha,
        etag: res.etag,
        text: MH.base64ToUtf8(res.json.content),
      };
    } catch (err) {
      if (err.kind === MH.KIND.NOT_FOUND) return { exists: false };
      throw err;
    }
  },

  /**
   * Commits any number of text files in a single atomic commit using the
   * Git Data API, instead of one Contents-API PUT (and one commit) per
   * file. `files` is `[{ path, content }, ...]`; any path not listed is
   * left untouched (the new tree is built on top of the branch's current
   * tree, so this is a sparse update, not a full snapshot).
   *
   * The whole read-tree-commit-move-ref sequence is retried as a unit (not
   * just the final ref update) with jittered backoff, because a race can
   * surface as a 409/422 at *any* of those steps, not only the last one -
   * retrying only the last step left earlier-step races unretried entirely.
   */
  async commitFiles(auth, owner, repo, branch, files, message, maxRetries = 5) {
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        let baseCommitSha = null;
        let baseTreeSha = null;
        try {
          const refRes = await MH.ghRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, { auth });
          baseCommitSha = refRes.json.object.sha;
          const commitRes = await MH.ghRequest(`/repos/${owner}/${repo}/git/commits/${baseCommitSha}`, { auth });
          baseTreeSha = commitRes.json.tree.sha;
        } catch (err) {
          if (err.kind !== MH.KIND.NOT_FOUND) throw err;
          // Branch doesn't exist yet (a genuinely empty repo, auto_init
          // wasn't used, or a brand-new branch name) - build the very
          // first commit on it from scratch, below.
        }

        const treeBody = {
          tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
        };
        if (baseTreeSha) treeBody.base_tree = baseTreeSha;
        const treeRes = await MH.ghRequest(`/repos/${owner}/${repo}/git/trees`, { method: "POST", auth, body: treeBody });

        const commitBody = { message, tree: treeRes.json.sha };
        if (baseCommitSha) commitBody.parents = [baseCommitSha];
        const newCommitRes = await MH.ghRequest(`/repos/${owner}/${repo}/git/commits`, {
          method: "POST",
          auth,
          body: commitBody,
        });
        const newCommitSha = newCommitRes.json.sha;

        if (baseCommitSha) {
          await MH.ghRequest(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
            method: "PATCH",
            auth,
            body: { sha: newCommitSha, force: false },
          });
        } else {
          await MH.ghRequest(`/repos/${owner}/${repo}/git/refs`, {
            method: "POST",
            auth,
            body: { ref: `refs/heads/${branch}`, sha: newCommitSha },
          });
        }
        return newCommitRes.json;
      } catch (err) {
        lastErr = err;
        const isRace = err.kind === MH.KIND.UNPROCESSABLE || err.kind === MH.KIND.CONFLICT;
        if (isRace && attempt < maxRetries) {
          MH.appendLog({
            type: "commit_retry",
            message: `Commit attempt ${attempt}/${maxRetries} hit a ${err.kind === MH.KIND.CONFLICT ? "409" : "422"} (${err.githubMessage || "branch moved"}) - retrying.`,
          }).catch(() => {});
          // Jittered, growing backoff: on a genuine one-off race this
          // resolves in one or two tries; if something else is
          // persistently colliding (e.g. an overlapping sync from another
          // trigger), spacing attempts out gives it room to finish instead
          // of both sides retrying in lockstep forever.
          await MH.sleep(250 * attempt + Math.random() * 400);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  },
};

if (typeof module !== "undefined") {
  module.exports = MH;
}
