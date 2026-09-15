// MonkeyHub - GitHub OAuth Device Flow.
//
// Why device flow instead of the authorization-code + PKCE flow: GitHub's
// OAuth Apps still require `client_secret` at the token-exchange step even
// when PKCE is used, which meant the previous version of MonkeyHub needed a
// small external proxy just to hold that secret. The device flow needs
// neither a secret nor a redirect URI - GitHub explicitly documents that
// `client_secret` is not required for it - so it works entirely from inside
// the extension with nothing to deploy. The trade-off is a few seconds of
// "type this code in on GitHub" instead of a popup consent screen; there's
// no PKCE step because there's no redirect to protect.
//
// Flow:
//   1. POST /login/device/code with { client_id, scope } -> { device_code,
//      user_code, verification_uri, interval, expires_in }.
//   2. Show `user_code` + `verification_uri` to the user.
//   3. Poll POST /login/oauth/access_token with { client_id, device_code,
//      grant_type } every `interval` seconds until the user approves (or it
//      expires / is denied / MonkeyHub gives up).
//
// State is persisted to storage (not just kept in memory) because an MV3
// service worker can be recycled mid-poll; background.js's periodic alarm
// resumes an interrupted poll using the persisted state (see
// resumePendingDeviceFlowIfAny in background.js).

var MH = self.MH || {};

const DEVICE_CODE_URL = "https://github.com/login/device/code";

MH.oauth = {
  /** Kicks off a device flow and returns the fields the UI needs to show
   * immediately. Polling continues independently - see pollOnce/background.js. */
  async startDeviceFlow({ clientId }) {
    if (!clientId) throw new Error("Add your GitHub OAuth App's Client ID in Settings first.");
    const res = await fetch(DEVICE_CODE_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, scope: MH.OAUTH_SCOPES.join(" ") }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      throw new Error(body.error_description || body.error || `GitHub rejected the device code request (HTTP ${res.status}).`);
    }
    const state = {
      status: "pending",
      clientId,
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      verificationUriComplete: body.verification_uri_complete || body.verification_uri,
      interval: body.interval || 5,
      expiresAt: Date.now() + (body.expires_in || 900) * 1000,
      lastPolledAt: 0,
      message: null,
    };
    await MH.storageSet(MH.KEYS.DEVICE_FLOW, state);
    return state;
  },

  /** Performs exactly one poll against GitHub using whatever device-flow
   * state is currently persisted. Safe to call repeatedly/redundantly -
   * it's a no-op if there's no pending flow, it isn't due yet, or it
   * already finished. Returns the (possibly updated) state, or null. */
  async pollOnce() {
    const state = await MH.storageGet(MH.KEYS.DEVICE_FLOW, null);
    if (!state || state.status !== "pending") return state;

    if (Date.now() > state.expiresAt) {
      const next = Object.assign({}, state, { status: "error", message: "That code expired. Try connecting again." });
      await MH.storageSet(MH.KEYS.DEVICE_FLOW, next);
      return next;
    }
    if (Date.now() - state.lastPolledAt < state.interval * 1000) {
      return state; // not due yet
    }

    const res = await fetch(MH.GITHUB_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: state.clientId,
        device_code: state.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const body = await res.json().catch(() => ({}));
    const polledAt = Date.now();

    if (body.access_token) {
      const auth = {
        mode: "oauth",
        accessToken: body.access_token,
        tokenType: body.token_type || "bearer",
        scope: body.scope || "",
      };
      const user = await MH.gh.getUser(auth);
      auth.login = user.login;
      auth.name = user.name;
      auth.avatarUrl = user.avatar_url;
      await MH.setAuth(auth);
      const next = { status: "success", login: user.login };
      await MH.storageSet(MH.KEYS.DEVICE_FLOW, next);
      return next;
    }

    switch (body.error) {
      case "authorization_pending": {
        const next = Object.assign({}, state, { lastPolledAt: polledAt });
        await MH.storageSet(MH.KEYS.DEVICE_FLOW, next);
        return next;
      }
      case "slow_down": {
        const next = Object.assign({}, state, {
          lastPolledAt: polledAt,
          interval: (body.interval || state.interval + 5),
        });
        await MH.storageSet(MH.KEYS.DEVICE_FLOW, next);
        return next;
      }
      case "expired_token": {
        const next = Object.assign({}, state, { status: "error", message: "That code expired. Try connecting again." });
        await MH.storageSet(MH.KEYS.DEVICE_FLOW, next);
        return next;
      }
      case "access_denied": {
        const next = Object.assign({}, state, { status: "error", message: "Sign-in was cancelled on GitHub." });
        await MH.storageSet(MH.KEYS.DEVICE_FLOW, next);
        return next;
      }
      default: {
        const next = Object.assign({}, state, {
          status: "error",
          message: body.error_description || body.error || `Unexpected response from GitHub (HTTP ${res.status}).`,
        });
        await MH.storageSet(MH.KEYS.DEVICE_FLOW, next);
        return next;
      }
    }
  },

  /** Runs a fast local poll loop for as long as the popup/dashboard that
   * started it stays open, so approval is picked up within a few seconds
   * rather than waiting for the once-a-minute alarm backstop. */
  async runFastPollLoop() {
    for (;;) {
      const state = await this.pollOnce();
      if (!state || state.status !== "pending") return state;
      await MH.sleep(Math.min(state.interval * 1000, 10000));
    }
  },

  async cancelDeviceFlow() {
    const state = await MH.storageGet(MH.KEYS.DEVICE_FLOW, null);
    if (state && state.status === "pending") {
      await MH.storageSet(MH.KEYS.DEVICE_FLOW, Object.assign({}, state, { status: "cancelled" }));
    }
  },

  getDeviceFlowState() {
    return MH.storageGet(MH.KEYS.DEVICE_FLOW, null);
  },

  /** Non-OAuth path: a fine-grained or classic Personal Access Token,
   * pasted directly by the user. */
  async signInWithPat(token) {
    const auth = { mode: "pat", accessToken: token.trim(), tokenType: "bearer" };
    const user = await MH.gh.getUser(auth); // throws GitHubError(401) if invalid - surfaced to the caller
    auth.login = user.login;
    auth.name = user.name;
    auth.avatarUrl = user.avatar_url;
    await MH.setAuth(auth);
    return { auth, user };
  },

  async signOut() {
    await MH.clearAuth();
    await MH.storageRemove(MH.KEYS.DEVICE_FLOW);
  },
};

if (typeof module !== "undefined") {
  module.exports = MH;
}
