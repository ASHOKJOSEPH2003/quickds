import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../js/engine.js';
import { buildStarterLibrary } from '../js/seed.js';
import { purgeOldReports } from '../js/store.js';

const setup = () => {
  const lib = buildStarterLibrary();
  const report = E.newReport(lib);
  const pick = (name) => {
    const diag = E.findExact(lib.diagnoses, name);
    E.addDiagnosisToReport(report, lib, diag.id);
    E.syncReport(report, lib);
    return diag;
  };
  const section = (source) => report.sections.find((s) => s.source === source);
  return { lib, report, pick, section };
};

test('spelling variants, aliases and word order do not create duplicates', () => {
  const { lib } = setup();
  const before = lib.diagnoses.length;
  for (const name of ['anemia', 'ANAEMIA', ' Anaemia ', 'Low haemoglobin', 'Low hemoglobin', 'T2DM']) {
    E.addDiagnosis(lib, name);
  }
  E.addDiagnosis(lib, 'Mellitus type 2 diabetes');
  assert.equal(lib.diagnoses.length, before);
  E.addDiagnosis(lib, 'Brucellosis');
  E.addDiagnosis(lib, 'brucellosis');
  assert.equal(lib.diagnoses.length, before + 1);
});

test('starter library has no duplicate names and no doses', () => {
  const { lib } = setup();
  const keys = lib.diagnoses.map((d) => E.nameKey(d.name));
  assert.equal(new Set(keys).size, keys.length);
  const medKeys = lib.medicines.map((m) => E.nameKey(m.name));
  assert.equal(new Set(medKeys).size, medKeys.length);
  for (const m of [...lib.medicines, ...lib.diagnoses.flatMap((d) => d.meds)]) {
    assert.deepEqual([m.dose, m.freq, m.duration], ['', '', '']);
  }
  assert.ok(lib.diagnoses.every((d) => d.reviewed === false));
});

test('search finds names, aliases and typos, best match first', () => {
  const { lib } = setup();
  assert.equal(E.searchItems(lib.diagnoses, 'anem')[0].name, 'Anaemia');
  assert.equal(E.searchItems(lib.diagnoses, 'UTI')[0].name, 'Urinary tract infection');
  assert.equal(E.searchItems(lib.diagnoses, 'pnemonia')[0].name, 'Pneumonia');
  assert.equal(E.searchItems(lib.diagnoses, 'zzzz').length, 0);
});

test('most used puts real usage ahead of the starter list', () => {
  const { lib, report, pick } = setup();
  const typhus = pick('Scrub typhus');
  E.recordFinish(report, lib);
  assert.equal(E.mostUsed(lib.diagnoses)[0].id, typhus.id);
});

test('selecting a diagnosis fills every mapped section', () => {
  const { report, pick, section } = setup();
  report.patient.age = '52';
  report.patient.sex = 'Female';
  pick('Anaemia');
  assert.equal(section('diagnoses').text, 'ANAEMIA');
  assert.match(section('summary').text, /a 52-year-old female, was diagnosed with anaemia\. The patient has been prescribed Tab Ferrous Sulphate with Folic Acid\./);
  assert.match(section('description').blocks[0].text, /low level of haemoglobin/);
  assert.match(section('advice').blocks[0].text, /rich in iron/);
  assert.equal(report.meds.length, 1);
});

test('optional template groups drop out when their values are empty', () => {
  const { report, pick, section } = setup();
  pick('Dengue fever');
  assert.equal(section('summary').text.startsWith('The patient was diagnosed with dengue fever.'), true);
  assert.equal(E.fill('[Ward {ward}.] Done', { ward: '' }), 'Done');
  assert.equal(E.fill('[literal] {unknown}', {}), '[literal] {unknown}');
});

test('edited text survives later changes; untouched text keeps up', () => {
  const { lib, report, pick, section } = setup();
  pick('Anaemia');
  section('advice').blocks[0].text = 'Custom advice.';
  pick('Pneumonia');
  assert.equal(section('advice').blocks[0].text, 'Custom advice.');
  assert.equal(section('advice').blocks.length, 2);
  section('summary').text = 'Doctor wrote this.';
  section('summary').edited = true;
  report.patient.age = '40';
  E.syncReport(report, lib);
  assert.equal(section('summary').text, 'Doctor wrote this.');
});

test('medicines are shared across diagnoses and removed only when no diagnosis needs them', () => {
  const { lib, report, pick } = setup();
  const anaemia = pick('Anaemia');
  const ida = pick('Iron deficiency anaemia');
  assert.equal(report.meds.length, 1);
  E.removeDiagnosisFromReport(report, anaemia.id);
  assert.equal(report.meds.length, 1);
  E.removeDiagnosisFromReport(report, ida.id);
  assert.equal(report.meds.length, 0);
  E.addMedicineToReport(report, { name: 'Tab Custom' });
  assert.equal(E.addMedicineToReport(report, { name: 'tab custom' }), false);
  E.syncReport(report, lib);
  assert.equal(report.meds.length, 1);
});

