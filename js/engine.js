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
    diagnoses: [], meds: [], removedMeds: [], learned: {},
    sections: lib.layout.map((s) => newSection(s.title, s.source, lib)),
  };
}

const getDiag = (lib, id) => lib.diagnoses.find((d) => d.id === id);
const versionsOf = (diag, typeId) => diag?.content?.[typeId] || [];

const withDiagnoses = (ctx, diagnoses) => {
  const names = joinList(diagnoses.map((d) => inSentence(d.name)));
  return { ...ctx, diagnosis: names, diagnoses: names };
};

// Diagnoses without a summary of their own share the general wording.
const generalDiagnoses = (report, section) => report.diagnoses.filter((d) => !section.blocks.some((b) => b.diagId === d.id));
const generalSummary = (report, lib, diagnoses) => (diagnoses.length ? fill(lib.summaryTemplate, withDiagnoses(reportContext(report), diagnoses)) : '');

// Safe to call after any change. Text the doctor edited is never overwritten here.
export function syncReport(report, lib) {
  const ctx = reportContext(report);
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
      if (!found || found.text === found.base) return { diagId: d.id, versionId: version?.id || null, text: base, base };
      return { ...found, versionId: version?.id || null, base };
    });
    if (isSummary) {
      s.blocks = s.blocks.filter((b) => b.text || b.base);
      if (!s.edited) s.text = generalSummary(report, lib, generalDiagnoses(report, s));
    }
  }
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

const sectionParagraphs = (section) => [section.text, ...section.blocks.map((b) => b.text), section.note]
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
        sectionTitle: s.title, before: version?.text || '', after, warn: looksPatientSpecific(after) });
    }
    // An edited general summary can become that diagnosis's own, when it covers only one.
    const general = s.source === SOURCE.SUMMARY && s.edited ? generalDiagnoses(report, s) : [];
    const diag = general.length === 1 && getDiag(lib, general[0].id);
    if (diag && s.text.trim()) {
      const after = clean(s.text.trim(), report);
      add({ kind: 'text', key: `text:${s.id}:${diag.id}`, diagId: diag.id, diagName: diag.name, typeId: s.source, sectionId: s.id,
        sectionTitle: s.title, before: clean(generalSummary(report, lib, general), report), after, warn: looksPatientSpecific(after) });
    }
  }

  const targets = report.diagnoses.filter((d) => getDiag(lib, d.id));
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

export function applyChange(change, action, report, lib, { by = '', diagId } = {}) {
  if (action === 'default') setDefaultText(lib, change.diagId, change.typeId, change.after, by);
  if (action === 'default' && change.sectionId) report.sections.find((s) => s.id === change.sectionId).edited = false;
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
