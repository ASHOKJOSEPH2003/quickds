import * as E from './engine.js';
import * as Store from './store.js';
import * as Sync from './sync.js';
import { buildStarterLibrary } from './seed.js';

const { SOURCE } = E;
const FREQUENCIES = ['OD', 'BD', 'TDS', 'QID', 'HS', 'SOS', '1-0-0', '0-0-1', '1-0-1', '1-1-1', 'Once weekly'];
const SECTION_NAMES = ['History', 'Examination', 'Investigations', 'Hospital course', 'Procedures', 'Follow-up'];
const PLACEHOLDERS = '{name} {age} {sex} {hospitalNo} {mrd} {unit} {ward} {admitted} {discharged} {diagnosis} {diagnoses} {medicines}';
const CREATE_TYPE = '__create_type';
// Set to false only after the hospital approves use with real patients.
const TEST_PHASE = true;
const SYNC_AFTER_EDIT_MS = 2000;
const SYNC_CHECK_MS = 30000;

const signedIn = Store.loadAccount();
if (signedIn) Store.useAccount(signedIn.uid);

const S = {
  view: 'report',
  lib: E.upgradeLibrary(Store.loadLibrary() || buildStarterLibrary()),
  settings: Store.loadSettings(),
  reports: [],
  report: null,
  showIdentifiers: true,
  outputMode: 'text',
  libraryTab: 'diagnoses',
  libraryQuery: '',
  editing: null,
  diagQuery: '',
  account: signedIn,
  syncStatus: '',
  syncBadge: '',
};

// ---------- Small helpers ----------

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  kids.flat(Infinity).forEach((kid) => {
    if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  });
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (['value', 'checked', 'disabled', 'hidden', 'selected'].includes(key)) el[key] = value;
    else if (value !== null && value !== undefined && value !== false) el.setAttribute(key, value === true ? '' : value);
  }
  return el;
}

const byId = (id) => document.getElementById(id);

let toastTimer;
function toast(message, undo) {
  const el = byId('toast');
  el.replaceChildren(h('span', {}, message));
  if (undo) el.append(h('button', { onclick: () => { el.hidden = true; undo(); } }, 'Undo'));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, undo ? 7000 : 3500);
}

function askDialog(content, actions) {
  const dialog = byId('dialog');
  return new Promise((resolve) => {
    const done = (value) => { dialog.close(); resolve(value); };
    dialog.replaceChildren(h('div', { class: 'dialog-body' }, content,
      h('div', { class: 'dialog-actions' }, actions.map(([label, value, cls]) =>
        h('button', { class: `btn ${cls || ''}`, type: 'button', onclick: () => done(value) }, label)))));
    dialog.showModal();
  });
}

const confirmAction = (message, label = 'Delete') =>
  askDialog(h('p', {}, message), [['Cancel', false], [label, true, 'primary']]);

let saveTimer;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

function saveNow() {
  clearTimeout(saveTimer);
  if (!S.account) return;
  Store.saveLibrary(S.lib);
  const saved = Store.saveReports(S.reports);
  if (!saved) toast('This device is out of storage or blocks it. Copy your report before closing.');
  syncSoon();
}

// ---------- Library sync ----------

let syncTimer;
let syncing = false;
let syncedRaw = '';

function syncSoon() {
  if (!S.account || JSON.stringify(S.lib) === syncedRaw) return;
  showSyncStatus('Saving', 'Saving your library.');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncLibrary, SYNC_AFTER_EDIT_MS);
}

function showSyncStatus(badge, text) {
  S.syncBadge = badge;
  S.syncStatus = text;
  const shown = byId('sync-badge');
  if (shown) shown.textContent = badge;
  const status = byId('sync-status');
  if (status) status.textContent = text;
}

function useLibrary(lib) {
  S.lib = lib;
  E.syncReport(S.report, S.lib);
  Store.saveLibrary(S.lib);
  render();
}

const showOffline = () => showSyncStatus('Offline', 'Offline. Your library will sync when you reconnect.');

function syncFailed(error) {
  if (error.code === 'SIGNED_OUT') {
    signOut();
  } else if (error.code === 'OFFLINE') {
    showOffline();
  } else {
    showSyncStatus('Waiting', `${error.message} Your library is safe on this device and will sync automatically.`);
  }
}

// Brings this device and the online copy together. Changes made on only one side carry over,
// and when both sides changed the same text, both wordings are kept.
async function syncLibrary(retry = true) {
  if (!S.account || syncing) return;
  if (!navigator.onLine) { showOffline(); return; }
  syncing = true;
  clearTimeout(syncTimer);
  syncTimer = 0;
  let tryAgain = false;
  try {
    S.account = await Sync.freshAccount(S.account);
    Store.saveAccount(S.account);
    const remote = await Sync.readLibrary(S.account);
    const merged = remote ? E.mergeLibraries(Store.loadSynced() || buildStarterLibrary(), S.lib, remote.library) : E.mergeLibraries(S.lib, S.lib, S.lib);
    if (E.sameLibrary(merged, S.lib)) {
      E.copySyncIds(S.lib, merged);
      Store.saveLibrary(S.lib);
    } else if (isBusy()) {
      syncTimer = setTimeout(syncLibrary, SYNC_AFTER_EDIT_MS);
      return;
    } else {
      useLibrary(merged);
    }
    // Taken before the upload, so an edit made while it runs still counts as new.
    const uploaded = JSON.stringify(merged);
    const current = JSON.stringify(S.lib);
    if (!remote || !E.sameLibrary(merged, remote.library)) await Sync.writeLibrary(S.account, merged, remote?.updateTime);
    Store.saveSynced(JSON.parse(uploaded));
    syncedRaw = current;
    showSyncStatus('Synced', 'Library synced automatically.');
    syncSoon();
  } catch (error) {
    if (error.code === 'CONFLICT' && retry) tryAgain = true;
    else syncFailed(error);
  } finally {
    syncing = false;
  }
  if (tryAgain) await syncLibrary(false);
}

function signOut() {
  saveNow();
  Store.saveAccount(null);
  location.reload();
}

// Another tab saved. Take its copy, so closing this tab cannot write older data over it.
function takeOtherTabData(event) {
  if (!Store.isAppKey(event.key)) return;
  const account = Store.loadAccount();
  if (account?.uid !== S.account?.uid) { location.reload(); return; }
  S.account = account;
  if (!S.account) return;
  const wasSaved = S.reports.includes(S.report);
  S.lib = E.upgradeLibrary(Store.loadLibrary() || S.lib);
  S.settings = Store.loadSettings();
  S.reports = Store.loadReports();
  const current = S.reports.find((r) => r.id === S.report.id);
  if (current) S.report = current;
  else if (wasSaved) startReport();
  E.syncReport(S.report, S.lib);
  render();
}

function touchReport() {
  if (!S.report) return;
  S.report.updatedAt = Date.now();
  if (!S.reports.includes(S.report)) S.reports.unshift(S.report);
  saveSoon();
}

const isBlank = (report) => !report.diagnoses.length && !Object.values(report.patient).some(Boolean)
  && !report.sections.some((s) => E.sectionText(s, report));

function startReport() {
  const report = E.newReport(S.lib);
  report.patient.writtenBy = S.settings.author;
  S.report = report;
  S.reports = S.reports.filter((r) => !isBlank(r));
  S.diagQuery = '';
  S.showIdentifiers = true;
}

function go(view) {
  S.view = view;
  S.editing = null;
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// ---------- Copy and send ----------

// The Windows text box needs CRLF line endings to show line breaks.
const forClipboard = (text) => (/Win/.test(navigator.platform) ? text.replace(/\n/g, '\r\n') : text);

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(forClipboard(text));
    toast(message);
    return true;
  } catch {
    showCopyFallback(text);
    return false;
  }
}

function showCopyFallback(text) {
  const area = h('textarea', { rows: 10, readonly: true, value: text, 'aria-label': 'Report text' });
  askDialog(h('div', { class: 'dialog-body' }, h('p', {}, 'This browser blocked copying. Select the text and copy it yourself.'), area), [['Close', true, 'primary']]);
  area.select();
}

const reportText = () => E.buildOutput(S.report, { identifiers: S.showIdentifiers });
const onPhone = () => matchMedia('(pointer: coarse)').matches;

async function shareOnPhone(text) {
  if (!onPhone() || !navigator.share) return false;
  try {
    await navigator.share({ text });
    return true;
  } catch (error) {
    return error.name === 'AbortError';
  }
}