test('missing dose details are visible in the output, never silently dropped', () => {
  const { report, pick } = setup();
  pick('Anaemia');
  const out = E.buildOutput(report);
  assert.match(out, /1\. Tab Ferrous Sulphate with Folic Acid \[dose\?\] - \[frequency\?\] - \[duration\?\]/);
  Object.assign(report.meds[0], { dose: '200 mg', freq: '1-0-1', duration: '30 days', notes: 'after food' });
  assert.match(E.buildOutput(report), /1\. Tab Ferrous Sulphate with Folic Acid 200 mg - 1-0-1 - for 30 days - after food/);
});

test('output is plain text, and identifiers stay out unless asked for', () => {
  const { report, pick, section } = setup();
  Object.assign(report.patient, { name: 'Test Person', hospitalNo: 'ZZ12345', mrd: 'M999', age: '40' });
  pick('Anaemia');
  section('advice').note = '“Quoted” – note • item… Test Person, no. ZZ12345, was told.';
  const out = E.buildOutput(report);
  assert.ok(!/[^\x00-\x7F]/.test(out));
  assert.ok(!out.includes('Test Person'));
  assert.ok(!out.includes('ZZ12345'));
  assert.match(out, /the patient, no\. \[hospital no\], was told/);
  assert.ok(!out.includes('M999'));
  assert.match(out, /^Ref: TP \.\.\.2345/);
  const full = E.buildOutput(report, { identifiers: true });
  assert.match(full, /Name: Test Person/);
  assert.match(full, /Hospital No: ZZ12345/);
});

test('a name that is also an ordinary word does not mangle the text', () => {
  const { report, pick } = setup();
  report.patient.name = 'Example Patient';
  pick('Anaemia');
  assert.equal(E.redact('The patient', { name: 'Patient' }), 'The patient');
  assert.match(E.buildOutput(report), /^The patient was diagnosed/m);
  assert.ok(!/the the patient/i.test(E.buildOutput(report)));
});

test('the formatted report matches the text output and keeps identifiers out by default', () => {
  const { report, pick, section } = setup();
  Object.assign(report.patient, { name: 'Test Person', hospitalNo: 'ZZ12345', writtenBy: 'Dr A' });
  pick('Anaemia');
  section('advice').note = 'Test Person, ZZ12345, was told.';
  report.meds[0].dose = '200 mg';
  const model = E.buildReportModel(report);
  assert.deepEqual(model.patient, [['Ref', 'TP ...2345']]);
  assert.ok(!JSON.stringify(model.sections).includes('Test Person'));
  assert.ok(!JSON.stringify(model.sections).includes('ZZ12345'));
  const prescription = model.sections.find((s) => s.title === 'Prescription');
  assert.deepEqual(prescription.medicines[0], { name: 'Tab Ferrous Sulphate with Folic Acid', dose: '200 mg', freq: '', duration: '', notes: '' });
  assert.deepEqual(model.signers[0], ['Written by', 'Dr A']);
  const full = E.buildReportModel(report, { identifiers: true });
  assert.ok(full.patient.some(([k, v]) => k === 'Name' && v === 'Test Person'));
  assert.ok(!E.buildReportModel(E.newReport(buildStarterLibrary())).sections.length);
});

test('patient details are scrubbed before text can become a default', () => {
  const { lib, report, pick, section } = setup();
  Object.assign(report.patient, { name: 'Test Person', hospitalNo: 'ZZ12345', age: '40', admitted: '2026-10-16', ward: 'Q7' });
  const diag = pick('Anaemia');
  section('advice').blocks[0].text = 'Test Person, 40-year-old, ZZ12345, ward Q7, admitted 16-Oct-2026, should eat dates.';
  const [change] = E.collectChanges(report, lib);
  assert.equal(change.after, '{name}, {age}-year-old, {hospitalNo}, ward {ward}, admitted {admitted}, should eat dates.');
  assert.equal(change.warn, false);
  E.applyChange(change, 'default', report, lib, { by: 'Dr A' });
  assert.equal(diag.content.advice[0].text, change.after);
  assert.equal(diag.history.length, 1);
  assert.equal(diag.reviewed, false, 'one saved paragraph must not clear the warning on the others');
  E.syncReport(report, lib);
  assert.equal(E.collectChanges(report, lib).length, 0);
});

