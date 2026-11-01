// Accounts and online library storage, using Firebase's web APIs directly so the app stays light.
// Only the library is sent here. Patient reports never are.

// This key only names the project. The database rules are what keep each account's data private.
const API_KEY = 'AIzaSyBYt8EsaKfIjghujhO9MlHVaV_TTqU5Zrw';
const PROJECT = 'quickds-28e44';
const APP_ID = '1:1052668817957:web:857b6bde2fe88df29285cc';
const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.14.1';
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

const GOOGLE_MESSAGES = {
  'auth/popup-blocked': 'Your browser blocked the Google window. Allow pop-ups and try again.',
  'auth/operation-not-allowed': 'Google sign-in is not switched on for this app yet.',
  'auth/unauthorized-domain': 'Google sign-in is not allowed from this address yet.',
  'auth/network-request-failed': 'No connection. Try again when you are online.',
};
const CLOSED_BY_USER = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled'];

// Google's window needs Firebase's own code. It loads only here, so the rest of the app has none of it.
let googleAuth;
async function loadGoogleAuth() {
  try {
    const [app, auth] = await Promise.all([import(`${FIREBASE_SDK}/firebase-app.js`), import(`${FIREBASE_SDK}/firebase-auth.js`)]);
    googleAuth ||= {
      ...auth,
      instance: auth.initializeAuth(app.initializeApp({ apiKey: API_KEY, authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT, appId: APP_ID }), {
        persistence: auth.inMemoryPersistence, popupRedirectResolver: auth.browserPopupRedirectResolver,
      }),
    };
    return googleAuth;
  } catch {
    throw fail('OFFLINE', 'No connection. Try again when you are online.');
  }
}

export async function signInWithGoogle() {
  const auth = await loadGoogleAuth();
  try {
    const { user } = await auth.signInWithPopup(auth.instance, new auth.GoogleAuthProvider());
    const { token, expirationTime } = await user.getIdTokenResult();
    return { uid: user.uid, email: user.email, idToken: token, refreshToken: user.refreshToken, expiresAt: Date.parse(expirationTime) };
  } catch (error) {
    if (CLOSED_BY_USER.includes(error.code)) return null;
    throw fail(error.code, GOOGLE_MESSAGES[error.code] || 'Could not sign in with Google. Try again.');
  }
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