// Report text is never put in a link: wa.me and mailto URLs would carry it to third parties and browser history.
async function sendWhatsApp() {
  const text = reportText();
  if (await shareOnPhone(text)) return;
  await copyText(text, 'Copied. Paste it into the WhatsApp chat.');
  window.open(onPhone() ? 'whatsapp://send' : 'https://web.whatsapp.com/', '_blank', 'noopener');
}

async function sendEmail() {
  const text = reportText();
  if (await shareOnPhone(text)) return;
  await copyText(text, 'Copied. Paste it into the email.');
  const to = encodeURIComponent(S.settings.email || '');
  window.location.href = `mailto:${to}?subject=${encodeURIComponent('Discharge summary draft')}`;
}

function downloadFile(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- Shell ----------

function render() {
  const views = { report: renderReportView, library: renderLibraryView, saved: renderSavedView, setup: renderSetupView };
  const nav = [['report', 'Report'], ['library', 'Library'], ['saved', 'Saved'], ['setup', 'Setup']];
  byId('app').replaceChildren(
    h('header', { class: 'topbar' }, h('div', { class: 'topbar-inner' },
      h('div', { class: 'brand' }, 'QuickDS'),
      h('span', { class: 'sync-badge', id: 'sync-badge', role: 'status', 'aria-label': 'Library sync' }, S.syncBadge),
      h('nav', { class: 'nav', 'aria-label': 'Main' }, nav.map(([view, label]) =>
        h('button', { type: 'button', onclick: () => go(view), 'aria-current': S.view === view ? 'page' : null }, label))))),
    views[S.view](),
  );
  if (S.view === 'report') refreshAll();
}

// ---------- Report view ----------

function renderReportView() {
  return h('div', {},
    h('main', { class: 'page' }, h('div', { class: 'layout' },
      h('div', { class: 'column' },
        renderPatientCard(),
        renderDiagnosisCard(),
        h('div', { class: 'column', id: 'sections' }),
        renderAddSection()),
      h('aside', { class: 'output-col', id: 'output', 'aria-label': 'Report output' }))),
    h('div', { class: 'action-bar' },
      h('span', { class: 'hint', id: 'bar-status' }),
      h('button', { class: 'btn primary', type: 'button', onclick: () => byId('output').scrollIntoView() }, 'Review and send')));
}

function patientField(key, label, attrs = {}) {
  return h('label', { class: `field ${attrs.class || ''}` }, label,
    h('input', {
      id: `p-${key}`, type: attrs.type || 'text', value: S.report.patient[key] || '', list: attrs.list, autocomplete: 'off',
      inputmode: attrs.inputmode, placeholder: attrs.placeholder,
      oninput: (e) => { S.report.patient[key] = e.target.value; refreshAfterEdit(); },
    }));
}

function renderPatientCard() {
  const p = S.report.patient;
  return h('section', { class: 'card', 'aria-label': 'Patient' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Patient'),
      h('div', { class: 'row' },
        h('button', { class: 'btn quiet small', type: 'button', onclick: loadExample }, 'Load example'),
        h('button', { class: 'btn small', type: 'button', onclick: () => { startReport(); render(); } }, 'New report'))),
    h('div', { class: 'grid-patient' },
      patientField('hospitalNo', 'Hospital No'),
      patientField('mrd', 'MRD No'),
      patientField('name', 'Patient name', { class: 'span-2' }),
      patientField('age', 'Age', { inputmode: 'numeric' }),
      h('label', { class: 'field' }, 'Sex', h('select', {
        id: 'p-sex', value: p.sex,
        onchange: (e) => { p.sex = e.target.value; refreshAfterEdit(); },
      }, ['', 'Female', 'Male', 'Other'].map((v) => h('option', { value: v }, v || 'Select')))),
      patientField('admitted', 'Admitted on', { type: 'date' }),
      patientField('discharged', 'Discharge on', { type: 'date' }),
      patientField('unit', 'Unit', { class: 'span-2' }),
      patientField('ward', 'Ward'),
      patientField('specialty', 'Specialty')),
    h('details', {}, h('summary', {}, 'More details'), h('div', { class: 'grid-patient' },
      patientField('address', 'Address', { class: 'span-2' }),
      patientField('mobile', 'Mobile', { inputmode: 'tel' }),
      patientField('approvedBy', 'Approved by'),
      patientField('writtenBy', 'Written by', { class: 'span-2' }))));
}

function loadExample() {
  startReport();
  Object.assign(S.report.patient, { hospitalNo: 'EX12345', mrd: 'EX-0001', name: 'Asha Example', age: '45', sex: 'Female', unit: 'Example Unit', ward: 'Ward 1', admitted: '2026-10-20', discharged: '2026-10-27' });
  for (const name of ['Anaemia', 'Hypothyroidism']) {
    const diag = E.findExact(S.lib.diagnoses, name);
    if (diag) E.addDiagnosisToReport(S.report, S.lib, diag.id);
  }
  E.syncReport(S.report, S.lib);
  touchReport();
  render();
  toast('Example patient loaded. This is not a real person.');
}

function renderDiagnosisCard() {
  const search = h('input', {
    id: 'diag-search', type: 'search', placeholder: 'Search or add a diagnosis', value: S.diagQuery, autocomplete: 'off',
    'aria-label': 'Search or add a diagnosis',
    oninput: (e) => { S.diagQuery = e.target.value; renderDiagList(); },
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      pickFromSearch();
    },
  });
  return h('section', { class: 'card', 'aria-label': 'Diagnosis' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Diagnosis'), h('span', { class: 'hint' }, 'Select one or more')),
    h('div', { class: 'chips', id: 'diag-chips' }),
    search,
    h('div', { class: 'pick-list', id: 'diag-list', role: 'group', 'aria-label': 'Diagnoses' }));
}

function pickFromSearch() {
  const query = E.cleanName(S.diagQuery);
  if (!query) return;
  const match = E.findExact(S.lib.diagnoses, query);
  if (match) addDiagnosis(match.id);
  else {
    const top = E.searchItems(S.lib.diagnoses, query)[0];
    if (top) addDiagnosis(top.id);
    else addCustomDiagnosis(query);
  }
  S.diagQuery = '';
  byId('diag-search').value = '';
  renderDiagList();
}

function addDiagnosis(id) {
  E.addDiagnosisToReport(S.report, S.lib, id);
  afterDiagnosisChange();
}

function addCustomDiagnosis(name) {
  const diag = E.addDiagnosis(S.lib, name, S.settings.author);
  if (!diag) return;
  addDiagnosis(diag.id);
  toast(`Added "${diag.name}" to your diagnosis list.`);
}

function removeDiagnosis(id) {
  const snapshot = JSON.stringify(S.report);
  const name = S.report.diagnoses.find((d) => d.id === id)?.name;
  E.removeDiagnosisFromReport(S.report, id);
  afterDiagnosisChange();
  toast(`Removed ${name}.`, () => {
    Object.assign(S.report, JSON.parse(snapshot));
    afterDiagnosisChange();
  });
}

function toggleDiagnosis(id) {
  if (S.report.diagnoses.some((d) => d.id === id)) removeDiagnosis(id);
  else addDiagnosis(id);
}

function afterDiagnosisChange() {
  E.syncReport(S.report, S.lib);
  touchReport();
  refreshAll();
}

function pickRow(diag) {
  const selected = S.report.diagnoses.some((d) => d.id === diag.id);
  const alias = diag.aliases?.slice(0, 2).join(', ');
  return h('button', { class: 'pick-row', type: 'button', 'aria-pressed': String(selected), onclick: () => toggleDiagnosis(diag.id) },
    h('span', { class: 'tick', 'aria-hidden': 'true' }, selected ? '✓' : ''),
    h('span', {}, diag.name),
    alias && h('span', { class: 'alias' }, alias));
}

function renderDiagList() {
  const list = byId('diag-list');
  if (!list) return;
  const query = E.cleanName(S.diagQuery);
  const rows = [];
  if (query) {
    const results = E.searchItems(S.lib.diagnoses, query);
    rows.push(results.slice(0, 30).map(pickRow));
    if (!E.findExact(S.lib.diagnoses, query)) {
      rows.push(h('button', {
        class: 'pick-row add', type: 'button',
        onclick: () => { addCustomDiagnosis(query); S.diagQuery = ''; byId('diag-search').value = ''; renderDiagList(); },
      }, `+ Add "${query}" as a new diagnosis`));
    }
  } else {
    rows.push(h('div', { class: 'pick-group' }, 'Most used'), E.mostUsed(S.lib.diagnoses).map(pickRow));
    let letter = '';
    for (const diag of [...S.lib.diagnoses].sort(E.byName)) {
      const first = diag.name.charAt(0).toUpperCase();
      if (first !== letter) {
        letter = first;
        rows.push(h('div', { class: 'pick-group' }, letter));
      }
      rows.push(pickRow(diag));
    }
  }
  list.replaceChildren(...rows.flat());
}

function renderChips() {
  const chips = byId('diag-chips');
  if (!chips) return;
  chips.hidden = !S.report.diagnoses.length;
  chips.replaceChildren(...S.report.diagnoses.map((d) => h('span', { class: 'chip' }, d.name,
    h('button', { type: 'button', 'aria-label': `Remove ${d.name}`, onclick: () => removeDiagnosis(d.id) }, '×'))));
}

// ---------- Sections ----------

function sourceOptions() {
  return [[SOURCE.NONE, 'Blank'], [SOURCE.DIAGNOSES, 'Diagnosis line'], [SOURCE.SUMMARY, 'Auto summary'],
    ...S.lib.types.filter((t) => !t.own).map((t) => [t.id, t.name]), [SOURCE.MEDICINES, 'Prescription'], [CREATE_TYPE, '+ New kind of text…']];
}

function sourceSelect(value, onChange, id) {
  return h('select', { id, value, 'aria-label': 'Auto-fill this section with', title: 'Auto-fill this section with', onchange: onChange },
    sourceOptions().map(([v, label]) => h('option', { value: v }, label)));
}

async function promptText(title, label, value = '') {
  const input = h('input', { type: 'text', value, 'aria-label': label });
  const ok = await askDialog(h('div', { class: 'dialog-body' }, h('h2', {}, title), h('label', { class: 'field' }, label, input)),
    [['Cancel', false], ['Save', true, 'primary']]);
  return ok ? E.cleanName(input.value) : '';
}

async function createType(suggestion = '') {
  const name = await promptText('New kind of text', 'Name, for example Warning signs', suggestion);
  if (!name) return null;
  const existing = E.findExact(S.lib.types, name);
  if (existing) {
    delete existing.own;
    return existing.id;
  }
  const type = { id: `t-${E.uid()}`, name };
  S.lib.types.push(type);
  saveSoon();
  return type.id;
}

async function changeSource(section, value) {
  const source = value === CREATE_TYPE ? await createType(section.title) : value;
  if (source) {
    const hadEdits = section.edited || section.blocks.some((b) => b.text !== b.base);
    const go_ = !hadEdits || await confirmAction('Changing this replaces the text you edited in this section.', 'Replace');
    if (go_) Object.assign(section, { source, blocks: [], text: '', edited: false });
  }
  E.syncReport(S.report, S.lib);
  touchReport();
  refreshAll();
}

function moveSection(index, step) {
  const list = S.report.sections;
  const [section] = list.splice(index, 1);
  list.splice(index + step, 0, section);
  touchReport();
  refreshAll();
}

async function deleteSection(section) {
  const hasText = E.sectionText(section, S.report) && section.source === SOURCE.NONE;
  if (hasText && !await confirmAction(`Delete the "${section.title}" section and its text?`)) return;
  const snapshot = JSON.stringify(S.report.sections);
  S.report.sections = S.report.sections.filter((s) => s !== section);
  S.report.dismissed ||= [];
  if (section.auto) S.report.dismissed.push(section.source);
  touchReport();
  refreshAll();
  toast(`Removed ${section.title}.`, () => {
    S.report.sections = JSON.parse(snapshot);
    S.report.dismissed = S.report.dismissed.filter((id) => id !== section.source);
    touchReport();
    refreshAll();
  });
}

function renderSections() {
  const host = byId('sections');
  if (!host) return;
  host.replaceChildren(...S.report.sections.map(renderSection));
}

function renderSection(section, index) {
  const count = S.report.sections.length;
  return h('section', { class: 'card', 'aria-label': section.title },
    h('div', { class: 'sec-head' },
      h('input', {
        class: 'sec-title', type: 'text', id: `title-${section.id}`, value: section.title, 'aria-label': 'Section name',
        oninput: (e) => { section.title = e.target.value; refreshAfterEdit(); },
      }),
      section.auto ? h('span', { class: 'tag' }, 'For this diagnosis') : sourceSelect(section.source, (e) => changeSource(section, e.target.value), `source-${section.id}`),
      h('div', { class: 'sec-tools' },
        h('button', { class: 'icon', type: 'button', disabled: index === 0, 'aria-label': `Move ${section.title} up`, onclick: () => moveSection(index, -1) }, '↑'),
        h('button', { class: 'icon', type: 'button', disabled: index === count - 1, 'aria-label': `Move ${section.title} down`, onclick: () => moveSection(index, 1) }, '↓'),
        h('button', { class: 'icon', type: 'button', 'aria-label': `Delete ${section.title}`, onclick: () => deleteSection(section) }, '×'))),
    renderSectionBody(section));
}

function renderSectionBody(section) {
  if (section.source === SOURCE.MEDICINES) return [renderMedicines(), noteField(section, 'Other prescription notes')];
  if (section.source === SOURCE.DIAGNOSES) return renderAutoText(section);
  if (section.source === SOURCE.SUMMARY) {
    return [
      renderAutoText(section, { label: 'Opening' }),
      section.blocks.map((block) => renderBlock(section, block)),
      renderAutoText(section, { label: 'Closing', textKey: 'closing', editedKey: 'closingEdited' }),
    ];
  }
  if (section.source === SOURCE.NONE) {
    return h('textarea', {
      id: `note-${section.id}`, rows: 3, value: section.note, placeholder: `Type ${section.title.toLowerCase()} here`, 'aria-label': section.title,
      oninput: (e) => { section.note = e.target.value; refreshAfterEdit(); },
    });
  }
  const type = S.lib.types.find((t) => t.id === section.source);
  if (!section.blocks.length) {
    return h('p', { class: 'hint' }, `Select a diagnosis and its ${type?.name.toLowerCase() || 'text'} appears here.`);
  }
  return [section.blocks.map((block) => renderBlock(section, block)), noteField(section, 'Add a note for this section')];
}

function noteField(section, label) {
  return h('textarea', {
    id: `note-${section.id}`, rows: 1, value: section.note, placeholder: label, 'aria-label': label,
    oninput: (e) => { section.note = e.target.value; refreshAfterEdit(); },
  });
}

function renderAutoText(section, { label = section.title, textKey = 'text', editedKey = 'edited' } = {}) {
  const reset = h('button', {
    class: 'btn quiet small', type: 'button', hidden: !section[editedKey],
    onclick: () => { section[editedKey] = false; E.syncReport(S.report, S.lib); touchReport(); refreshAll(); },
  }, 'Use automatic text');
  const empty = section.source === SOURCE.DIAGNOSES ? 'Selected diagnoses appear here.' : 'Select a diagnosis and this is written for you.';
  const area = h('textarea', {
    id: `${textKey}-${section.id}`, rows: 2, value: section[textKey] || '', placeholder: empty, 'aria-label': label,
    oninput: (e) => { section[textKey] = e.target.value; section[editedKey] = true; reset.hidden = false; refreshAfterEdit(); },
  });
  return section.source === SOURCE.SUMMARY ? h('label', { class: 'field' }, label, area, reset) : [area, reset];
}

function renderBlock(section, block) {
  const diag = S.lib.diagnoses.find((d) => d.id === block.diagId);
  const name = S.report.diagnoses.find((d) => d.id === block.diagId)?.name || '';
  const versions = diag?.content[section.source] || [];
  const edited = h('span', { class: 'tag good', hidden: block.text === block.base }, 'Edited');
  const reset = h('button', {
    class: 'btn quiet small push', type: 'button', hidden: block.text === block.base,
    onclick: () => { block.text = block.base; E.syncReport(S.report, S.lib); touchReport(); refreshAll(); },
  }, 'Reset');
  return h('div', { class: 'block' },
    h('div', { class: 'block-label' }, name,
      diag && !diag.reviewed && h('span', { class: 'tag flag' }, 'Not yet approved'),
      diag && !diag.reviewed && h('button', {
        class: 'btn quiet small', type: 'button',
        onclick: () => { diag.reviewed = true; saveSoon(); refreshAll(); toast(`${name} approved.`); },
      }, 'Approve'),
      !versions.length && section.source !== SOURCE.SUMMARY && h('span', { class: 'tag' }, 'No saved text yet'),
      versions.length > 1 && h('select', {
        id: `ver-${section.id}-${block.diagId}`, value: block.versionId, 'aria-label': `Version for ${name}`,
        onchange: (e) => {
          Object.assign(block, { versionId: e.target.value, text: '', base: '' });
          E.syncReport(S.report, S.lib);
          touchReport();
          refreshAll();
        },
      }, versions.map((v, i) => h('option', { value: v.id }, i ? `Version ${i + 1}` : 'Default'))),
      edited, reset),
    h('textarea', {
      id: `block-${section.id}-${block.diagId}`, rows: 3, value: block.text, 'aria-label': `${section.title} for ${name}`,
      placeholder: section.source === SOURCE.SUMMARY ? 'Add a note for this diagnosis, or leave blank' : null,
      oninput: (e) => {
        block.text = e.target.value;
        const same = block.text === block.base;
        edited.hidden = same;
        reset.hidden = same;
        refreshAfterEdit();
      },
    }));
}

function renderMedicines() {
  return h('div', { class: 'column' },
    S.report.meds.length ? S.report.meds.map(renderMedicine) : h('p', { class: 'hint' }, 'Medicines linked to the diagnosis appear here. You can add others below.'),
    medicinePicker((med) => {
      const added = E.addMedicineToReport(S.report, med);
      if (!added) toast(`${med.name} is already on this prescription.`);
      E.syncReport(S.report, S.lib);
      touchReport();
      refreshAll();
      byId('med-picker')?.focus();
    }, 'med-picker'));
}

function renderMedicine(med) {
  const field = (key, label, attrs = {}) => {
    const required = key !== 'notes';
    const input = h('input', {
      id: `med-${med.id}-${key}`, type: 'text', value: med[key], placeholder: label, 'aria-label': `${label} for ${med.name}`, list: attrs.list,
      class: required && !E.cleanName(med[key]) ? 'needs' : null, autocomplete: 'off',
      oninput: (e) => {
        med[key] = e.target.value;
        if (required) input.classList.toggle('needs', !E.cleanName(med[key]));
        refreshAfterEdit();
      },
    });
    return input;
  };
  const sources = med.fromDiag.map((id) => S.report.diagnoses.find((d) => d.id === id)?.name).filter(Boolean);
  return h('div', { class: 'med' },
    h('div', { class: 'med-top' },
      h('div', { class: 'med-name' }, med.name, ' ', sources.length ? h('span', { class: 'tag' }, sources.join(', ')) : h('span', { class: 'tag good' }, 'Added')),
      h('button', {
        class: 'icon', type: 'button', 'aria-label': `Remove ${med.name}`,
        onclick: () => {
          const snapshot = JSON.stringify(S.report);
          E.removeMedicineFromReport(S.report, med.id);
          E.syncReport(S.report, S.lib);
          touchReport();
          refreshAll();
          toast(`Removed ${med.name}.`, () => { Object.assign(S.report, JSON.parse(snapshot)); E.syncReport(S.report, S.lib); touchReport(); refreshAll(); });
        },
      }, '×')),
    h('div', { class: 'med-grid' },
      field('dose', 'Dose'),
      field('freq', 'Frequency', { list: 'frequencies' }),
      field('duration', 'Duration'),
      field('notes', 'Instructions')),
    h('datalist', { id: 'frequencies' }, FREQUENCIES.map((f) => h('option', { value: f }))));
}

function medicinePicker(onPick, id) {
  const list = h('ul', { class: 'suggest', hidden: true });
  const choose = (med) => {
    if (!med) return;
    input.value = '';
    list.hidden = true;
    onPick(med);
  };
  const addNew = (name) => choose(E.addMedicine(S.lib, name));
  const row = (label, onclick, cls = '') => h('li', {}, h('button', { class: `pick-row ${cls}`, type: 'button', onclick }, label));
  const show = () => {
    const query = E.cleanName(input.value);
    if (!query) { list.hidden = true; return; }
    const results = E.searchItems(S.lib.medicines, query).slice(0, 7);
    const rows = results.map((m) => row(m.name, () => choose(m)));
    if (!E.findExact(S.lib.medicines, query)) rows.push(row(`+ Add "${query}" as a new medicine`, () => addNew(query), 'add'));
    list.replaceChildren(...rows);
    list.hidden = false;
  };
  const input = h('input', {
    id, type: 'search', placeholder: 'Search or add a medicine', autocomplete: 'off', 'aria-label': 'Search or add a medicine',
    oninput: show,
    onblur: () => setTimeout(() => { list.hidden = true; }, 180),
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const query = E.cleanName(input.value);
      if (!query) return;
      const match = E.findExact(S.lib.medicines, query) || E.searchItems(S.lib.medicines, query)[0];
      if (match) choose(match);
      else addNew(query);
    },
  });
  return h('div', { class: 'suggest-wrap' }, input, list);
}