test('left-over numbers and dates raise a warning', () => {
  assert.equal(E.looksPatientSpecific('Call 9876543210'), true);
  assert.equal(E.looksPatientSpecific('Review on 12-Nov-2026'), true);
  assert.equal(E.looksPatientSpecific('Review in 2 weeks with 3 reports'), false);
});

test('saved versions can be chosen per report', () => {
  const { lib, report, pick, section } = setup();
  const diag = pick('Anaemia');
  section('advice').blocks[0].text = 'Short advice.';
  const [change] = E.collectChanges(report, lib);
  E.applyChange(change, 'version', report, lib);
  assert.equal(diag.content.advice.length, 2);
  assert.notEqual(diag.content.advice[0].text, 'Short advice.');
  E.makeVersionDefault(lib, diag.id, 'advice', diag.content.advice[1].id);
  assert.equal(diag.content.advice[0].text, 'Short advice.');
  assert.equal(E.collectChanges(report, lib).length, 0);
});

test('medicine feedback covers additions, new values and removals', () => {
  const { lib, report, pick } = setup();
  const diag = pick('Anaemia');
  report.meds[0].dose = '200 mg';
  E.addMedicineToReport(report, { name: 'Tab Vitamin C' });
  let changes = E.collectChanges(report, lib);
  assert.deepEqual(changes.map((c) => c.kind).sort(), ['med-add', 'med-values']);
  E.applyChange(changes.find((c) => c.kind === 'med-values'), 'save-med', report, lib);
  assert.equal(diag.meds[0].dose, '200 mg');
  E.applyChange(changes.find((c) => c.kind === 'med-add'), 'add-med', report, lib, { diagId: diag.id });
  assert.ok(diag.meds.some((m) => m.name === 'Tab Vitamin C'));
  E.removeMedicineFromReport(report, report.meds[0].id);
  changes = E.collectChanges(report, lib);
  assert.deepEqual(changes.map((c) => c.kind), ['med-remove']);
  E.applyChange(changes[0], 'remove-med', report, lib);
  assert.ok(!diag.meds.some((m) => /Ferrous/.test(m.name)));
});

test('dismissed feedback stays quiet until the text changes again', () => {
  const { lib, report, pick, section } = setup();
  pick('Anaemia');
  section('advice').blocks[0].text = 'First edit.';
  E.applyChange(E.collectChanges(report, lib)[0], 'skip', report, lib);
  assert.equal(E.collectChanges(report, lib).length, 0);
  section('advice').blocks[0].text = 'Second edit.';
  assert.equal(E.collectChanges(report, lib).length, 1);
});

test('finishing counts usage once and tracks repeat medicines', () => {
  const { lib, report, pick } = setup();
  const diag = pick('Anaemia');
  E.addMedicineToReport(report, { name: 'Tab Vitamin C' });
  E.recordFinish(report, lib);
  E.recordFinish(report, lib);
  assert.equal(diag.useCount, 1);
  const next = E.newReport(lib);
  E.addDiagnosisToReport(next, lib, diag.id);
  E.addMedicineToReport(next, { name: 'Tab Vitamin C' });
  assert.equal(E.collectChanges(next, lib).find((c) => c.kind === 'med-add').seen, 1);
});

test('merging a shared library loses nothing and adds no duplicates', () => {
  const { lib } = setup();
  const incoming = buildStarterLibrary();
  const before = lib.diagnoses.length;
  assert.deepEqual(E.mergeLibrary(lib, incoming), { diagnoses: 0, versions: 0, medicines: 0, types: 0 });
  E.findExact(incoming.diagnoses, 'Anaemia').content.advice[0].text = 'Team wording.';
  E.addDiagnosis(incoming, 'Brucellosis');
  const counts = E.mergeLibrary(lib, incoming);
  assert.equal(counts.versions, 1);
  assert.equal(counts.diagnoses, 1);
  assert.equal(lib.diagnoses.length, before + 1);
  assert.equal(E.findExact(lib.diagnoses, 'Anaemia').content.advice.length, 2);
  assert.equal(E.isLibraryFile({ diagnoses: [] }), false);
  assert.equal(E.isLibraryFile(lib), true);
});

test('word diff rebuilds both texts', () => {
  const parts = E.diffWords('take iron daily', 'take oral iron twice daily');
  assert.equal(parts.filter((p) => p.kind !== 'removed').map((p) => p.text).join(''), 'take oral iron twice daily');
  assert.equal(parts.filter((p) => p.kind !== 'added').map((p) => p.text).join(''), 'take iron daily');
});

test('old reports are purged on schedule', () => {
  const day = 86400000;
  const now = 100 * day;
  const reports = [{ updatedAt: now - 20 * day }, { updatedAt: now - day }];
  assert.equal(purgeOldReports(reports, 14, now).length, 1);
});
