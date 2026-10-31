// All data stays in this browser. Storage can be blocked, so reads and writes never throw.

const KEYS = { library: 'dd.library.v1', reports: 'dd.reports.v1', settings: 'dd.settings.v1' };
const memory = new Map();

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

export const loadLibrary = () => read(KEYS.library);
export const saveLibrary = (lib) => write(KEYS.library, lib);
export const loadReports = () => read(KEYS.reports) || [];
export const saveReports = (reports) => write(KEYS.reports, reports);
export const loadSettings = () => ({ author: '', email: '', reportHeading: '', keepDays: 14, ...(read(KEYS.settings) || {}) });
export const saveSettings = (settings) => write(KEYS.settings, settings);

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