function renderAddSection() {
  const title = h('input', { id: 'new-section', type: 'text', placeholder: 'Section name, for example History', list: 'section-names', autocomplete: 'off', 'aria-label': 'New section name' });
  const source = sourceSelect(SOURCE.NONE, null, 'new-section-source');
  const add = async () => {
    const name = E.cleanName(title.value);
    if (!name) { title.focus(); return; }
    const chosen = source.value === CREATE_TYPE ? await createType(name) : source.value;
    if (!chosen) return;
    S.report.sections.push(E.newSection(name, chosen, S.lib));
    title.value = '';
    source.replaceChildren(...sourceOptions().map(([v, label]) => h('option', { value: v }, label)));
    source.value = SOURCE.NONE;
    E.syncReport(S.report, S.lib);
    touchReport();
    refreshAll();
  };
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  return h('section', { class: 'card', 'aria-label': 'Add a section' },
    h('h2', {}, 'Add a section'),
    h('datalist', { id: 'section-names' }, SECTION_NAMES.map((n) => h('option', { value: n }))),
    h('div', { class: 'sec-head' }, title, source, h('button', { class: 'btn', type: 'button', onclick: add }, 'Add')),
    h('button', {
      class: 'btn quiet small', type: 'button', style: 'justify-self:start',
      onclick: () => {
        S.lib.layout = S.report.sections.map((s) => ({ title: s.title, source: s.source }));
        saveSoon();
        toast('New reports will use these sections.');
      },
    }, 'Use these sections for new reports'));
}

