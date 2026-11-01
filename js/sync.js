// Accounts and online library storage, using Firebase's web APIs directly so the app stays light.
// Only the library is sent here. Patient reports never are.

// This key only names the project. The database rules are what keep each account's data private.
const API_KEY = 'AIzaSyBYt8EsaKfIjghujhO9MlHVaV_TTqU5Zrw';
const PROJECT = 'quickds-28e44';
const GOOGLE_CLIENT_ID = '1052668817957-hj6bkgfickadabolmi0ktevgnaqm5mc0.apps.googleusercontent.com';
const GOOGLE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_STATE_KEY = 'dd.google.state';
const AUTH_URL = 'https://identitytoolkit.googleapis.com/v1/accounts';
const TOKEN_URL = 'https://securetoken.googleapis.com/v1/token';
const DB_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const AUTH_MESSAGES = {
  EMAIL_EXISTS: 'That email already has an account. Sign in instead.',
  INVALID_EMAIL: 'That email address does not look right.',
  MISSING_PASSWORD: 'Enter a password.',
  INVALID_PASSWORD: 'That email or password is not right.',
  INVALID_LOGIN_CREDENTIALS: 'That email or password is not right.',
  EMAIL_NOT_FOUND: 'That email or password is not right.',
  OPERATION_NOT_ALLOWED: 'Sign-in is not switched on for this app yet.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Wait a few minutes and try again.',
  USER_DISABLED: 'This account has been turned off.',
};

const fail = (code, message) => Object.assign(new Error(message), { code });

async function send(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw fail('OFFLINE', 'No connection. Try again when you are online.');
  }
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

function toAccount(body, email) {
  return {
    uid: body.localId || body.user_id,
    email,
    idToken: body.idToken || body.id_token,
    refreshToken: body.refreshToken || body.refresh_token,
    expiresAt: Date.now() + Number(body.expiresIn || body.expires_in) * 1000,
  };
}

async function authenticate(action, email, password) {
  const { ok, body } = await send(`${AUTH_URL}:${action}?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (ok) return toAccount(body, email);
  const code = (body.error?.message || '').split(' ')[0];
  if (code === 'WEAK_PASSWORD') throw fail(code, 'Use a password of at least 6 characters.');
  throw fail(code, AUTH_MESSAGES[code] || 'Could not sign in. Try again.');
}

export const signIn = (email, password) => authenticate('signInWithPassword', email, password);
export const signUp = (email, password) => authenticate('signUp', email, password);

const randomText = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
const appAddress = () => new URL('./', location.href).href;

async function sha256(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

// The whole page goes to Google and comes back here. Phones block the storage that pop-ups and
// Firebase's own hand-off page rely on, and this route needs neither.
export async function startGoogleSignIn() {
  if (!navigator.onLine) throw fail('OFFLINE', 'No connection. Try again when you are online.');
  const saved = { state: randomText(), nonce: randomText() };
  try {
    localStorage.setItem(GOOGLE_STATE_KEY, JSON.stringify(saved));
  } catch {
    throw fail('STORAGE', 'This browser blocks storage, so Google sign-in cannot work here. Use your email instead.');
  }
  const query = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: appAddress(), response_type: 'id_token', scope: 'openid email profile',
    state: saved.state, nonce: await sha256(saved.nonce), prompt: 'select_account',
  });
  location.href = `${GOOGLE_URL}?${query}`;
}

function exchangeGoogleToken(token, nonce) {
  return send(`${AUTH_URL}:signInWithIdp?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postBody: new URLSearchParams({ id_token: token, providerId: 'google.com', ...(nonce && { nonce }) }).toString(),
      requestUri: appAddress(), returnSecureToken: true,
    }),
  });
}

function takeSavedGoogleState() {
  try {
    const saved = JSON.parse(localStorage.getItem(GOOGLE_STATE_KEY));
    localStorage.removeItem(GOOGLE_STATE_KEY);
    return saved;
  } catch {
    return null;
  }
}

// Runs when the page opens. Google's answer sits after the # in the address, so it is removed at once.
export async function finishGoogleSignIn() {
  const answer = new URLSearchParams(location.hash.slice(1));
  if (!answer.has('id_token') && !answer.has('error')) return null;
  history.replaceState(null, '', location.pathname + location.search);
  const saved = takeSavedGoogleState();
  if (answer.get('error') === 'access_denied') return null;
  const token = answer.get('id_token');
  if (!token || !saved || answer.get('state') !== saved.state) throw fail('GOOGLE', 'Google sign-in did not finish. Please try again.');
  let result = await exchangeGoogleToken(token, saved.nonce);
  if (!result.ok && /NONCE/.test(result.body.error?.message || '')) result = await exchangeGoogleToken(token);
  if (result.ok) return toAccount(result.body, result.body.email);
  const code = (result.body.error?.message || '').split(' ')[0];
  throw fail(code, AUTH_MESSAGES[code] || 'Could not sign in with Google. Try again.');
}

export async function sendPasswordReset(email) {
  const { ok, body } = await send(`${AUTH_URL}:sendOobCode?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
  });
  if (ok) return;
  const code = (body.error?.message || '').split(' ')[0];
  throw fail(code, AUTH_MESSAGES[code] || 'Could not send the email. Try again.');
}

// Sign-in passes last about an hour, and the refresh token renews them without a password.
export async function freshAccount(account) {
  if (account.expiresAt > Date.now() + 60000) return account;
  const { ok, body } = await send(`${TOKEN_URL}?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: account.refreshToken }),
  });
  if (!ok) throw fail('SIGNED_OUT', 'Please sign in again.');
  return toAccount(body, account.email);
}

const libraryUrl = (account) => `${DB_URL}/users/${account.uid}/library/main`;
const bearer = (account) => ({ Authorization: `Bearer ${account.idToken}` });

function databaseError(status, body) {
  const text = body.error?.message || '';
  if (status === 401) return fail('SIGNED_OUT', 'Please sign in again.');
  if (/does not exist|has not been used|is disabled/i.test(text)) return fail('NO_DATABASE', 'The online library is not set up yet.');
  return fail('SERVER', 'The online library could not be reached.');
}

export async function readLibrary(account) {
  const { ok, status, body } = await send(libraryUrl(account), { headers: bearer(account) });
  if (ok) return { library: JSON.parse(body.fields.data.stringValue), updateTime: body.updateTime };
  if (status === 404 && !/does not exist/i.test(body.error?.message || '')) return null;
  throw databaseError(status, body);
}

// updateTime makes the write fail if another device saved first, so nothing is overwritten unseen.
export async function writeLibrary(account, library, updateTime) {
  const guard = updateTime ? `currentDocument.updateTime=${encodeURIComponent(updateTime)}` : 'currentDocument.exists=false';
  const { ok, status, body } = await send(`${libraryUrl(account)}?${guard}`, {
    method: 'PATCH',
    headers: { ...bearer(account), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { data: { stringValue: JSON.stringify(library) } } }),
  });
  if (ok) return;
  if (['FAILED_PRECONDITION', 'ALREADY_EXISTS', 'ABORTED'].includes(body.error?.status)) throw fail('CONFLICT', 'Another device saved first.');
  throw databaseError(status, body);
}
