# MonkeyHub token-exchange proxy

A ~90-line Cloudflare Worker with one job: hold your GitHub OAuth App's
`client_secret` so MonkeyHub's OAuth2 + PKCE sign-in works without shipping
that secret inside the extension. It stores nothing, logs nothing sensitive,
and only ever talks to `github.com/login/oauth/access_token`.

You only need this if you want the **"Connect with GitHub"** OAuth flow. If
you'd rather skip the five-minute setup below, use a **Personal Access
Token** instead (Settings → paste token) - MonkeyHub works fully either way.

## Why does this need to exist at all?

GitHub's OAuth Apps require `client_secret` at the token-exchange step even
when the authorization request used PKCE. PKCE protects the one-time
authorization *code* from interception in transit; it doesn't let GitHub's
token endpoint accept a public client with no secret. Since anyone can read
an extension's source, the secret can never live in the extension itself -
it has to live somewhere server-side. This Worker is the smallest "somewhere
server-side" that will do.

## Deploy it (about 5 minutes, free tier is plenty)

1. **Create a GitHub OAuth App**
   GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
   - **Homepage URL**: anything, e.g. `https://github.com/you`
   - **Authorization callback URL**: leave a placeholder for now - you'll
     come back and set the real one after loading the extension (see the
     main README's "Connect GitHub" section for how to find it).
   - Save, then copy the **Client ID** and generate a **Client secret**.

2. **Install Wrangler and log in**
   ```bash
   npm install -g wrangler
   wrangler login
   ```

3. **Set the secret** (from this `proxy/` directory)
   ```bash
   wrangler secret put GITHUB_CLIENT_SECRET
   # paste the client secret from step 1 when prompted
   ```

4. **Deploy**
   ```bash
   wrangler deploy
   ```
   Wrangler prints a URL like `https://monkeyhub-oauth-proxy.<you>.workers.dev`.
   That's your **proxy URL** - paste it into MonkeyHub's Settings alongside
   the Client ID from step 1.

5. **(Optional) lock the proxy to your app**
   Uncomment `ALLOWED_CLIENT_ID` in `wrangler.toml`, set it to your Client
   ID, and redeploy. This stops the proxy from exchanging codes for any
   OAuth App other than yours if the URL ever leaks.

## Endpoints

- `POST /token` - body `{ client_id, code, code_verifier, redirect_uri }`,
  returns GitHub's token response verbatim (`access_token`, `scope`, and
  `refresh_token`/`expires_in` if your OAuth App has expiring tokens
  enabled).
- `POST /refresh` - body `{ client_id, refresh_token }`, used when an
  expiring token needs renewing.

Both are CORS-enabled for any origin, since a browser extension's origin
(`chrome-extension://<id>`) isn't something a Worker can allowlist ahead of
time. If you'd like to tighten this, restrict `Access-Control-Allow-Origin`
in `src/index.js` to your specific extension ID once you know it.

## Running it locally instead

```bash
wrangler dev
```

Point MonkeyHub's proxy URL at the printed `http://localhost:8787` while
testing, then switch to the deployed URL for real use (an extension's
background service worker can't reach `localhost` reliably once the browser
is closed and reopened, and `http://` redirect targets are blocked by
several identity providers besides).