// ---------- Output and feedback ----------

function refreshAfterEdit() {
  E.syncReport(S.report, S.lib);
  touchReport();
  // Patient edits can change untouched generated text, which is live in the form.
  for (const section of S.report.sections) {
    for (const key of ['text', 'closing']) {
      const auto = byId(`${key}-${section.id}`);
      if (auto && auto !== document.activeElement) auto.value = section[key] || '';
    }
    for (const block of section.blocks) {
      const area = byId(`block-${section.id}-${block.diagId}`);
      if (area && area !== document.activeElement) area.value = block.text;
    }
  }
  renderOutput();
}

function refreshAll() {
  renderChips();
  renderDiagList();
  renderSections();
  renderOutput();
}

function warnings() {
  const report = S.report;
  const list = [];
  const missing = report.meds.filter((m) => E.missingFields(m).length);
  if (missing.length) list.push(`${missing.length} ${missing.length === 1 ? 'medicine needs' : 'medicines need'} dose, frequency or duration.`);
  const unreviewed = report.diagnoses.filter((d) => {
    const diag = S.lib.diagnoses.find((x) => x.id === d.id);
    return diag && !diag.reviewed && report.sections.some((s) => s.blocks.some((b) => b.diagId === d.id && b.text === b.base && b.text));
  });
  if (unreviewed.length) list.push(`Text for ${E.joinList(unreviewed.map((d) => d.name))} has not been approved. Read it before use.`);
  return list;
}

