/**
 * MonkeyHub token-exchange proxy.
 *
 * Why this exists: GitHub's OAuth Apps still require `client_secret` at the
 * token-exchange step even when the authorization request used PKCE (PKCE
 * protects the authorization *code* in transit; it does not make GitHub's
 * token endpoint accept a secret-less client). A browser extension can't
 * keep a secret - anyone can read its source - so this tiny, stateless
 * Worker is the only thing that ever holds GITHUB_CLIENT_SECRET. It does
 * nothing else: no database, no logging of tokens, no user accounts.
 *
 * Routes:
 *   POST /token    { client_id, code, code_verifier, redirect_uri } -> GitHub token response
 *   POST /refresh  { client_id, refresh_token }                    -> GitHub token response
 *
 * Deploy (see ../README.md for the full walkthrough):
 *   wrangler secret put GITHUB_CLIENT_SECRET
 *   wrangler deploy
 *
 * Optional hardening: set ALLOWED_CLIENT_ID as a plain var in wrangler.toml
 * to reject token requests for any OAuth App other than your own.
 */

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(data, status, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

async function exchange(params, request, env) {
  if (env.ALLOWED_CLIENT_ID && params.client_id !== env.ALLOWED_CLIENT_ID) {
    return json({ error: "client_id_not_allowed" }, 403, request);
  }
  const body = new URLSearchParams({ ...params, client_secret: env.GITHUB_CLIENT_SECRET });
  const ghResponse = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await ghResponse.json().catch(() => ({ error: "invalid_github_response" }));
  // Pass GitHub's own status through where sensible, but never leak the
  // secret or raw upstream body beyond what GitHub itself returned.
  return json(data, ghResponse.ok ? 200 : 400, request);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405, request);
    }

    const url = new URL(request.url);
    let payload;
    try {
      payload = await request.json();
    } catch (_) {
      return json({ error: "invalid_json_body" }, 400, request);
    }

    if (!env.GITHUB_CLIENT_SECRET) {
      return json({ error: "server_misconfigured", error_description: "GITHUB_CLIENT_SECRET is not set on this Worker." }, 500, request);
    }

    if (url.pathname === "/token") {
      const { client_id, code, code_verifier, redirect_uri } = payload;
      if (!client_id || !code || !code_verifier || !redirect_uri) {
        return json({ error: "missing_parameters" }, 400, request);
      }
      return exchange({ client_id, code, code_verifier, redirect_uri }, request, env);
    }

    if (url.pathname === "/refresh") {
      const { client_id, refresh_token } = payload;
      if (!client_id || !refresh_token) {
        return json({ error: "missing_parameters" }, 400, request);
      }
      return exchange({ client_id, grant_type: "refresh_token", refresh_token }, request, env);
    }

    return json({ error: "not_found" }, 404, request);
  },
};
