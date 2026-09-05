'use strict';
// Signing in to a cloud provider, the way an installed application is supposed
// to: OAuth 2.0 authorisation code with PKCE, over a loopback redirect.
//
// WHY THIS SHAPE, since every part of it is a deliberate choice:
//
//   * PKCE, no client secret. A desktop app hands its binary to the user, so a
//     secret compiled into it is not secret. RFC 8252 says installed apps are
//     public clients and must use PKCE instead; the code verifier is generated
//     fresh per sign-in, never stored, and never leaves this process.
//
//   * A loopback HTTP server, not a custom protocol handler. Registering
//     nexafiles:// system-wide so a browser can call back into the app means
//     any page on the internet can also call into it. A server on 127.0.0.1
//     bound to an ephemeral port exists for the seconds the sign-in takes and
//     is reachable only from this machine.
//
//   * The system browser, not an embedded window. RFC 8252 §8.12 is explicit
//     that an app must not put the user's password into a window the app
//     controls: the user cannot see the address bar, cannot check the
//     certificate, and has no reason to believe the page is really Google's.
//     Handing off to the real browser means they are typing into a window this
//     application cannot read, with their own password manager and their own
//     existing session.
//
//   * `state` is checked. Without it, a request from anywhere else arriving at
//     the loopback port would be accepted as the answer to this sign-in.
//
// Nothing here is logged. Tokens, codes and verifiers never reach the console,
// a file, or an error message.

const crypto = require('crypto');
const http = require('http');
const { URL, URLSearchParams } = require('url');

const providers = require('./providers');

const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fresh PKCE pair. The verifier stays here; only the challenge is sent. */
function makePkce() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** The page the browser lands on when it is over. Plain, and it says what happened. */
function resultPage(title, message, ok) {
  return `<!doctype html><meta charset="utf-8">
<title>${title}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #EEF1F5; color: #141A2E; display: grid; place-items: center;
         height: 100vh; margin: 0; }
  .card { background: #fff; border: 1px solid #CBD3DD; border-radius: 10px;
          padding: 32px 36px; max-width: 44ch; text-align: center; }
  h1 { font-size: 19px; margin: 0 0 10px; color: ${ok ? '#14795F' : '#C21D3E'}; }
  p { margin: 0; font-size: 14px; color: #4A5468; line-height: 1.5; }
</style>
<div class="card"><h1>${title}</h1><p>${message}</p></div>`;
}

/**
 * Runs a sign-in and returns the tokens.
 *
 * @param {string} providerId 'google' | 'microsoft'
 * @param {string} clientId the id the user registered
 * @param {object} deps
 * @param {Function} deps.openExternal usually shell.openExternal
 * @returns {Promise<{accessToken, refreshToken, expiresAt, scope}>}
 */
async function signIn(providerId, clientId, { openExternal } = {}) {
  const p = providers.get(providerId);
  const id = String(clientId || '').trim();
  if (!id) {
    const err = new Error(
      `No ${p.label} client ID is configured. Register one and paste it in ` +
      `Settings first — see the link there.`);
    err.code = 'NO_CLIENT_ID';
    throw err;
  }
  if (typeof openExternal !== 'function') {
    throw new Error('Signing in needs a way to open the system browser.');
  }

  const { verifier, challenge } = makePkce();
  const state = base64url(crypto.randomBytes(24));

  // Bind first, so the redirect URI names the port the browser will really
  // reach. Port 0 asks the OS for a free one.
  const server = http.createServer();
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const authUrl = new URL(p.authUrl);
  authUrl.search = new URLSearchParams({
    client_id: id,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: p.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...p.extraAuthParams,
  }).toString();

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      const err = new Error('The sign-in was not completed within five minutes.');
      err.code = 'TIMEOUT';
      reject(err);
    }, SIGN_IN_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      try { server.close(); } catch { /* already closing */ }
    }

    server.on('request', (req, res) => {
      let url;
      try { url = new URL(req.url, `http://127.0.0.1:${port}`); }
      catch { res.writeHead(400).end(); return; }
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }

      const got = url.searchParams;
      const send = (status, html) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      };

      // Anything arriving without the state this sign-in generated is not the
      // answer to this sign-in, whatever else it claims.
      if (got.get('state') !== state) {
        send(400, resultPage('That did not come from NexaFiles',
          'The response did not carry the one-time value this sign-in generated, ' +
          'so it was refused. Nothing was granted. Close this tab and try again.', false));
        return;   // deliberately keeps waiting for the real one
      }

      const err = got.get('error');
      if (err) {
        send(200, resultPage('Sign-in cancelled',
          `${p.label} reported: ${String(got.get('error_description') || err)
            .replace(/[<>]/g, '')}. Nothing was changed. You can close this tab.`, false));
        cleanup();
        const e = new Error(`${p.label} refused the sign-in: ${err}`);
        e.code = 'DENIED';
        reject(e);
        return;
      }

      const authCode = got.get('code');
      if (!authCode) {
        send(400, resultPage('Something is missing',
          'The response carried no authorisation code. Close this tab and try again.', false));
        return;
      }

      send(200, resultPage('Signed in',
        `NexaFiles is connected to ${p.label} with read-only access. ` +
        'You can close this tab and go back to the app.', true));
      cleanup();
      resolve(authCode);
    });

    // The system browser, not a window this application can see into.
    Promise.resolve(openExternal(authUrl.toString())).catch((e) => {
      cleanup();
      reject(new Error(`The browser could not be opened: ${e.message}`));
    });
  });

  return exchange(p, id, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
}

/** Trades a refresh token for a fresh access token. */
async function refresh(providerId, clientId, refreshToken) {
  const p = providers.get(providerId);
  if (!refreshToken) {
    const err = new Error('That account has no refresh token; sign in again.');
    err.code = 'NO_REFRESH_TOKEN';
    throw err;
  }
  const out = await exchange(p, clientId, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  // Google does not resend the refresh token on a refresh; keep the old one
  // rather than storing undefined over it and locking the user out.
  return { ...out, refreshToken: out.refreshToken || refreshToken };
}

/** The token endpoint. Never logs its body, which carries credentials. */
async function exchange(p, clientId, params) {
  const body = new URLSearchParams({ client_id: clientId, ...params });
  let resp;
  try {
    resp = await fetch(p.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`${p.label} could not be reached: ${e.message}`);
  }

  const text = await resp.text();
  if (!resp.ok) {
    // The provider's own explanation, not the raw envelope, and never the body
    // we sent — which contains the code and the verifier.
    let detail = '';
    try {
      const j = JSON.parse(text);
      detail = j.error_description || j.error || '';
    } catch { detail = ''; }
    const err = new Error(
      `${p.label} refused the sign-in${detail ? `: ${detail}` : ` (HTTP ${resp.status})`}.` +
      (resp.status === 400 && /client/i.test(detail)
        ? ' Check the client ID in Settings, and that the redirect URI is registered ' +
          'as a desktop or mobile platform.'
        : ''));
    err.code = 'TOKEN_REFUSED';
    err.status = resp.status;
    throw err;
  }

  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`${p.label} returned a token response that was not JSON.`); }

  if (!json.access_token) {
    throw new Error(`${p.label} returned no access token.`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    // A minute of slack, so a request is never sent with a token that expires
    // while it is in flight.
    expiresAt: Date.now() + Math.max(0, (Number(json.expires_in) || 3600) - 60) * 1000,
    scope: json.scope || p.scopes.join(' '),
    tokenType: json.token_type || 'Bearer',
  };
}

module.exports = { signIn, refresh, makePkce, SIGN_IN_TIMEOUT_MS };