function renderOutput() {
  const host = byId('output');
  if (!host) return;
  const report = S.report;
  const scroll = host.scrollTop;
  const alerts = warnings();
  const sections = report.sections.map((s) => ({ s, body: E.toPlainText(S.showIdentifiers ? E.sectionText(s, report) : E.redact(E.sectionText(s, report), report.patient)) })).filter((x) => x.body);
  const details = E.toPlainText(E.patientBlock(report.patient, { identifiers: S.showIdentifiers }));
  const status = byId('bar-status');
  if (status) status.textContent = alerts.length ? `${alerts.length} to check` : 'Ready';

  const outputCard = h('section', { class: 'card', 'aria-label': 'Report text' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Report'),
      h('div', { class: 'segmented small' }, [['text', 'Plain text'], ['report', 'Formatted']].map(([mode, label]) =>
        h('button', { type: 'button', 'aria-pressed': String(S.outputMode === mode), onclick: () => { S.outputMode = mode; renderOutput(); } }, label))),
      h('button', { class: 'btn primary small', type: 'button', disabled: !sections.length, onclick: () => copyText(reportText(), 'Report copied.') }, 'Copy all')),
    alerts.length > 0 && h('div', { class: 'alert', role: 'status' }, alerts.map((a) => h('div', {}, a))),
    !sections.length && h('p', { class: 'hint' }, 'Your report builds here as you select diagnoses and type.'),
    sections.length > 0 && S.outputMode === 'report' && h('div', { class: 'paper-wrap' }, reportDocument()),
    sections.length > 0 && S.outputMode === 'text' && details && h('div', { class: 'out-sec' },
      h('div', { class: 'out-head' }, h('h3', {}, 'Patient details'),
        h('button', { class: 'btn quiet small', type: 'button', 'aria-label': 'Copy Patient details', onclick: () => copyText(details, 'Patient details copied.') }, 'Copy')),
      h('pre', { class: 'out' }, details)),
    sections.length > 0 && S.outputMode === 'text' && sections.map(({ s, body }) => h('div', { class: 'out-sec' },
      h('div', { class: 'out-head' }, h('h3', {}, s.title),
        h('button', { class: 'btn quiet small', type: 'button', 'aria-label': `Copy ${s.title}`, onclick: () => copyText(body, `${s.title} copied.`) }, 'Copy')),
      h('pre', { class: 'out' }, body))));

  const sendCard = h('section', { class: 'card', 'aria-label': 'Send' },
    h('h2', {}, 'Send'),
    h('div', { class: 'send' },
      h('button', { class: 'btn', type: 'button', disabled: !sections.length, onclick: sendWhatsApp }, 'WhatsApp'),
      h('button', { class: 'btn', type: 'button', disabled: !sections.length, onclick: sendEmail }, 'Email'),
      h('button', { class: 'btn', type: 'button', disabled: !sections.length, onclick: () => downloadFile('discharge-summary.txt', reportText()) }, 'Save as .txt'),
      h('button', { class: 'btn', type: 'button', disabled: !sections.length, onclick: printReport }, 'Print or PDF'),
      h('button', { class: 'btn primary wide', type: 'button', disabled: !report.diagnoses.length, onclick: finishReport }, report.finishedAt ? 'Finished' : 'Finish report')),
    h('label', { class: 'check' },
      h('input', { id: 'show-ids', type: 'checkbox', checked: S.showIdentifiers, onchange: (e) => { S.showIdentifiers = e.target.checked; renderOutput(); } }),
      h('span', {}, 'Include patient details. Untick to replace them with a short reference before sending.')));

  const changes = E.collectChanges(report, S.lib);
  const teachCard = changes.length > 0 && h('section', { class: 'card', 'aria-label': 'Teach the app', id: 'teach' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Save for next time'), h('span', { class: 'tag' }, changes.length)),
    h('p', { class: 'hint' }, 'You changed these. Choose what future reports should use.'),
    changes.map(renderChange));

  host.replaceChildren(...[outputCard, teachCard, sendCard].filter(Boolean));
  host.scrollTop = scroll;
}

function reportDocument() {
  const model = E.buildReportModel(S.report, { identifiers: S.showIdentifiers });
  const cell = (value, label) => (value ? h('td', {}, value) : h('td', { class: 'needs' }, `[${label}?]`));
  return h('article', { class: 'doc' },
    h('header', { class: 'doc-head' },
      S.settings.reportHeading && h('div', { class: 'doc-org' }, S.settings.reportHeading),
      h('h1', {}, 'Discharge Summary')),
    model.patient.length > 0 && h('dl', { class: 'doc-patient' }, model.patient.map(([label, value]) => h('div', {}, h('dt', {}, label), h('dd', {}, value)))),
    model.sections.map((section) => h('section', { class: 'doc-sec' },
      h('h2', {}, section.title),
      section.medicines.length > 0 && h('div', { class: 'doc-table' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Medicine', 'Dose', 'Frequency', 'Duration', 'Instructions'].map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', {}, section.medicines.map((m) => h('tr', {}, h('td', {}, m.name), cell(m.dose, 'dose'), cell(m.freq, 'frequency'), cell(m.duration, 'duration'), h('td', {}, m.notes)))))),
      section.paragraphs.map((text) => h('p', {}, text)))),
    h('footer', { class: 'doc-sign' }, model.signers.map(([label, value]) => h('div', {}, h('div', { class: 'doc-sign-line' }, value || '\u00A0'), label))));
}

function printReport() {
  // The trial link runs in a locked frame, where browsers ignore window.print().
  if (window.self !== window.top) { toast('Printing is blocked on the trial link. It works once the app is hosted.'); return; }
  byId('print-report').replaceChildren(reportDocument());
  window.print();
}

function renderChange(change) {
  const act = (action, opts) => {
    E.applyChange(change, action, S.report, S.lib, { by: S.settings.author, ...opts });
    E.syncReport(S.report, S.lib);
    touchReport();
    saveNow();
    refreshAll();
    if (action !== 'skip') toast('Saved for future reports.');
  };
  const button = (label, action, cls = '', opts) => h('button', { class: `btn small ${cls}`, type: 'button', onclick: () => act(action, opts && opts()) }, label);
  const skip = button('Just this patient', 'skip', 'quiet');

  if (change.kind === 'text') {
    return h('div', { class: 'change' },
      h('strong', {}, `${change.diagName}: ${change.sectionTitle}`),
      h('div', { class: 'diff' }, E.diffWords(change.before, change.after).map((p) => (p.kind === 'same' ? p.text : h('span', { class: p.kind }, p.text)))),
      change.warn && h('div', { class: 'alert' }, 'This may still hold a patient number or date. Remove it before saving.'),
      h('div', { class: 'row' }, button('Make default', 'default', 'primary'), button('Save as a version', 'version'), skip));
  }
  if (change.kind === 'med-add') {
    const select = change.targets.length > 1 && h('select', { id: `target-${change.key}`, 'aria-label': 'Add to which diagnosis' }, change.targets.map((d) => h('option', { value: d.id }, d.name)));
    const diagId = () => ({ diagId: select ? select.value : change.targets[0].id });
    return h('div', { class: 'change' },
      h('strong', {}, `Add ${change.med.name} to ${select ? 'a diagnosis' : change.targets[0].name}?`),
      change.seen > 0 && h('span', { class: 'hint' }, `Added by hand ${change.seen} ${change.seen === 1 ? 'time' : 'times'} before.`),
      select,
      h('div', { class: 'row' }, button('Add to defaults', 'add-med', 'primary', diagId), skip));
  }
  if (change.kind === 'med-values') {
    const m = change.med;
    return h('div', { class: 'change' },
      h('strong', {}, `${change.diagName}: ${m.name}`),
      h('span', {}, [m.dose, m.freq, m.duration, m.notes].filter(Boolean).join(' / ')),
      h('div', { class: 'row' }, button('Save as default', 'save-med', 'primary'), skip));
  }
  return h('div', { class: 'change' },
    h('strong', {}, `Stop adding ${change.name} for ${change.diagName}?`),
    h('div', { class: 'row' }, button('Remove from defaults', 'remove-med', 'primary'), skip));
}

async function finishReport() {
  if (S.report.finishedAt) { toast('This report is already finished.'); return; }
  const missing = warnings();
  if (missing.length && !await askDialog(h('div', { class: 'dialog-body' }, h('h2', {}, 'Finish with items unchecked?'), missing.map((m) => h('p', {}, m))), [['Go back', false], ['Finish anyway', true, 'primary']])) return;
  E.recordFinish(S.report, S.lib);
  touchReport();
  saveNow();
  startReport();
  go('saved');
  toast('Report finished. Usage counts updated.');
}

// ---------- Saved reports ----------

