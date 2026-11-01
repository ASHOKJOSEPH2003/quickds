// Everything is kept in this browser. Storage can be blocked, so reads and writes never throw.

const ACCOUNT_KEY = 'dd.account.v1';
const USER_KEYS = { library: 'dd.library.v1', reports: 'dd.reports.v1', settings: 'dd.settings.v1', synced: 'dd.synced.v1' };
const memory = new Map();
let owner = '';

const userKey = (name) => (owner ? `${USER_KEYS[name]}.${owner}` : USER_KEYS[name]);

// A null key means all storage was cleared.
export const isAppKey = (key) => key === null || key.startsWith('dd.');

// Each account has its own data, so people sharing a computer never see each other's reports.
// Work from before accounts existed goes to the first person to sign in here.
export function useAccount(uid) {
  owner = uid;
  try {
    for (const name of Object.keys(USER_KEYS)) {
      const earlier = localStorage.getItem(USER_KEYS[name]);
      if (earlier === null) continue;
      if (localStorage.getItem(userKey(name)) === null) localStorage.setItem(userKey(name), earlier);
      localStorage.removeItem(USER_KEYS[name]);
    }
  } catch {
    // Blocked storage falls back to memory, which has nothing to move.
  }
}

function read(key) {
  try {
    const raw = localStorage.getItem(key) ?? memory.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  const raw = JSON.stringify(value);
  memory.set(key, raw);
  try {
    localStorage.setItem(key, raw);
    return true;
  } catch {
    return false;
  }
}

export const loadLibrary = () => read(userKey('library'));
export const saveLibrary = (lib) => write(userKey('library'), lib);
export const loadReports = () => read(userKey('reports')) || [];
export const saveReports = (reports) => write(userKey('reports'), reports);
export const loadSettings = () => ({ author: '', email: '', reportHeading: '', keepDays: 14, ...(read(userKey('settings')) || {}) });
export const saveSettings = (settings) => write(userKey('settings'), settings);
export const loadSynced = () => read(userKey('synced'));
export const saveSynced = (lib) => write(userKey('synced'), lib);
export const loadAccount = () => read(ACCOUNT_KEY);
export const saveAccount = (account) => write(ACCOUNT_KEY, account);

export function purgeOldReports(reports, keepDays, now = Date.now()) {
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  return reports.filter((r) => r.updatedAt >= cutoff);
}

// Asks the browser not to clear this data when the phone runs low on space.
export async function requestPersistence() {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
