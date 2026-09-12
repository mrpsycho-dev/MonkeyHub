// MonkeyHub - PKCE (Proof Key for Code Exchange, RFC 7636) helpers.
//
// GitHub still requires an OAuth App's `client_secret` at the token-exchange
// step even when PKCE is used (PKCE only removes the requirement to also
// send the secret when the client can't be trusted to keep one - see the
// project README for why MonkeyHub still ships a tiny token-exchange proxy).
// The verifier/challenge pair below is what protects the *authorization
// code* itself from interception between steps 1 and 2 of the flow.

var MH = self.MH || {};

/** 43-128 char, URL-safe. We use 64 bytes -> ~86 chars, comfortably in range. */
MH.generateCodeVerifier = function generateCodeVerifier() {
  return MH.randomUrlSafeString(64);
};

MH.generateCodeChallenge = async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

if (typeof module !== "undefined") {
  module.exports = MH;
}