function renderSavedView() {
  const reports = [...S.reports].sort((a, b) => b.updatedAt - a.updatedAt);
  return h('main', { class: 'page narrow column' },
    h('div', { class: 'card-head' }, h('h1', { style: 'font-size:20px' }, 'Saved reports'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => { startReport(); go('report'); } }, 'New report')),
    h('p', { class: 'hint' }, `Saved only on this device. Removed automatically after ${S.settings.keepDays} days.`),
    h('div', { class: 'list' }, reports.length ? reports.map((r) => {
      const label = r.patient.name || r.patient.hospitalNo || 'Unnamed patient';
      return h('button', { class: 'list-row', type: 'button', onclick: () => { S.report = r; go('report'); } },
        h('span', { class: 'grow' }, h('strong', {}, label), h('br'), h('span', { class: 'hint' }, r.diagnoses.map((d) => d.name).join(', ') || 'No diagnosis yet')),
        h('span', { class: `tag ${r.finishedAt ? 'good' : 'flag'}` }, r.finishedAt ? 'Finished' : 'Draft'),
        h('span', { class: 'meta' }, new Date(r.updatedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })));
    }) : h('div', { class: 'empty' }, 'No saved reports on this device.')),
    reports.length > 0 && h('div', {}, h('button', {
      class: 'btn danger', type: 'button',
      onclick: async () => {
        if (!await confirmAction('Delete every saved report on this device? This cannot be undone.', 'Delete all')) return;
        S.reports = [];
        startReport();
        saveNow();
        render();
        toast('All patient reports deleted from this device.');
      },
    }, 'Delete all patient reports')));
}

// ---------- Library ----------

function renderLibraryView() {
  if (S.editing?.kind === 'diagnosis') return renderDiagnosisEditor();
  if (S.editing?.kind === 'medicine') return renderMedicineEditor();
  const tab = S.libraryTab;
  const results = h('div', { class: 'list', id: 'library-list' });
  const fillList = () => {
    const items = tab === 'diagnoses' ? S.lib.diagnoses : S.lib.medicines;
    const found = E.searchItems(items, S.libraryQuery);
    results.replaceChildren(...(found.length ? found.map((item) => h('button', {
      class: 'list-row', type: 'button',
      onclick: () => { S.editing = { kind: tab === 'diagnoses' ? 'diagnosis' : 'medicine', id: item.id }; render(); window.scrollTo({ top: 0, behavior: 'instant' }); },
    }, h('span', { class: 'grow' }, item.name),
    tab === 'diagnoses' && (item.reviewed ? h('span', { class: 'tag good' }, 'Approved') : h('span', { class: 'tag flag' }, 'Not yet approved')),
    h('span', { class: 'meta' }, item.useCount ? `Used ${item.useCount}` : ''))) : [h('div', { class: 'empty' }, 'Nothing matches. Add it with the button above.')]));
  };
  const add = () => {
    const name = E.cleanName(S.libraryQuery);
    if (!name) { byId('library-search').focus(); toast('Type the name first.'); return; }
    const isDiag = tab === 'diagnoses';
    const items = isDiag ? S.lib.diagnoses : S.lib.medicines;
    const existing = E.findExact(items, name);
    const item = existing || (isDiag ? E.addDiagnosis(S.lib, name, S.settings.author) : E.addMedicine(S.lib, name));
    if (existing) toast(`"${existing.name}" is already in the list.`);
    S.libraryQuery = '';
    S.editing = { kind: isDiag ? 'diagnosis' : 'medicine', id: item.id };
    saveSoon();
    render();
  };
  fillList();
  return h('main', { class: 'page narrow column' },
    h('div', { class: 'card-head' }, h('h1', { style: 'font-size:20px' }, 'Library'),
      h('div', { class: 'segmented' },
        h('button', { type: 'button', 'aria-pressed': String(tab === 'diagnoses'), onclick: () => { S.libraryTab = 'diagnoses'; render(); } }, `Diagnoses ${S.lib.diagnoses.length}`),
        h('button', { type: 'button', 'aria-pressed': String(tab === 'medicines'), onclick: () => { S.libraryTab = 'medicines'; render(); } }, `Medicines ${S.lib.medicines.length}`))),
    h('div', { class: 'row' },
      h('input', {
        id: 'library-search', class: 'grow', style: 'width:auto;flex:1', type: 'search', value: S.libraryQuery, placeholder: `Search ${tab}`, 'aria-label': `Search ${tab}`,
        oninput: (e) => { S.libraryQuery = e.target.value; fillList(); },
      }),
      h('button', { class: 'btn primary', type: 'button', onclick: add }, 'Add')),
    results);
}

const backToLibrary = () => { S.editing = null; saveNow(); render(); };

function libraryBar(title, onDelete) {
  return h('div', { class: 'card-head' },
    h('button', { class: 'btn', type: 'button', onclick: backToLibrary }, '← Library'),
    h('button', { class: 'btn danger', type: 'button', onclick: onDelete }, title));
}

function saveName(item, items, value, input) {
  const name = E.cleanName(value);
  const clash = E.findExact(items.filter((x) => x !== item), name);
  if (!name || clash) {
    input.value = item.name;
    toast(clash ? `"${clash.name}" already exists, so the name was not changed.` : 'A name is required.');
    return;
  }
  item.name = name;
  saveSoon();
}

