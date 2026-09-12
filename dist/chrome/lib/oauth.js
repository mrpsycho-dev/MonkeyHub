// MonkeyHub - GitHub OAuth2 + PKCE flow.
//
// Background-only module (needs the `identity` permission). The flow:
//
//   1. Generate a PKCE code_verifier/code_challenge pair and a random
//      `state` nonce.
//   2. Open GitHub's authorize screen via launchWebAuthFlow with the
//      challenge attached. GitHub redirects back to
//      `<extension-id>.chromiumapp.org` (Chrome) or
//      `<extension-id>.extensions.allizom.org` (Firefox) with a one-time
//      `code`.
//   3. Exchange that code (+ code_verifier) for an access token. GitHub
//      still requires `client_secret` at this step even with PKCE, so this
//      call goes through the small companion proxy in /proxy, which is the
//      only place that ever sees the secret. See README.md, "Why a proxy?".
//   4. Store the resulting token and fetch the authenticated user for the
//      dashboard header / README title.
//
// A Personal Access Token mode is also supported end to end (see
// signInWithPat below) for anyone who doesn't want to stand up the proxy -
// it skips this entire file.

var MH = self.MH || {};

MH.oauth = {
  getRedirectUrl() {
    return MH.ext.identity.getRedirectURL();
  },

  async buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge }) {
    const url = new URL(MH.GITHUB_AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", MH.OAUTH_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("allow_signup", "true");
    return url.toString();
  },

  /** Launches the interactive GitHub consent screen and resolves with the
   * `code` GitHub issued, after verifying the `state` round-tripped. */
  async requestAuthorizationCode({ clientId }) {
    const redirectUri = this.getRedirectUrl();
    const state = MH.randomUrlSafeString(16);
    const codeVerifier = MH.generateCodeVerifier();
    const codeChallenge = await MH.generateCodeChallenge(codeVerifier);

    const authorizeUrl = await this.buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge });

    const resultUrl = await MH.callApi(MH.ext.identity, "launchWebAuthFlow", {
      url: authorizeUrl,
      interactive: true,
    });
    if (!resultUrl) {
      throw new Error("GitHub sign-in was closed before finishing.");
    }
    const parsed = new URL(resultUrl);
    const returnedState = parsed.searchParams.get("state");
    const error = parsed.searchParams.get("error");
    if (error) {
      const desc = parsed.searchParams.get("error_description") || error;
      throw new Error(`GitHub declined authorization: ${desc}`);
    }
    if (returnedState !== state) {
      throw new Error("OAuth state mismatch - aborting for your safety. Please try connecting again.");
    }
    const code = parsed.searchParams.get("code");
    if (!code) throw new Error("GitHub did not return an authorization code.");
    return { code, codeVerifier, redirectUri };
  },

  /** Exchanges the authorization code for tokens via the user's own
   * token-exchange proxy (see /proxy). */
  async exchangeCodeForToken({ proxyUrl, clientId, code, codeVerifier, redirectUri }) {
    if (!proxyUrl) {
      throw new Error(
        "No token-exchange proxy is configured. OAuth+PKCE sign-in needs a tiny proxy that holds your OAuth App's client secret - see README.md 'Why a proxy?' and /proxy for ready-to-deploy code, or use a Personal Access Token instead (Settings -> Personal Access Token)."
      );
    }
    const res = await fetch(proxyUrl.replace(/\/$/, "") + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, code, code_verifier: codeVerifier, redirect_uri: redirectUri }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      throw new Error(body.error_description || body.error || `Token exchange failed (HTTP ${res.status}).`);
    }
    return body; // { access_token, token_type, scope, refresh_token?, expires_in?, refresh_token_expires_in? }
  },

  async refreshAccessToken({ proxyUrl, clientId, refreshToken }) {
    if (!proxyUrl) throw new Error("No token-exchange proxy configured; cannot refresh.");
    const res = await fetch(proxyUrl.replace(/\/$/, "") + "/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, refresh_token: refreshToken }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      throw new Error(body.error_description || body.error || `Token refresh failed (HTTP ${res.status}).`);
    }
    return body;
  },

  /** Full interactive sign-in: authorize -> exchange -> persist -> fetch user. */
  async signInWithOAuth({ clientId, proxyUrl }) {
    const { code, codeVerifier, redirectUri } = await this.requestAuthorizationCode({ clientId });
    const tokenResponse = await this.exchangeCodeForToken({ proxyUrl, clientId, code, codeVerifier, redirectUri });
    const auth = {
      mode: "oauth",
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token || null,
      expiresAt: tokenResponse.expires_in ? Date.now() + tokenResponse.expires_in * 1000 : null,
      tokenType: tokenResponse.token_type || "bearer",
      scope: tokenResponse.scope || "",
    };
    const user = await MH.gh.getUser(auth);
    auth.login = user.login;
    auth.name = user.name;
    auth.avatarUrl = user.avatar_url;
    await MH.setAuth(auth);
    return { auth, user };
  },

  /** Non-OAuth path: a fine-grained or classic Personal Access Token,
   * pasted directly by the user. Same downstream code path (GitHubError
   * handling, rate limits, etc.) since it's just a Bearer token from here. */
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
  },
};

if (typeof module !== "undefined") {
  module.exports = MH;
}
