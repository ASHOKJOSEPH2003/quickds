// Pure logic: no DOM and no storage, so all of it runs under `node --test`.

export const SOURCE = { NONE: 'none', DIAGNOSES: 'diagnoses', SUMMARY: 'summary', MEDICINES: 'medicines' };
const BUILT_IN_SOURCES = Object.values(SOURCE);
const MAX_HISTORY = 20;

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// ---------- Names, duplicates and search ----------

export const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// British and American spellings compare equal, so "Anemia" cannot duplicate "Anaemia".
const SPELLING = [
  [/aem/g, 'em'], [/oed/g, 'ed'], [/\boes/g, 'es'], [/rrhoea/g, 'rrhea'], [/tumour/g, 'tumor'],
  [/sulph/g, 'sulf'], [/isation\b/g, 'ization'], [/paed/g, 'ped'], [/fibre/g, 'fiber'],
];

export function norm(s) {
  let t = cleanName(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  for (const [from, to] of SPELLING) t = t.replace(from, to);
  return t;
}

// Word order is ignored: "Diabetes type 2" and "Type 2 diabetes" get the same key.
export const nameKey = (s) => norm(s).split(' ').sort().join(' ');

const namesOf = (item) => [item.name, ...(item.aliases || [])];

export function findExact(items, name) {
  const key = nameKey(name);
  if (!key) return null;
  return items.find((item) => namesOf(item).some((n) => nameKey(n) === key)) || null;
}

export function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

const typoLimit = (length) => (length >= 10 ? 2 : length >= 5 ? 1 : 0);

export function searchItems(items, query) {
  const q = norm(query);
  if (!q) return [...items].sort(byName);
  const ranked = [];
  for (const item of items) {
    const rank = Math.min(...namesOf(item).map((n, i) => matchRank(norm(n), q) + (i ? 1 : 0)));
    if (rank < Infinity) ranked.push({ item, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank || byName(a.item, b.item)).map((r) => r.item);
}

function matchRank(name, q) {
  if (name === q || name.startsWith(q)) return 0;
  if (name.split(' ').some((word) => word.startsWith(q))) return 2;
  if (name.includes(q)) return 4;
  const limit = typoLimit(q.length);
  if (limit && levenshtein(name, q) <= limit) return 6;
  if (limit && name.split(' ').some((word) => levenshtein(word, q) <= limit)) return 7;
  return Infinity;
}

export const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

export function mostUsed(items, count = 8) {
  const used = items.filter((d) => d.useCount > 0)
    .sort((a, b) => b.useCount - a.useCount || (b.lastUsed || 0) - (a.lastUsed || 0));
  const fill = items.filter((d) => !d.useCount && d.common).sort((a, b) => a.common - b.common);
  return [...used, ...fill].slice(0, count);
}

// ---------- Text templates ----------

export function joinList(parts) {
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// "Iron deficiency anaemia" reads mid-sentence as "iron deficiency anaemia"; HIV and Parkinson's stay as written.
export function inSentence(name) {
  if (/^[A-Z][A-Z0-9]/.test(name) || /^[A-Z][a-z]+'s/.test(name)) return name;
  return name.charAt(0).toLowerCase() + name.slice(1);
}

export function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1];
  return `${m[3]}-${month}-${m[1]}`;
}

// {name} is replaced. [optional text with {name}] is dropped whole when any value inside it is empty.
export function fill(template, ctx) {
  const value = (key) => ctx[key] ?? '';
  const out = String(template ?? '').replace(/\[([^[\]]*)\]/g, (whole, inner) => {
    const keys = [...inner.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    if (!keys.length) return whole;
    return keys.every((key) => value(key)) ? inner : '';
  });
  return out.replace(/\{(\w+)\}/g, (whole, key) => (key in ctx ? value(key) : whole))
    .replace(/[ \t]{2,}/g, ' ').trim();
}

export function reportContext(report) {
  const p = report.patient;
  return {
    name: p.name || '', age: p.age || '', sex: (p.sex || '').toLowerCase(),
    hospitalNo: p.hospitalNo || '', mrd: p.mrd || '', unit: p.unit || '', ward: p.ward || '',
    admitted: formatDate(p.admitted), discharged: formatDate(p.discharged),
    diagnosis: joinList(report.diagnoses.map((d) => inSentence(d.name))),
    diagnoses: joinList(report.diagnoses.map((d) => inSentence(d.name))),
    medicines: joinList(report.meds.map((m) => m.name)),
  };
}

// The legacy Diagnosis field uses upper case joined by plus signs.
export const diagnosisLine = (report) => report.diagnoses.map((d) => d.name.toUpperCase()).join('+');

// ---------- Report ----------

export const isContentSource = (lib, source) => lib.types.some((t) => t.id === source);

export function newSection(title, source, lib) {
  const known = BUILT_IN_SOURCES.includes(source) || isContentSource(lib, source);
  return { id: uid(), title, source: known ? source : SOURCE.NONE, blocks: [], text: '', note: '', edited: false };
}

export function newReport(lib) {
  const now = Date.now();
  return {
    id: uid(), createdAt: now, updatedAt: now, finishedAt: null,
    patient: { hospitalNo: '', mrd: '', name: '', age: '', sex: '', unit: '', ward: '', specialty: '', admitted: '', discharged: '', address: '', mobile: '', writtenBy: '', approvedBy: '' },
    diagnoses: [], meds: [], removedMeds: [], learned: {}, dismissed: [],
    sections: lib.layout.map((s) => newSection(s.title, s.source, lib)),
  };
}

const getDiag = (lib, id) => lib.diagnoses.find((d) => d.id === id);
const versionsOf = (diag, typeId) => diag?.content?.[typeId] || [];

const withDiagnoses = (ctx, diagnoses) => {
  const names = joinList(diagnoses.map((d) => inSentence(d.name)));
  return { ...ctx, diagnosis: names, diagnoses: names };
};


const ownTypeIds = (lib) => new Set(lib.types.filter((t) => t.own).map((t) => t.id));
const hasOwnSection = (lib, diagId, typeId) => !!getDiag(lib, diagId)?.sections?.includes(typeId);

// A section a diagnosis has for itself joins the report while that diagnosis is selected.
function addOwnSections(report, lib) {
  const own = ownTypeIds(lib);
  for (const d of report.diagnoses) {
    for (const typeId of getDiag(lib, d.id)?.sections || []) {
      if (!own.has(typeId) || report.sections.some((s) => s.source === typeId) || report.dismissed?.includes(typeId)) continue;
      const title = lib.types.find((t) => t.id === typeId).name;
      const waiting = report.sections.find((s) => s.source === SOURCE.NONE && !s.note && nameKey(s.title) === nameKey(title));
      if (waiting) { Object.assign(waiting, { source: typeId, auto: true }); continue; }
      const prescription = report.sections.findIndex((s) => s.source === SOURCE.MEDICINES);
      const section = { ...newSection(title, typeId, lib), auto: true };
      report.sections.splice(prescription < 0 ? report.sections.length : prescription, 0, section);
    }
  }
}

// A summary reads as one shared opening, a note for each diagnosis that has one, and one shared closing.
// Safe to call after any change. Text the doctor edited is never overwritten here.
export function syncReport(report, lib) {
  const ctx = reportContext(report);
  const generated = (template) => (report.diagnoses.length ? fill(template, ctx) : '');
  const own = ownTypeIds(lib);
  addOwnSections(report, lib);
  for (const s of report.sections) {
    const isSummary = s.source === SOURCE.SUMMARY;
    if (s.source === SOURCE.DIAGNOSES && !s.edited) s.text = diagnosisLine(report);
    if (!isSummary && !isContentSource(lib, s.source)) { s.blocks = []; continue; }
    s.blocks = report.diagnoses.map((d) => {
      const found = s.blocks.find((b) => b.diagId === d.id);
      const diag = getDiag(lib, d.id);
      if (found && !diag) return found;
      const versions = versionsOf(diag, s.source);
      const version = versions.find((v) => v.id === found?.versionId) || versions[0];
      const base = version ? fill(version.text, withDiagnoses(ctx, [d])) : '';
      if (!found) return { diagId: d.id, versionId: version?.id || null, text: base, base };
      // The same object stays in place: the text box being typed in holds on to it.
      return Object.assign(found, { versionId: version?.id || null, base, ...(found.text === found.base && { text: base }) });
    });
    if (own.has(s.source)) s.blocks = s.blocks.filter((b) => hasOwnSection(lib, b.diagId, s.source));
    if (isSummary && !s.edited) s.text = generated(lib.summaryOpening);
    if (isSummary && !s.closingEdited) s.closing = generated(lib.summaryClosing);
  }
  report.sections = report.sections.filter((s) => !s.auto || s.blocks.length || s.note);
  return report;
}

const blankMed = (m) => ({ name: m.name, dose: m.dose || '', freq: m.freq || '', duration: m.duration || '', notes: m.notes || '' });

export function addDiagnosisToReport(report, lib, diagId) {
  const diag = getDiag(lib, diagId);
  if (!diag || report.diagnoses.some((d) => d.id === diagId)) return;
  report.diagnoses.push({ id: diag.id, name: diag.name });
  for (const dm of diag.meds) {
    const existing = report.meds.find((m) => nameKey(m.name) === nameKey(dm.name));
    if (existing) {
      existing.fromDiag.push(diag.id);
    } else {
      report.meds.push({ ...blankMed(dm), id: uid(), fromDiag: [diag.id], manual: false });
    }
  }
}

export function removeDiagnosisFromReport(report, diagId) {
  report.diagnoses = report.diagnoses.filter((d) => d.id !== diagId);
  report.removedMeds = report.removedMeds.filter((r) => r.diagId !== diagId);
  report.meds = report.meds.filter((m) => {
    m.fromDiag = m.fromDiag.filter((id) => id !== diagId);
    return m.fromDiag.length > 0 || m.manual;
  });
}

export function addMedicineToReport(report, med) {
  const key = nameKey(med.name);
  if (report.meds.some((m) => nameKey(m.name) === key)) return false;
  report.meds.push({ ...blankMed(med), id: uid(), fromDiag: [], manual: true });
  report.removedMeds = report.removedMeds.filter((r) => nameKey(r.name) !== key);
  return true;
}

export function removeMedicineFromReport(report, medId) {
  const med = report.meds.find((m) => m.id === medId);
  if (!med) return;
  for (const diagId of med.fromDiag) report.removedMeds.push({ diagId, name: med.name });
  report.meds = report.meds.filter((m) => m.id !== medId);
}

// ---------- Output ----------

export const MISSING_FIELDS = [['dose', 'dose'], ['freq', 'frequency'], ['duration', 'duration']];
export const missingFields = (med) => MISSING_FIELDS.filter(([key]) => !cleanName(med[key])).map(([, label]) => label);

export function formatMed(med, index) {
  const part = (key, label, prefix = '') => (cleanName(med[key]) ? prefix + cleanName(med[key]) : `[${label}?]`);
  const parts = [`${med.name} ${part('dose', 'dose')}`, part('freq', 'frequency'), part('duration', 'duration', 'for ')];
  if (cleanName(med.notes)) parts.push(cleanName(med.notes));
  return `${index + 1}. ${parts.join(' - ')}`;
}

const sectionParagraphs = (section) => [section.text, ...section.blocks.map((b) => b.text), section.closing, section.note]
  .map((p) => (p || '').trim()).filter(Boolean);

export function sectionText(section, report) {
  const medicines = section.source === SOURCE.MEDICINES ? report.meds.map(formatMed).join('\n') : '';
  return [medicines, ...sectionParagraphs(section)].filter(Boolean).join('\n\n');
}

// The legacy desktop app is a plain text box, so curly quotes and bullets would paste as junk.
const ASCII = [[/[‘’]/g, "'"], [/[“”]/g, '"'], [/[–—−]/g, '-'], [/•/g, '-'],
  [/…/g, '...'], [/ /g, ' '], [/≥/g, '>='], [/≤/g, '<='], [/×/g, 'x'], [/µ/g, 'u']];
export function toPlainText(text) {
  return ASCII.reduce((t, [from, to]) => t.replace(from, to), text).replace(/\r\n?/g, '\n');
}

export function heading(title) {
  return `${title}\n${'-'.repeat(Math.max(title.length, 3))}`;
}

export function reference(patient) {
  const initials = cleanName(patient.name).split(' ').map((w) => w[0]).join('').toUpperCase();
  const tail = cleanName(patient.hospitalNo).slice(-4);
  return [initials, tail && `...${tail}`].filter(Boolean).join(' ');
}

const identityRows = (patient) => [['Hospital No', patient.hospitalNo], ['MRD No', patient.mrd], ['Name', patient.name],
  ['Age/Sex', [patient.age, patient.sex].filter(Boolean).join(' / ')], ['Unit', patient.unit], ['Ward', patient.ward],
  ['Specialty', patient.specialty], ['Admitted', formatDate(patient.admitted)], ['Discharged', formatDate(patient.discharged)],
  ['Address', patient.address], ['Mobile', patient.mobile]]
  .filter(([, v]) => v);

const signerRows = (patient) => [['Written by', patient.writtenBy], ['Approved by', patient.approvedBy]];

export function identityLines(patient) {
  return [...identityRows(patient), ...signerRows(patient).filter(([, v]) => v)].map(([k, v]) => `${k}: ${v}`).join('\n');
}

export function patientBlock(patient, { identifiers = true } = {}) {
  if (identifiers) return identityLines(patient);
  const ref = reference(patient);
  return ref ? `Ref: ${ref}` : '';
}

export function buildOutput(report, { identifiers = true } = {}) {
  const parts = [patientBlock(report.patient, { identifiers })];
  for (const s of report.sections) {
    const body = sectionText(s, report);
    if (body) parts.push(`${heading(s.title)}\n${body}`);
  }
  const text = parts.filter(Boolean).join('\n\n');
  return toPlainText(identifiers ? text : redact(text, report.patient));
}

// The same content as buildOutput, structured for the formatted report and PDF.
export function buildReportModel(report, { identifiers = true } = {}) {
  const clean = (text) => (identifiers ? text : redact(text, report.patient));
  const ref = reference(report.patient);
  const sections = report.sections.map((s) => ({
    title: s.title,
    medicines: s.source === SOURCE.MEDICINES ? report.meds.map((m) => ({
      name: m.name, dose: cleanName(m.dose), freq: cleanName(m.freq), duration: cleanName(m.duration), notes: cleanName(m.notes),
    })) : [],
    paragraphs: sectionParagraphs(s).map(clean),
  })).filter((s) => s.medicines.length || s.paragraphs.length);
  return {
    patient: identifiers ? identityRows(report.patient) : (ref ? [['Ref', ref]] : []),
    sections,
    signers: signerRows(report.patient),
  };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const swapWhole = (text, value, replacement) => (value
  ? text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`, 'giu'), replacement)
  : text);

// Single name parts count too, except words the report itself uses all the time.
const COMMON_WORDS = new Set(['patient', 'the', 'and', 'for', 'with', 'blood', 'test', 'iron']);
const nameParts = (name) => [cleanName(name), ...cleanName(name).split(' ')]
  .filter((w) => w.length >= 3 && !COMMON_WORDS.has(w.toLowerCase()));

// Free text may mention the patient, so the shared copy is cleaned as well as the template text.
export function redact(text, patient) {
  let t = text;
  for (const part of nameParts(patient.name)) t = swapWhole(t, part, 'the patient');
  t = swapWhole(t, cleanName(patient.hospitalNo), '[hospital no]');
  return swapWhole(t, cleanName(patient.mrd), '[MRD no]');
}

// ---------- Library edits ----------

export function addDiagnosis(lib, rawName, by = '') {
  const name = cleanName(rawName);
  if (!name) return null;
  const existing = findExact(lib.diagnoses, name);
  if (existing) return existing;
  const diag = { id: uid(), name, aliases: [], content: {}, meds: [], useCount: 0, lastUsed: 0, reviewed: false, medStats: {}, history: [], updatedAt: Date.now(), by };
  lib.diagnoses.push(diag);
  return diag;
}

export function addMedicine(lib, rawName) {
  const name = cleanName(rawName);
  if (!name) return null;
  const existing = findExact(lib.medicines, name);
  if (existing) return existing;
  const med = { id: uid(), name, aliases: [], dose: '', freq: '', duration: '', notes: '', useCount: 0 };
  lib.medicines.push(med);
  return med;
}

function remember(diag, entry) {
  diag.history.unshift({ ...entry, at: Date.now() });
  diag.history.length = Math.min(diag.history.length, MAX_HISTORY);
}

export function setDefaultText(lib, diagId, typeId, text, by = '') {
  const diag = getDiag(lib, diagId);
  if (!diag) return;
  diag.content[typeId] ||= [];
  const versions = diag.content[typeId];
  const current = versions[0];
  if (current?.text === text) return;
  if (current?.text) remember(diag, { typeId, text: current.text, by: current.by || '' });
  if (current) Object.assign(current, { text, by, updatedAt: Date.now() });
  else versions.push({ id: uid(), text, by, updatedAt: Date.now() });
  diag.updatedAt = Date.now();
}

export function addVersion(lib, diagId, typeId, text, by = '') {
  const diag = getDiag(lib, diagId);
  if (!diag) return;
  diag.content[typeId] ||= [];
  if (diag.content[typeId].some((v) => v.text === text)) return;
  diag.content[typeId].push({ id: uid(), text, by, updatedAt: Date.now() });
  diag.updatedAt = Date.now();
}

export function makeVersionDefault(lib, diagId, typeId, versionId) {
  const versions = getDiag(lib, diagId)?.content[typeId];
  const index = versions?.findIndex((v) => v.id === versionId) ?? -1;
  if (index > 0) versions.unshift(...versions.splice(index, 1));
}

// A diagnosis can have sections of its own. Each is a kind of text marked own, so it keeps
// versions, history, learning and sync, and diagnoses using the same title share one report section.
export function addDiagnosisSection(lib, diagId, rawName) {
  const diag = getDiag(lib, diagId);
  const name = cleanName(rawName);
  if (!diag || !name) return null;
  let type = findExact(lib.types, name);
  if (type && !type.own) return null;
  if (!type) {
    type = { id: `t-${uid()}`, name, own: true };
    lib.types.push(type);
  }
  diag.sections ||= [];
  if (diag.sections.includes(type.id)) return null;
  diag.sections.push(type.id);
  diag.updatedAt = Date.now();
  return type;
}

function forgetUnusedType(lib, typeId) {
  if (!lib.diagnoses.some((d) => d.sections?.includes(typeId))) lib.types = lib.types.filter((t) => t.id !== typeId || !t.own);
}

export function removeDiagnosisSection(lib, diagId, typeId) {
  const diag = getDiag(lib, diagId);
  if (!diag) return;
  const title = lib.types.find((t) => t.id === typeId)?.name || '';
  for (const text of textsOf(diag.content[typeId]).reverse()) remember(diag, { typeId, text, title });
  delete diag.content[typeId];
  diag.sections = (diag.sections || []).filter((id) => id !== typeId);
  diag.updatedAt = Date.now();
  forgetUnusedType(lib, typeId);
}

export function renameDiagnosisSection(lib, diagId, typeId, rawName) {
  const diag = getDiag(lib, diagId);
  const name = cleanName(rawName);
  const current = lib.types.find((t) => t.id === typeId);
  if (!diag || !name || !current) return null;
  if (nameKey(name) === nameKey(current.name) && lib.diagnoses.every((d) => d === diag || !d.sections?.includes(typeId))) {
    current.name = name;
    return current;
  }
  const index = diag.sections.indexOf(typeId);
  const type = addDiagnosisSection(lib, diagId, name);
  if (!type) return null;
  diag.sections.pop();
  diag.sections[index] = type.id;
  if (diag.content[typeId]) diag.content[type.id] = diag.content[typeId];
  delete diag.content[typeId];
  forgetUnusedType(lib, typeId);
  return type;
}

export function setDiagnosisMedicine(lib, diagId, med) {
  const diag = getDiag(lib, diagId);
  if (!diag) return;
  const key = nameKey(med.name);
  const existing = diag.meds.find((m) => nameKey(m.name) === key);
  remember(diag, { typeId: 'medicines', text: diag.meds.map((m) => m.name).join(', ') });
  if (existing) Object.assign(existing, blankMed(med));
  else diag.meds.push(blankMed(med));
  diag.updatedAt = Date.now();
}

export function removeDiagnosisMedicine(lib, diagId, name) {
  const diag = getDiag(lib, diagId);
  if (!diag) return;
  remember(diag, { typeId: 'medicines', text: diag.meds.map((m) => m.name).join(', ') });
  diag.meds = diag.meds.filter((m) => nameKey(m.name) !== nameKey(name));
  diag.updatedAt = Date.now();
}

// ---------- Learning from a finished report ----------

// Turns a patient's details back into placeholders before text can become a default.
export function scrub(text, report) {
  const ctx = reportContext(report);
  let t = text;
  const swap = (value, placeholder) => { t = swapWhole(t, value, placeholder); };
  for (const part of nameParts(ctx.name)) swap(part, '{name}');
  swap(ctx.hospitalNo, '{hospitalNo}');
  swap(ctx.mrd, '{mrd}');
  swap(ctx.ward, '{ward}');
  swap(ctx.admitted, '{admitted}');
  swap(ctx.discharged, '{discharged}');
  if (ctx.age) t = t.replace(new RegExp(`\\b${escapeRegExp(ctx.age)}(\\s*[- ]\\s*(?:year|yr|y/o))`, 'gi'), '{age}$1');
  return t;
}

// A summary also names the sex and the prescription, which change from patient to patient.
function scrubSummary(text, report) {
  const ctx = reportContext(report);
  return swapWhole(swapWhole(scrub(text, report), ctx.medicines, '{medicines}'), ctx.sex, '{sex}');
}

// Numbers and dates left over after scrubbing may still belong to this one patient.
export const looksPatientSpecific = (text) =>
  /\b\d{5,}\b/.test(text) || /\b\d{1,2}[-/ ](?:\d{1,2}|[A-Za-z]{3,9})[-/ ]\d{2,4}\b/.test(text);

export function collectChanges(report, lib) {
  const changes = [];
  const add = (change) => {
    const signature = change.after ?? change.signature ?? '';
    if (report.learned[change.key] !== signature) changes.push(change);
  };
  const targets = report.diagnoses.filter((d) => getDiag(lib, d.id));

  for (const s of report.sections) {
    const clean = s.source === SOURCE.SUMMARY ? scrubSummary : scrub;
    for (const b of s.blocks) {
      const text = (b.text || '').trim();
      if (!text || text === (b.base || '').trim()) continue;
      const diag = getDiag(lib, b.diagId);
      if (!diag) continue;
      const versions = versionsOf(diag, s.source);
      const version = versions.find((v) => v.id === b.versionId) || versions[0];
      const after = clean(text, report);
      add({ kind: 'text', key: `text:${s.id}:${b.diagId}`, diagId: b.diagId, diagName: diag.name, typeId: s.source,
        sectionTitle: s.title, before: version?.text || '', after, warn: looksPatientSpecific(after), scrubbed: after !== text });
    }
    const note = (s.note || '').trim();
    if (note && targets.length) {
      const after = clean(note, report);
      add({ kind: 'note', key: `note:${s.id}`, sectionId: s.id, sectionTitle: s.title, targets, after, warn: looksPatientSpecific(after), scrubbed: after !== note });
    }
  }

  for (const m of report.meds) {
    if (m.manual && targets.length) {
      const seen = Math.max(...targets.map((d) => getDiag(lib, d.id).medStats?.[nameKey(m.name)] || 0));
      add({ kind: 'med-add', key: `add:${nameKey(m.name)}`, med: blankMed(m), signature: 'add', targets, seen });
    }
    for (const diagId of m.fromDiag) {
      const diag = getDiag(lib, diagId);
      const saved = diag?.meds.find((x) => nameKey(x.name) === nameKey(m.name));
      if (!saved) continue;
      const current = blankMed(m);
      const changed = ['dose', 'freq', 'duration', 'notes'].some((k) => cleanName(current[k]) && cleanName(current[k]) !== cleanName(saved[k]));
      if (changed) {
        add({ kind: 'med-values', key: `med:${diagId}:${nameKey(m.name)}`, diagId, diagName: diag.name, med: current,
          signature: JSON.stringify(current) });
      }
    }
  }

  for (const r of report.removedMeds) {
    const diag = getDiag(lib, r.diagId);
    if (diag?.meds.some((m) => nameKey(m.name) === nameKey(r.name))) {
      add({ kind: 'med-remove', key: `rm:${r.diagId}:${nameKey(r.name)}`, diagId: r.diagId, diagName: diag.name, name: r.name, signature: 'rm' });
    }
  }
  return changes;
}

// A blank section keeps its name in the Library. Prescription notes get a section of their own,
// because the medicines themselves have no text to join.
function noteType(section, lib, diagId) {
  if (isContentSource(lib, section.source)) {
    const current = lib.types.find((t) => t.id === section.source);
    if (current.own) addDiagnosisSection(lib, diagId, current.name);
    return current.id;
  }
  const name = section.source === SOURCE.MEDICINES ? `${cleanName(section.title)} notes` : cleanName(section.title) || 'Notes';
  const type = findExact(lib.types, name);
  if (type && !type.own) return type.id;
  addDiagnosisSection(lib, diagId, name);
  return findExact(lib.types, name).id;
}

// The note moves into the diagnosis text, so the report keeps saying it once.
function saveNote(change, keep, report, lib, by, diagId) {
  const section = report.sections.find((s) => s.id === change.sectionId);
  const diag = getDiag(lib, diagId);
  if (!section || !diag) return;
  const joins = isContentSource(lib, section.source);
  const block = section.blocks.find((b) => b.diagId === diagId);
  const typeId = noteType(section, lib, diagId);
  const joined = joins ? versionsOf(diag, typeId).find((v) => v.id === block?.versionId)?.text : '';
  const text = [joined, change.after].filter(Boolean).join('\n\n');
  keep(lib, diagId, typeId, text, by);
  const versions = versionsOf(diag, typeId);
  const version = versions.find((v) => v.text === text);
  const own = lib.types.find((t) => t.id === typeId)?.own;
  report.dismissed = (report.dismissed || []).filter((id) => id !== typeId);
  if (joins) {
    if (block) Object.assign(block, { versionId: version.id, text: [block.text, section.note.trim()].filter(Boolean).join('\n\n') });
    else section.blocks.push({ diagId, versionId: version.id, text: '', base: '' });
    section.note = '';
  } else if (section.source === SOURCE.MEDICINES) {
    if (own && version === versions[0]) section.note = '';
  } else if (!report.sections.some((s) => s.source === typeId)) {
    Object.assign(section, { source: typeId, note: '', blocks: [{ diagId, versionId: version.id, text: '', base: '' }], ...(own && { auto: true }) });
  }
}

export function applyChange(change, action, report, lib, { by = '', diagId } = {}) {
  if (action === 'note-default') saveNote(change, setDefaultText, report, lib, by, diagId);
  if (action === 'note-version') saveNote(change, addVersion, report, lib, by, diagId);
  if (action === 'default') setDefaultText(lib, change.diagId, change.typeId, change.after, by);
  if (action === 'version') addVersion(lib, change.diagId, change.typeId, change.after, by);
  if (action === 'add-med') setDiagnosisMedicine(lib, diagId, change.med);
  if (action === 'save-med') setDiagnosisMedicine(lib, change.diagId, change.med);
  if (action === 'remove-med') removeDiagnosisMedicine(lib, change.diagId, change.name);
  if (action === 'add-med') {
    const med = report.meds.find((m) => nameKey(m.name) === nameKey(change.med.name));
    if (med && !med.fromDiag.includes(diagId)) med.fromDiag.push(diagId);
  }
  report.learned[change.key] = change.after ?? change.signature ?? '';
}

// Runs once per report, when it is finished. Drives "most used" and repeat-medicine prompts.
export function recordFinish(report, lib) {
  if (report.finishedAt) return;
  const now = Date.now();
  report.finishedAt = now;
  for (const d of report.diagnoses) {
    const diag = getDiag(lib, d.id);
    if (!diag) continue;
    diag.useCount = (diag.useCount || 0) + 1;
    diag.lastUsed = now;
    diag.medStats ||= {};
    for (const m of report.meds) {
      if (!m.manual) continue;
      const key = nameKey(m.name);
      diag.medStats[key] = (diag.medStats[key] || 0) + 1;
    }
  }
  for (const m of report.meds) {
    const med = findExact(lib.medicines, m.name);
    if (med) med.useCount = (med.useCount || 0) + 1;
  }
}

// Merging never deletes: a different text for the same diagnosis arrives as another version.
export function mergeLibrary(lib, incoming) {
  const counts = { diagnoses: 0, versions: 0, medicines: 0, types: 0 };
  for (const type of incoming.types || []) {
    if (!lib.types.some((t) => t.id === type.id)) { lib.types.push({ ...type }); counts.types++; }
  }
  for (const med of incoming.medicines || []) {
    if (!findExact(lib.medicines, med.name)) { lib.medicines.push({ ...med, id: uid(), useCount: 0 }); counts.medicines++; }
  }
  for (const other of incoming.diagnoses || []) {
    const mine = findExact(lib.diagnoses, other.name);
    if (!mine) {
      lib.diagnoses.push({ ...other, id: uid(), useCount: 0, lastUsed: 0, medStats: {}, history: [] });
      counts.diagnoses++;
      continue;
    }
    for (const [typeId, versions] of Object.entries(other.content || {})) {
      mine.content[typeId] ||= [];
      for (const v of versions) {
        if (mine.content[typeId].some((x) => x.text === v.text)) continue;
        mine.content[typeId].push({ ...v, id: uid() });
        counts.versions++;
      }
    }
    for (const med of other.meds || []) {
      if (!mine.meds.some((m) => nameKey(m.name) === nameKey(med.name))) mine.meds.push(blankMed(med));
    }
  }
  return counts;
}

export function isLibraryFile(data) {
  return !!data && Array.isArray(data.diagnoses) && Array.isArray(data.medicines) && Array.isArray(data.types);
}

// ---------- Library format ----------

export const DEFAULT_OPENING = 'The patient[, a {age}-year-old {sex},] [was admitted on {admitted} and ]was diagnosed with {diagnoses}.';
export const DEFAULT_CLOSING = '[The patient has been prescribed {medicines}.]';
const OLD_DEFAULT_SUMMARY = `${DEFAULT_OPENING}[ The patient has been prescribed {medicines}.]`;

// Libraries used to hold one summary template. Changed wording stays whole as the opening.
export function upgradeLibrary(lib) {
  if (lib.summaryOpening !== undefined) return lib;
  const { summaryTemplate, ...rest } = lib;
  const changed = summaryTemplate && summaryTemplate !== OLD_DEFAULT_SUMMARY;
  return { ...rest, summaryOpening: changed ? summaryTemplate : DEFAULT_OPENING, summaryClosing: changed ? '' : DEFAULT_CLOSING };
}

// ---------- Sync between devices ----------

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const textsOf = (versions) => (versions || []).map((v) => v.text).filter(Boolean);

// Three-way choice: whichever side changed since the last sync wins, and a clash goes to onClash.
function choose(base, local, remote, onClash = () => local) {
  if (same(local, remote) || same(remote, base)) return local;
  return same(local, base) ? remote : onClash();
}

const diagnosisView = (d) => ({
  name: d.name, aliases: d.aliases || [], reviewed: !!d.reviewed, meds: d.meds.map(blankMed), sections: d.sections || [],
  content: Object.fromEntries(Object.keys(d.content || {}).sort().map((id) => [id, textsOf(d.content[id])]).filter(([, texts]) => texts.length)),
});
const medicineView = (m) => ({ aliases: m.aliases || [], ...blankMed(m) });

// When both devices changed the same text, the other wording is kept as a version.
function mergeContent(base, local, remote) {
  const content = {};
  for (const typeId of new Set([...Object.keys(local.content), ...Object.keys(remote.content)])) {
    const [b, l, r] = [base, local, remote].map((d) => textsOf(d?.content?.[typeId]));
    const known = [...(local.content[typeId] || []), ...(remote.content[typeId] || [])];
    const texts = choose(b, l, r, () => [...l, ...r.filter((t) => !l.includes(t))]);
    if (texts.length) content[typeId] = texts.map((text) => known.find((v) => v.text === text));
  }
  return content;
}

function mergeMeds(base, local, remote) {
  const [b, l, r] = [base?.meds || [], local.meds, remote.meds].map((meds) => meds.map(blankMed));
  return choose(b, l, r, () => [...l, ...r.filter((m) => !l.some((x) => nameKey(x.name) === nameKey(m.name)))]);
}

function mergeSectionLists(base, local, remote) {
  const [b, l, r] = [base?.sections || [], local.sections || [], remote.sections || []];
  return choose(b, l, r, () => [...l, ...r.filter((id) => !l.includes(id))]);
}

function mergeDiagnosis(base, local, remote) {
  const field = (key, empty) => choose(base?.[key] ?? empty, local[key] ?? empty, remote[key] ?? empty);
  const seen = new Set();
  const history = [...(local.history || []), ...(remote.history || [])].sort((a, b) => b.at - a.at)
    .filter((e) => !seen.has(e.at + e.text) && seen.add(e.at + e.text)).slice(0, MAX_HISTORY);
  const medStats = { ...remote.medStats };
  for (const [key, count] of Object.entries(local.medStats || {})) medStats[key] = Math.max(count, medStats[key] || 0);
  return {
    ...local, syncId: remote.syncId || local.syncId, name: field('name', ''), aliases: field('aliases', []), reviewed: field('reviewed', false),
    content: mergeContent(base, local, remote), meds: mergeMeds(base, local, remote), sections: mergeSectionLists(base, local, remote), history, medStats,
    useCount: Math.max(local.useCount || 0, remote.useCount || 0), lastUsed: Math.max(local.lastUsed || 0, remote.lastUsed || 0),
  };
}

function mergeMedicine(base, local, remote) {
  const b = base ? medicineView(base) : {};
  const l = medicineView(local);
  const r = medicineView(remote);
  const merged = Object.fromEntries(Object.keys(l).map((key) => [key, choose(b[key], l[key], r[key])]));
  return { ...local, ...merged, syncId: remote.syncId || local.syncId, useCount: Math.max(local.useCount || 0, remote.useCount || 0) };
}

const partner = (list, item) => (item.syncId && list.find((x) => x.syncId === item.syncId)) || findExact(list, item.name);

// An item missing on one side was deleted there if the other side has not changed it since.
function mergeList(base, local, remote, view, mergeItem) {
  const paired = new Set();
  const out = [];
  for (const item of local) {
    const other = partner(remote, item);
    const before = partner(base, item);
    if (other) {
      paired.add(other);
      out.push(mergeItem(before, item, other));
    } else if (!before || !same(view(item), view(before))) {
      out.push(item);
    }
  }
  for (const item of remote) {
    if (paired.has(item)) continue;
    const before = partner(base, item);
    if (!before || !same(view(item), view(before))) out.push({ ...item, id: uid() });
  }
  return out.map((item) => (item.syncId ? item : { ...item, syncId: uid() }));
}

// The other device may have made the same custom kind of text under a different id.
function matchTypeIds(local, remote) {
  let raw = JSON.stringify(remote);
  for (const type of remote.types) {
    const mine = findExact(local.types, type.name);
    if (mine && mine.id !== type.id) raw = raw.replaceAll(`"${type.id}"`, `"${mine.id}"`);
  }
  return JSON.parse(raw);
}

// base is the library as it stood after the last sync, or the starter library on a first sync.
export function mergeLibraries(base, local, rawRemote) {
  const earlier = upgradeLibrary(base);
  const remote = matchTypeIds(local, upgradeLibrary(rawRemote));
  return {
    ...local,
    types: [...local.types, ...remote.types.filter((t) => !local.types.some((x) => x.id === t.id))],
    summaryOpening: choose(earlier.summaryOpening, local.summaryOpening, remote.summaryOpening),
    summaryClosing: choose(earlier.summaryClosing, local.summaryClosing, remote.summaryClosing),
    layout: choose(base.layout, local.layout, remote.layout),
    diagnoses: mergeList(base.diagnoses, local.diagnoses, remote.diagnoses, diagnosisView, mergeDiagnosis),
    medicines: mergeList(base.medicines, local.medicines, remote.medicines, medicineView, mergeMedicine),
  };
}

// Lets a library keep its current objects, which open screens hold, when only sync ids are new.
export function copySyncIds(lib, merged) {
  for (const key of ['diagnoses', 'medicines']) {
    const ids = new Map(merged[key].map((item) => [item.id, item.syncId]));
    for (const item of lib[key]) item.syncId = ids.get(item.id) || item.syncId;
  }
}

// Ignores ids and list order, which differ between devices.
export function sameLibrary(a, b) {
  const sorted = (items, view) => items.map((item) => ({ ...view(item), useCount: item.useCount || 0 })).sort(byName);
  const view = (lib) => [lib.types.filter((t) => !t.own).map((t) => t.name).sort(), lib.summaryOpening, lib.summaryClosing, lib.layout.map((s) => s.title),
    sorted(lib.diagnoses, diagnosisView), sorted(lib.medicines, medicineView)];
  return same(view(a), view(b));
}

// Word-level diff for the "what changed" view in the review panel.
export function diffWords(before, after) {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  const push = (kind, text) => {
    if (out.length && out[out.length - 1].kind === kind) out[out.length - 1].text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { push('same', a[i]); i++; j++; }
    else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) { push('added', b[j]); j++; }
    else { push('removed', a[i]); i++; }
  }
  return out;
}