function renderDiagnosisEditor() {
  const diag = S.lib.diagnoses.find((d) => d.id === S.editing.id);
  if (!diag) { S.editing = null; return renderLibraryView(); }
  const by = S.settings.author;
  const earlier = diag.history.filter((entry) => entry.typeId !== 'medicines');
  const rerender = () => { saveSoon(); const top = window.scrollY; render(); window.scrollTo({ top, behavior: 'instant' }); };

  const textCard = (type, hint) => {
    const versions = diag.content[type.id] || [];
    return h('section', { class: 'card', 'aria-label': type.name },
      h('h2', {}, type.name),
      hint && h('p', { class: 'hint' }, hint),
      h('textarea', {
        id: `def-${type.id}`, rows: 4, value: versions[0]?.text || '', placeholder: 'Text used by default for this diagnosis', 'aria-label': `Default ${type.name}`,
        onchange: (e) => { E.setDefaultText(S.lib, diag.id, type.id, e.target.value, by); saveSoon(); },
      }),
      versions.slice(1).map((v, i) => h('div', { class: 'block' },
        h('div', { class: 'block-label' }, `Version ${i + 2}`,
          h('button', { class: 'btn quiet small', type: 'button', onclick: () => { E.makeVersionDefault(S.lib, diag.id, type.id, v.id); rerender(); } }, 'Make default'),
          h('button', {
            class: 'btn quiet small', type: 'button',
            onclick: () => { diag.content[type.id] = versions.filter((x) => x !== v); rerender(); },
          }, 'Delete')),
        h('textarea', { rows: 3, value: v.text, 'aria-label': `${type.name} version ${i + 2}`, onchange: (e) => { v.text = e.target.value; saveSoon(); } }))),
      h('button', {
        class: 'btn quiet small', type: 'button', style: 'justify-self:start',
        onclick: () => { diag.content[type.id] ||= []; diag.content[type.id].push({ id: E.uid(), text: '', by, updatedAt: Date.now() }); rerender(); },
      }, '+ Add a version'));
  };

  const restoreEarlier = (entry) => {
    const removed = entry.title && !diag.sections?.includes(entry.typeId);
    const typeId = removed ? E.addDiagnosisSection(S.lib, diag.id, entry.title)?.id : entry.typeId;
    if (typeId) E.setDefaultText(S.lib, diag.id, typeId, entry.text, by);
  };
  const addOwnSection = async () => {
    const name = await promptText('New section', 'Section name, for example Insulin plan');
    if (!name) return;
    if (E.addDiagnosisSection(S.lib, diag.id, name)) rerender();
    else toast(`This diagnosis already has "${name}".`);
  };
  const moveOwnSection = (index, step) => {
    const [typeId] = diag.sections.splice(index, 1);
    diag.sections.splice(index + step, 0, typeId);
    rerender();
  };
  const ownSectionCard = (typeId, index) => {
    const type = S.lib.types.find((t) => t.id === typeId);
    if (!type) return null;
    const card = textCard(type);
    card.querySelector('h2').replaceWith(h('div', { class: 'sec-head own-head' },
      h('input', {
        class: 'sec-title', type: 'text', id: `own-title-${typeId}`, value: type.name, 'aria-label': 'Section name',
        onchange: (e) => {
          if (E.renameDiagnosisSection(S.lib, diag.id, typeId, e.target.value)) rerender();
          else { e.target.value = type.name; toast('That name is empty or already used here.'); }
        },
      }),
      h('div', { class: 'sec-tools' },
        h('button', { class: 'icon', type: 'button', disabled: index === 0, 'aria-label': `Move ${type.name} up`, onclick: () => moveOwnSection(index, -1) }, '↑'),
        h('button', { class: 'icon', type: 'button', disabled: index === diag.sections.length - 1, 'aria-label': `Move ${type.name} down`, onclick: () => moveOwnSection(index, 1) }, '↓'),
        h('button', {
          class: 'icon', type: 'button', 'aria-label': `Delete ${type.name}`,
          onclick: async () => {
            if (!await confirmAction(`Delete "${type.name}" from ${diag.name}? Its text moves to Earlier text.`)) return;
            E.removeDiagnosisSection(S.lib, diag.id, typeId);
            rerender();
          },
        }, '×'))));
    return card;
  };

  const medRow = (med) => h('div', { class: 'med' },
    h('div', { class: 'med-top' },
      h('input', { class: 'med-name', type: 'text', value: med.name, 'aria-label': 'Medicine name', onchange: (e) => saveName(med, diag.meds, e.target.value, e.target) }),
      h('button', { class: 'icon', type: 'button', 'aria-label': `Remove ${med.name}`, onclick: () => { E.removeDiagnosisMedicine(S.lib, diag.id, med.name); rerender(); } }, '×')),
    h('div', { class: 'med-grid' }, [['dose', 'Dose'], ['freq', 'Frequency'], ['duration', 'Duration'], ['notes', 'Instructions']].map(([key, label]) =>
      h('input', { type: 'text', value: med[key], placeholder: label, 'aria-label': `${label} for ${med.name}`, oninput: (e) => { med[key] = e.target.value; saveSoon(); } }))));

  return h('main', { class: 'page narrow column' },
    libraryBar('Delete diagnosis', async () => {
      if (!await confirmAction(`Delete "${diag.name}" from the library?`)) return;
      S.lib.diagnoses = S.lib.diagnoses.filter((d) => d !== diag);
      backToLibrary();
    }),
    h('section', { class: 'card', 'aria-label': 'Diagnosis details' },
      h('label', { class: 'field' }, 'Name', h('input', { id: 'diag-name', type: 'text', value: diag.name, onchange: (e) => saveName(diag, S.lib.diagnoses, e.target.value, e.target) })),
      h('label', { class: 'field' }, 'Other names and abbreviations, separated by commas', h('input', {
        id: 'diag-aliases', type: 'text', value: (diag.aliases || []).join(', '),
        onchange: (e) => { diag.aliases = e.target.value.split(',').map(E.cleanName).filter(Boolean); saveSoon(); },
      }))),
    textCard({ id: SOURCE.SUMMARY, name: 'Summary note' }, 'Write only what is specific to this diagnosis, such as the treatment given. It goes between the shared opening and closing sentences, so do not repeat the age, dates or medicines. Words in curly brackets are filled in for each patient.'),
    S.lib.types.filter((type) => !type.own).map((type) => textCard(type)),
    (diag.sections || []).map(ownSectionCard),
    h('button', { class: 'btn', id: 'add-diag-section', type: 'button', style: 'justify-self:start', onclick: addOwnSection }, '+ Add a section for this diagnosis'),
    h('section', { class: 'card', 'aria-label': 'Default prescription' },
      h('h2', {}, 'Default prescription'),
      h('p', { class: 'hint' }, 'These are added automatically when this diagnosis is selected.'),
      diag.meds.map(medRow),
      medicinePicker((med) => { E.setDiagnosisMedicine(S.lib, diag.id, med); rerender(); }, 'diag-med-picker')),
    earlier.length > 0 && h('details', { class: 'card' }, h('summary', {}, `Earlier text (${earlier.length})`),
      h('div', { class: 'column' }, earlier.map((entry) => h('div', { class: 'change' },
        h('span', { class: 'hint' }, `${entry.typeId === SOURCE.SUMMARY ? 'Summary note' : entry.title || S.lib.types.find((t) => t.id === entry.typeId)?.name || 'Text'}, ${new Date(entry.at).toLocaleDateString('en-IN')}${entry.by ? `, ${entry.by}` : ''}`),
        h('div', {}, entry.text),
        h('div', {}, h('button', { class: 'btn small', type: 'button', onclick: () => { restoreEarlier(entry); rerender(); toast('Earlier text restored.'); } }, 'Restore')))))),
    h('section', { class: 'card approval', 'aria-label': 'Approval' }, diag.reviewed
      ? [h('div', { class: 'approved', role: 'status' }, '✓ Approved'), h('button', { class: 'btn quiet small', type: 'button', onclick: () => { diag.reviewed = false; rerender(); } }, 'Undo')]
      : h('button', { class: 'btn primary wide', type: 'button', onclick: () => { diag.reviewed = true; rerender(); } }, 'Approve')));
}

function renderMedicineEditor() {
  const med = S.lib.medicines.find((m) => m.id === S.editing.id);
  if (!med) { S.editing = null; return renderLibraryView(); }
  return h('main', { class: 'page narrow column' },
    libraryBar('Delete medicine', async () => {
      if (!await confirmAction(`Delete "${med.name}" from the list? Diagnoses that use it keep their own copy.`)) return;
      S.lib.medicines = S.lib.medicines.filter((m) => m !== med);
      backToLibrary();
    }),
    h('section', { class: 'card', 'aria-label': 'Medicine details' },
      h('label', { class: 'field' }, 'Name', h('input', { id: 'med-name', type: 'text', value: med.name, onchange: (e) => saveName(med, S.lib.medicines, e.target.value, e.target) })),
      h('p', { class: 'hint' }, 'Usual values, used when this medicine is added by hand. Leave blank to fill in each time.'),
      h('div', { class: 'med-grid' }, [['dose', 'Dose'], ['freq', 'Frequency'], ['duration', 'Duration'], ['notes', 'Instructions']].map(([key, label]) =>
        h('label', { class: 'field' }, label, h('input', { id: `med-${key}`, type: 'text', value: med[key], oninput: (e) => { med[key] = e.target.value; saveSoon(); } }))))));
}

// ---------- Setup ----------

function exportLibrary() {
  const stamp = new Date().toISOString().slice(0, 10);
  downloadFile(`discharge-library-${stamp}.json`, JSON.stringify(S.lib), 'application/json');
}

function mergeFrom(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    toast('That is not a library file. Nothing was changed.');
    return;
  }
  if (!E.isLibraryFile(data)) { toast('That is not a library file. Nothing was changed.'); return; }
  const c = E.mergeLibrary(S.lib, data);
  saveNow();
  render();
  toast(`Added ${c.diagnoses} diagnoses, ${c.medicines} medicines and ${c.versions} text versions.`);
}

function renderAccountCard() {
  return h('section', { class: 'card', 'aria-label': 'Account' },
    h('h2', {}, 'Your account'),
    h('p', {}, `Signed in as ${S.account.email}`),
    h('p', { class: 'hint', id: 'sync-status', role: 'status' }, S.syncStatus),
    h('p', { class: 'hint' }, 'Your library syncs automatically to every device where you sign in. Patient reports stay on each device and are never uploaded.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => syncLibrary() }, 'Sync now'),
      h('button', {
        class: 'btn', type: 'button',
        onclick: async () => { if (await confirmAction('Sign out on this device? Your work stays here for your next sign-in, and your online library is kept.', 'Sign out')) signOut(); },
      }, 'Sign out')));
}

function renderSetupView() {
  const setting = (key, value) => { S.settings[key] = value; Store.saveSettings(S.settings); };
  const file = h('input', {
    type: 'file', accept: '.json,application/json', hidden: true,
    onchange: async (e) => { const f = e.target.files[0]; if (f) mergeFrom(await f.text()); },
  });
  const paste = async () => {
    const area = h('textarea', { rows: 8, 'aria-label': 'Library text', placeholder: 'Paste library text here' });
    if (await askDialog(h('div', { class: 'dialog-body' }, h('h2', {}, 'Paste a library'), area), [['Cancel', false], ['Merge', true, 'primary']])) mergeFrom(area.value);
  };
  const typeRow = (type) => h('div', { class: 'row' },
    h('input', { class: 'grow', style: 'width:auto;flex:1', type: 'text', value: type.name, 'aria-label': 'Name of this kind of text', onchange: (e) => { type.name = E.cleanName(e.target.value) || type.name; saveSoon(); } }),
    h('button', {
      class: 'icon', type: 'button', 'aria-label': `Delete ${type.name}`,
      onclick: async () => {
        if (!await confirmAction(`Delete "${type.name}" and its saved text from every diagnosis?`)) return;
        S.lib.types = S.lib.types.filter((t) => t !== type);
        S.lib.diagnoses.forEach((d) => delete d.content[type.id]);
        S.lib.layout = S.lib.layout.map((s) => (s.source === type.id ? { ...s, source: SOURCE.NONE } : s));
        saveNow();
        render();
      },
    }, '×'));

  return h('main', { class: 'page narrow column' },
    h('h1', { style: 'font-size:20px' }, 'Setup'),
    renderAccountCard(),
    h('section', { class: 'card', 'aria-label': 'You' },
      h('h2', {}, 'You'),
      h('div', { class: 'grid-patient' },
        h('label', { class: 'field span-2' }, 'Your name, recorded when you change a default', h('input', { id: 'set-author', type: 'text', value: S.settings.author, oninput: (e) => setting('author', e.target.value) })),
        h('label', { class: 'field span-2' }, 'Email address that reports go to', h('input', { id: 'set-email', type: 'email', value: S.settings.email, oninput: (e) => setting('email', e.target.value) })),
        h('label', { class: 'field span-2' }, 'Heading on formatted reports, such as your unit', h('input', { id: 'set-heading', type: 'text', value: S.settings.reportHeading, oninput: (e) => setting('reportHeading', e.target.value) })))),
    h('section', { class: 'card', 'aria-label': 'Summary wording' },
      h('h2', {}, 'Summary wording'),
      h('p', { class: 'hint' }, 'Every summary starts with the opening, then the note for each diagnosis from the Library, then the closing.'),
      h('label', { class: 'field' }, 'Opening', h('textarea', { id: 'set-opening', rows: 3, value: S.lib.summaryOpening, onchange: (e) => { S.lib.summaryOpening = e.target.value; saveSoon(); } })),
      h('label', { class: 'field' }, 'Closing', h('textarea', { id: 'set-closing', rows: 2, value: S.lib.summaryClosing, onchange: (e) => { S.lib.summaryClosing = e.target.value; saveSoon(); } })),
      h('p', { class: 'hint' }, 'Words in curly brackets are filled in for you: ', h('code', {}, PLACEHOLDERS), '. Text in square brackets is left out when a value inside it is empty.')),
    h('section', { class: 'card', 'aria-label': 'Kinds of text' },
      h('h2', {}, 'Kinds of text'),
      h('p', { class: 'hint' }, 'Each diagnosis stores one paragraph for each of these. A report section can auto-fill from any of them.'),
      S.lib.types.filter((type) => !type.own).map(typeRow),
      h('button', { class: 'btn small', type: 'button', style: 'justify-self:start', onclick: async () => { if (await createType()) render(); } }, 'Add a kind of text')),
    h('section', { class: 'card', 'aria-label': 'Share the library' },
      h('h2', {}, 'Share the library with colleagues'),
      h('p', { class: 'hint' }, 'The library holds diagnoses, medicines and wording, and no patient details. Send the file to a colleague, who merges it here. Merging adds what is new and keeps both wordings when they differ.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: exportLibrary }, 'Save library file'),
        h('button', { class: 'btn', type: 'button', onclick: () => copyText(JSON.stringify(S.lib), 'Library copied as text.') }, 'Copy as text'),
        h('button', { class: 'btn', type: 'button', onclick: () => file.click() }, 'Merge a file'),
        h('button', { class: 'btn', type: 'button', onclick: paste }, 'Paste text'), file)),
    h('section', { class: 'card', 'aria-label': 'Patient data on this device' },
      h('h2', {}, 'Patient data on this device'),
      h('label', { class: 'field' }, 'Delete reports after this many days', h('input', {
        id: 'set-keep', type: 'number', min: 1, max: 90, value: S.settings.keepDays, style: 'max-width:120px',
        onchange: (e) => setting('keepDays', Math.min(90, Math.max(1, Number(e.target.value) || 14))),
      })),
      h('p', { class: 'hint' }, 'Reports stay in this browser and are not uploaded anywhere. On a shared computer, delete them from Saved before you leave.')),
    h('section', { class: 'card', 'aria-label': 'Reset' },
      h('h2', {}, 'Start over'),
      h('div', {}, h('button', {
        class: 'btn danger', type: 'button',
        onclick: async () => {
          if (!await confirmAction('Replace the whole library with the starter list? Your own wording and medicines will be lost, including your online copy and your other devices. Save a library file first.', 'Replace')) return;
          S.lib = buildStarterLibrary();
          startReport();
          saveNow();
          go('report');
        },
      }, 'Restore the starter library'))));
}

// ---------- Sign in ----------

function renderSignIn() {
  const email = h('input', { id: 'account-email', type: 'email', autocomplete: 'username', required: true });
  const password = h('input', { id: 'account-password', type: 'password', autocomplete: 'current-password' });
  const enter = async (action) => {
    try {
      const account = await action();
      if (!account) return;
      Store.saveAccount(account);
      location.reload();
    } catch (error) {
      toast(error.message);
    }
  };
  enter(Sync.finishGoogleSignIn);
  const withPassword = (action) => enter(() => action(E.cleanName(email.value), password.value));
  const forgot = async () => {
    if (!E.cleanName(email.value)) { email.focus(); toast('Type your email first.'); return; }
    try {
      await Sync.sendPasswordReset(E.cleanName(email.value));
      toast('If that email has an account, a reset link is on its way.');
    } catch (error) {
      toast(error.message);
    }
  };
  byId('app').replaceChildren(h('main', { class: 'page sign-in column' },
    h('h1', {}, 'QuickDS'),
    h('p', { class: 'hint' }, 'Sign in to write discharge summaries. Your library follows you to every device. Patient reports stay on the device and are never uploaded.'),
    h('section', { class: 'card', 'aria-label': 'Sign in' },
      h('button', { class: 'btn', id: 'google-sign-in', type: 'button', onclick: () => enter(Sync.startGoogleSignIn) }, 'Continue with Google'),
      h('div', { class: 'or' }, 'or'),
      h('form', { class: 'column', onsubmit: (e) => { e.preventDefault(); withPassword(Sync.signIn); } },
        h('label', { class: 'field' }, 'Email', email),
        h('label', { class: 'field' }, 'Password', password),
        h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: () => withPassword(Sync.signUp) }, 'Create account'),
          h('button', { class: 'btn quiet', type: 'button', onclick: forgot }, 'Forgot password')))),
    !navigator.onLine && h('p', { class: 'hint' }, 'You are offline. Signing in needs a connection the first time.')));
}

// ---------- Start ----------

function startApp() {
  S.reports = Store.purgeOldReports(Store.loadReports(), S.settings.keepDays);
  const draft = [...S.reports].sort((a, b) => b.updatedAt - a.updatedAt).find((r) => !r.finishedAt);
  if (draft) S.report = draft;
  else startReport();
  E.syncReport(S.report, S.lib);
  Store.saveLibrary(S.lib);
  Store.saveReports(S.reports);
  render();
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { syncLibrary(); return; }
    // Library text saves when its box loses focus, which leaving the app does not do by itself.
    if (S.view !== 'report') document.activeElement?.blur?.();
    saveNow();
    if (syncTimer) syncLibrary();
  });
  window.addEventListener('focus', () => syncLibrary());
  window.addEventListener('online', () => syncLibrary());
  window.addEventListener('offline', showOffline);
  setInterval(() => { if (!document.hidden) syncLibrary(); }, SYNC_CHECK_MS);
  syncLibrary();
}

function boot() {
  if (S.account) {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    startApp();
  } else {
    renderSignIn();
  }
  if (TEST_PHASE) showNotice('Testing version. Use example patients only, no real patient details.');
  Store.requestPersistence();
  window.addEventListener('storage', takeOtherTabData);
  if ('serviceWorker' in navigator) {
    const updating = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then((registration) => {
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'activated' && updating) reloadWhenIdle();
        });
      });
    }).catch(showOfflineNotice);
  } else {
    showOfflineNotice();
  }
}

const isBusy = () => document.activeElement?.matches('input, textarea, select') || byId('dialog').open;

// Moves to a new version, but not during typing, a dialog, or a report with details left out.
function reloadWhenIdle() {
  if (isBusy() || !S.showIdentifiers) { setTimeout(reloadWhenIdle, 2000); return; }
  saveNow();
  location.reload();
}

function showNotice(message) {
  byId('app').before(h('div', { class: 'trial', role: 'status' }, message));
}

function showOfflineNotice() {
  showNotice('This copy cannot work offline from this address.');
}

boot();
