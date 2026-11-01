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
  assert.match(section('summary').text, /a 52-year-old female, was diagnosed with anaemia\.$/);
  assert.equal(section('summary').closing, 'The patient has been prescribed Tab Ferrous Sulphate with Folic Acid.');
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

test('output is plain text, includes patient details by default, and can leave them out', () => {
  const { report, pick, section } = setup();
  Object.assign(report.patient, { name: 'Test Person', hospitalNo: 'ZZ12345', mrd: 'M999', age: '40', address: '1 Test Street', mobile: '9000000000' });
  pick('Anaemia');
  section('advice').note = '“Quoted” – note • item… Test Person, no. ZZ12345, was told.';
  const full = E.buildOutput(report);
  assert.ok(!/[^\x00-\x7F]/.test(full));
  assert.match(full, /Name: Test Person/);
  assert.match(full, /Hospital No: ZZ12345/);
  assert.match(full, /Address: 1 Test Street/);
  assert.match(full, /Mobile: 9000000000/);
  const out = E.buildOutput(report, { identifiers: false });
  assert.ok(!/[^\x00-\x7F]/.test(out));
  assert.ok(!out.includes('Test Street'));
  assert.ok(!out.includes('9000000000'));
  assert.ok(!out.includes('Test Person'));
  assert.ok(!out.includes('ZZ12345'));
  assert.match(out, /the patient, no\. \[hospital no\], was told/);
  assert.ok(!out.includes('M999'));
  assert.match(out, /^Ref: TP \.\.\.2345/);
});

test('a name that is also an ordinary word does not mangle the text', () => {
  const { report, pick } = setup();
  report.patient.name = 'Example Patient';
  pick('Anaemia');
  assert.equal(E.redact('The patient', { name: 'Patient' }), 'The patient');
  assert.match(E.buildOutput(report, { identifiers: false }), /^The patient was diagnosed/m);
  assert.ok(!/the the patient/i.test(E.buildOutput(report, { identifiers: false })));
});

test('the formatted report matches the text output and includes patient details by default', () => {
  const { report, pick, section } = setup();
  Object.assign(report.patient, { name: 'Test Person', hospitalNo: 'ZZ12345', writtenBy: 'Dr A' });
  pick('Anaemia');
  section('advice').note = 'Test Person, ZZ12345, was told.';
  report.meds[0].dose = '200 mg';
  const model = E.buildReportModel(report, { identifiers: false });
  assert.deepEqual(model.patient, [['Ref', 'TP ...2345']]);
  assert.ok(!JSON.stringify(model.sections).includes('Test Person'));
  assert.ok(!JSON.stringify(model.sections).includes('ZZ12345'));
  const prescription = model.sections.find((s) => s.title === 'Prescription');
  assert.deepEqual(prescription.medicines[0], { name: 'Tab Ferrous Sulphate with Folic Acid', dose: '200 mg', freq: '', duration: '', notes: '' });
  assert.deepEqual(model.signers[0], ['Written by', 'Dr A']);
  const full = E.buildReportModel(report);
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

test('every keystroke in diagnosis text reaches the report, not only the first', () => {
  const { lib, report, pick, section } = setup();
  pick('Anaemia');
  const block = section('advice').blocks[0];
  block.text = 'First edit.';
  E.syncReport(report, lib);
  block.text = 'First edit. Second edit.';
  E.syncReport(report, lib);
  assert.equal(section('advice').blocks[0], block);
  assert.match(E.sectionText(section('advice'), report), /Second edit\./);
  assert.equal(E.collectChanges(report, lib)[0].after, 'First edit. Second edit.');
});

test('a note under a section joins the chosen diagnosis text and is not said twice', () => {
  const { lib, report, pick, section } = setup();
  report.patient.name = 'Test Person';
  const first = pick('Anaemia');
  const second = pick('Type 2 diabetes mellitus');
  const advice = section('advice');
  const before = first.content.advice[0].text;
  const untouched = second.content.advice[0].text;
  advice.note = 'Test Person should review in the clinic.';
  const change = E.collectChanges(report, lib).find((c) => c.kind === 'note');
  assert.equal(change.after, '{name} should review in the clinic.');
  assert.equal(change.targets.length, 2);
  assert.equal(change.scrubbed, true);
  E.applyChange(change, 'note-default', report, lib, { diagId: first.id });
  E.syncReport(report, lib);
  assert.equal(first.content.advice[0].text, `${before}\n\n{name} should review in the clinic.`);
  assert.equal(second.content.advice[0].text, untouched);
  assert.equal(advice.note, '');
  const text = E.sectionText(advice, report);
  assert.equal(text.match(/review in the clinic/g).length, 1);
  assert.equal(advice.blocks.find((b) => b.diagId === first.id).text, advice.blocks.find((b) => b.diagId === first.id).base);
  assert.equal(E.collectChanges(report, lib).length, 0);
});

test('a note saved as a version keeps the report text and the old default', () => {
  const { lib, report, pick, section } = setup();
  const diag = pick('Anaemia');
  const advice = section('advice');
  const before = diag.content.advice[0].text;
  advice.note = 'Extra advice.';
  E.applyChange(E.collectChanges(report, lib)[0], 'note-version', report, lib, { diagId: diag.id });
  E.syncReport(report, lib);
  assert.equal(diag.content.advice[0].text, before);
  assert.equal(diag.content.advice[1].text, `${before}\n\nExtra advice.`);
  assert.match(E.sectionText(advice, report), /Extra advice\./);
  assert.equal(E.collectChanges(report, lib).length, 0);
});

test('a filled blank section becomes a section of the diagnosis and returns next time', () => {
  const { lib, report, pick } = setup();
  const diag = pick('Anaemia');
  const blank = E.newSection('Follow up', E.SOURCE.NONE, lib);
  blank.note = 'Clinic in two weeks.';
  report.sections.push(blank);
  E.applyChange(E.collectChanges(report, lib).find((c) => c.kind === 'note'), 'note-default', report, lib, { diagId: diag.id });
  E.syncReport(report, lib);
  const follow = report.sections.filter((s) => s.title === 'Follow up');
  assert.equal(follow.length, 1);
  assert.equal(E.sectionText(follow[0], report).trim(), 'Clinic in two weeks.');
  assert.equal(E.collectChanges(report, lib).length, 0);

  lib.layout.push({ title: 'Follow up', source: E.SOURCE.NONE });
  const later = E.newReport(lib);
  E.addDiagnosisToReport(later, lib, diag.id);
  E.syncReport(later, lib);
  const again = later.sections.filter((s) => s.title === 'Follow up');
  assert.equal(again.length, 1, 'an empty section of the same name is filled, not repeated');
  assert.equal(E.sectionText(again[0], later).trim(), 'Clinic in two weeks.');
});

test('a prescription note becomes a section for the diagnosis, once', () => {
  const { lib, report, pick, section } = setup();
  const diag = pick('Anaemia');
  const prescription = section(E.SOURCE.MEDICINES);
  prescription.note = 'Take iron with water.';
  E.applyChange(E.collectChanges(report, lib).find((c) => c.kind === 'note'), 'note-default', report, lib, { diagId: diag.id });
  E.syncReport(report, lib);
  assert.equal(prescription.note, '');
  const notes = report.sections.find((s) => s.title === 'Prescription notes');
  assert.equal(E.sectionText(notes, report).trim(), 'Take iron with water.');
  assert.ok(report.sections.indexOf(notes) < report.sections.indexOf(prescription));
});

test('a note on a section another diagnosis lacks gives that diagnosis the section', () => {
  const { lib, report, pick } = setup();
  const first = E.findExact(lib.diagnoses, 'Anaemia');
  const second = E.findExact(lib.diagnoses, 'Type 2 diabetes mellitus');
  const type = E.addDiagnosisSection(lib, first.id, 'Diet');
  E.setDefaultText(lib, first.id, type.id, 'Eat greens.');
  pick('Anaemia');
  pick('Type 2 diabetes mellitus');
  const diet = report.sections.find((s) => s.source === type.id);
  diet.note = 'Less sugar.';
  E.applyChange(E.collectChanges(report, lib).find((c) => c.kind === 'note'), 'note-default', report, lib, { diagId: second.id });
  E.syncReport(report, lib);
  assert.ok(second.sections.includes(type.id));
  assert.equal(diet.note, '');
  assert.equal(diet.blocks.length, 2);
  assert.equal(E.sectionText(diet, report).match(/Less sugar/g).length, 1);
});

test('choosing just this patient hides a note until it changes', () => {
  const { lib, report, pick, section } = setup();
  pick('Anaemia');
  const advice = section('advice');
  advice.note = 'Only for this patient.';
  E.applyChange(E.collectChanges(report, lib)[0], 'skip', report, lib);
  assert.equal(E.collectChanges(report, lib).length, 0);
  assert.equal(advice.note, 'Only for this patient.');
  advice.note = 'Changed again.';
  assert.equal(E.collectChanges(report, lib).length, 1);
});

test('nothing is offered for a note with no diagnosis selected', () => {
  const { lib, report, section } = setup();
  section('advice').note = 'A note.';
  assert.equal(E.collectChanges(report, lib).length, 0);
});

const summaryOf = (report, section) => E.sectionText(section('summary'), report);

test('a summary is one opening, each diagnosis note, then one closing', () => {
  const { lib, report, pick, section } = setup();
  Object.assign(report.patient, { age: '45', sex: 'Female', admitted: '2026-10-20' });
  const anaemia = pick('Anaemia');
  const thyroid = pick('Hypothyroidism');
  const opening = 'The patient, a 45-year-old female, was admitted on 20-Oct-2026 and was diagnosed with anaemia and hypothyroidism.';
  const closing = 'The patient has been prescribed Tab Ferrous Sulphate with Folic Acid and Tab Thyroxine.';
  assert.equal(summaryOf(report, section), `${opening}\n\n${closing}`);

  E.setDefaultText(lib, anaemia.id, 'summary', 'Treated with blood transfusion for {diagnosis}.');
  E.syncReport(report, lib);
  assert.equal(summaryOf(report, section), `${opening}\n\nTreated with blood transfusion for anaemia.\n\n${closing}`);

  E.setDefaultText(lib, thyroid.id, 'summary', 'Thyroxine was started.');
  E.syncReport(report, lib);
  assert.equal(summaryOf(report, section), `${opening}\n\nTreated with blood transfusion for anaemia.\n\nThyroxine was started.\n\n${closing}`);
  assert.match(E.buildOutput(report), /Summary\n-+\nThe patient, a 45-year-old female/);

  E.setDefaultText(lib, anaemia.id, 'summary', '');
  E.syncReport(report, lib);
  assert.equal(summaryOf(report, section), `${opening}\n\nThyroxine was started.\n\n${closing}`);
});

test('a summary still reads properly with details or medicines missing', () => {
  const { lib, report, pick, section } = setup();
  const diag = pick('Anaemia');
  report.meds = [];
  E.syncReport(report, lib);
  assert.equal(section('summary').closing, '');
  assert.equal(summaryOf(report, section), 'The patient was diagnosed with anaemia.');
  E.removeDiagnosisFromReport(report, diag.id);
  E.syncReport(report, lib);
  assert.equal(summaryOf(report, section), '');
});

test('opening and closing edits stay with the patient, and new wording reaches later reports', () => {
  const { lib, report, pick, section } = setup();
  pick('Anaemia');
  const summary = section('summary');
  Object.assign(summary, { text: 'A special opening.', edited: true, closing: 'A special closing.', closingEdited: true });
  E.syncReport(report, lib);
  assert.equal(summary.text, 'A special opening.');
  assert.equal(summary.closing, 'A special closing.');
  assert.ok(!E.collectChanges(report, lib).some((c) => c.typeId === 'summary'));
  lib.summaryOpening = 'Seen for {diagnoses}.';
  const next = E.syncReport(Object.assign(E.newReport(lib), { diagnoses: report.diagnoses }), lib);
  assert.equal(next.sections.find((s) => s.source === 'summary').text, 'Seen for anaemia.');
});

test('a note written in a report can become the diagnosis note, with patient details removed', () => {
  const { lib, report, pick, section } = setup();
  Object.assign(report.patient, { name: 'Test Person', age: '40', sex: 'Female' });
  const diag = pick('Anaemia');
  const med = report.meds[0].name;
  const [block] = section('summary').blocks;
  assert.equal(block.text, '');
  block.text = `Test Person, a 40-year-old female, needed ${med}.`;
  const [change] = E.collectChanges(report, lib);
  assert.equal(change.after, '{name}, a {age}-year-old {sex}, needed {medicines}.');
  E.applyChange(change, 'default', report, lib);
  E.syncReport(report, lib);
  assert.equal(diag.content.summary[0].text, change.after);
  assert.equal(E.collectChanges(report, lib).length, 0);
  report.patient.sex = 'Male';
  E.syncReport(report, lib);
  assert.match(section('summary').blocks[0].text, /40-year-old male/);
});

test('older libraries move to the new summary format', () => {
  const { summaryOpening, summaryClosing, ...rest } = buildStarterLibrary();
  const old = `${summaryOpening}[ The patient has been prescribed {medicines}.]`;
  const standard = E.upgradeLibrary({ ...rest, summaryTemplate: old });
  assert.equal(standard.summaryOpening, summaryOpening);
  assert.equal(standard.summaryClosing, summaryClosing);
  assert.equal('summaryTemplate' in standard, false);
  const custom = E.upgradeLibrary({ ...rest, summaryTemplate: 'My wording for {diagnoses}.' });
  assert.equal(custom.summaryOpening, 'My wording for {diagnoses}.');
  assert.equal(custom.summaryClosing, '');
  assert.equal(E.upgradeLibrary(custom), custom);
});

test('a diagnosis section appears only while that diagnosis is selected', () => {
  const { lib, report, pick, section } = setup();
  const diag = E.findExact(lib.diagnoses, 'Anaemia');
  const type = E.addDiagnosisSection(lib, diag.id, 'Transfusion record');
  E.setDefaultText(lib, diag.id, type.id, 'Transfused on {admitted}.');
  report.patient.admitted = '2026-10-20';
  pick('Hypothyroidism');
  assert.equal(section(type.id), undefined);
  pick('Anaemia');
  const own = section(type.id);
  assert.equal(own.title, 'Transfusion record');
  assert.equal(own.blocks.length, 1, 'other diagnoses get no empty block');
  assert.equal(own.blocks[0].text, 'Transfused on 20-Oct-2026.');
  const titles = report.sections.map((s) => s.title);
  assert.equal(titles.indexOf('Transfusion record'), titles.indexOf('Prescription') - 1);
  assert.match(E.buildOutput(report), /Transfusion record\n-+\nTransfused on 20-Oct-2026\./);
  E.removeDiagnosisFromReport(report, diag.id);
  E.syncReport(report, lib);
  assert.equal(section(type.id), undefined);
});

test('diagnoses using the same section name share one report section', () => {
  const { lib, report, pick, section } = setup();
  const a = E.findExact(lib.diagnoses, 'Anaemia');
  const b = E.findExact(lib.diagnoses, 'Hypothyroidism');
  const type = E.addDiagnosisSection(lib, a.id, 'Follow up plan');
  assert.equal(E.addDiagnosisSection(lib, b.id, 'follow-up plan').id, type.id);
  assert.equal(E.addDiagnosisSection(lib, a.id, 'Follow up plan'), null, 'no duplicates on one diagnosis');
  assert.equal(E.addDiagnosisSection(lib, a.id, 'Description'), null, 'every diagnosis already has this');
  E.setDefaultText(lib, a.id, type.id, 'See haematology.');
  E.setDefaultText(lib, b.id, type.id, 'See endocrine.');
  pick('Anaemia');
  pick('Hypothyroidism');
  assert.deepEqual(section(type.id).blocks.map((x) => x.text), ['See haematology.', 'See endocrine.']);
  assert.equal(report.sections.filter((s) => s.source === type.id).length, 1);
});

test('a section removed from a report stays out, and edits can be saved back', () => {
  const { lib, report, pick, section } = setup();
  const diag = E.findExact(lib.diagnoses, 'Anaemia');
  const type = E.addDiagnosisSection(lib, diag.id, 'Diet plan');
  pick('Anaemia');
  section(type.id).blocks[0].text = 'Eat more iron.';
  const [change] = E.collectChanges(report, lib);
  assert.equal(change.typeId, type.id);
  E.applyChange(change, 'default', report, lib);
  assert.equal(diag.content[type.id][0].text, 'Eat more iron.');
  report.sections = report.sections.filter((s) => s.source !== type.id);
  report.dismissed.push(type.id);
  E.syncReport(report, lib);
  assert.equal(section(type.id), undefined);
});

test('a diagnosis section can be renamed and deleted, and its text is kept', () => {
  const { lib } = setup();
  const a = E.findExact(lib.diagnoses, 'Anaemia');
  const b = E.findExact(lib.diagnoses, 'Hypothyroidism');
  const shared = E.addDiagnosisSection(lib, a.id, 'Plan');
  E.addDiagnosisSection(lib, b.id, 'Plan');
  E.setDefaultText(lib, a.id, shared.id, 'Plan for anaemia.');
  const renamed = E.renameDiagnosisSection(lib, a.id, shared.id, 'Anaemia plan');
  assert.notEqual(renamed.id, shared.id, 'the other diagnosis keeps its name');
  assert.deepEqual(a.sections, [renamed.id]);
  assert.equal(a.content[renamed.id][0].text, 'Plan for anaemia.');
  assert.equal(a.content[shared.id], undefined);
  assert.ok(lib.types.some((t) => t.id === shared.id));
  E.renameDiagnosisSection(lib, a.id, renamed.id, 'Anaemia care');
  assert.equal(lib.types.find((t) => t.id === a.sections[0]).name, 'Anaemia care');
  E.removeDiagnosisSection(lib, a.id, a.sections[0]);
  assert.deepEqual(a.sections, []);
  assert.equal(a.history[0].title, 'Anaemia care');
  assert.equal(a.history[0].text, 'Plan for anaemia.');
  assert.ok(!lib.types.some((t) => t.name === 'Anaemia care'));
  assert.ok(!lib.types.some((t) => t.name === 'Anaemia plan'));
});

test('sync: diagnosis sections travel, join up by name, and both devices\' additions survive', () => {
  const { base, local, remote, diag } = syncSetup();
  const onRemote = E.addDiagnosisSection(remote, diag(remote).id, 'Diet plan');
  E.setDefaultText(remote, diag(remote).id, onRemote.id, 'From remote.');
  const onLocal = E.addDiagnosisSection(local, diag(local).id, 'Diet plan');
  E.setDefaultText(local, diag(local).id, onLocal.id, 'From local.');
  E.addDiagnosisSection(remote, diag(remote).id, 'Only on remote');
  const merged = E.mergeLibraries(base, local, remote);
  const names = diag(merged).sections.map((id) => merged.types.find((t) => t.id === id).name);
  assert.deepEqual(names, ['Diet plan', 'Only on remote']);
  assert.deepEqual(diag(merged).content[onLocal.id].map((v) => v.text), ['From local.', 'From remote.']);
  assert.equal(merged.types.filter((t) => t.name === 'Diet plan').length, 1);
});

test('sync: removing a diagnosis section reaches the other device', () => {
  const { base, local, remote, diag } = syncSetup();
  const type = E.addDiagnosisSection(local, diag(local).id, 'Diet plan');
  const first = E.mergeLibraries(base, local, remote);
  const synced = JSON.parse(JSON.stringify(first));
  const other = JSON.parse(JSON.stringify(first));
  E.removeDiagnosisSection(other, diag(other).id, type.id);
  assert.deepEqual(diag(E.mergeLibraries(synced, first, other)).sections, []);
});

test('a new diagnosis starts unapproved', () => {
  const { lib } = setup();
  assert.equal(E.addDiagnosis(lib, 'Brucellosis').reviewed, false);
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

// Two devices, each with its own starter ids, as after a first sync.
const syncSetup = () => {
  const base = buildStarterLibrary();
  const local = buildStarterLibrary();
  const remote = buildStarterLibrary();
  const diag = (lib, name = 'Anaemia') => E.findExact(lib.diagnoses, name);
  return { base, local, remote, diag };
};

test('sync: a first sync takes the other device\'s work, and untouched starter text is not duplicated', () => {
  const { base, local, remote, diag } = syncSetup();
  E.setDefaultText(remote, diag(remote).id, 'summary', 'My own summary.');
  E.setDefaultText(remote, diag(remote).id, 'advice', 'New advice.');
  diag(remote).reviewed = true;
  E.addDiagnosis(remote, 'Brucellosis');
  const merged = E.mergeLibraries(base, local, remote);
  assert.equal(diag(merged).content.summary[0].text, 'My own summary.');
  assert.deepEqual(diag(merged).content.advice.map((v) => v.text), ['New advice.']);
  assert.equal(diag(merged).reviewed, true);
  assert.equal(diag(merged).id, diag(local).id, 'reports keep working because local ids stay');
  assert.ok(E.findExact(merged.diagnoses, 'Brucellosis'));
  assert.equal(merged.diagnoses.length, local.diagnoses.length + 1);
  assert.ok(E.sameLibrary(merged, remote));
});

test('sync: changes to different things on each device both survive', () => {
  const { base, local, remote, diag } = syncSetup();
  E.setDefaultText(local, diag(local).id, 'advice', 'Local advice.');
  diag(remote).reviewed = true;
  diag(remote).aliases = ['Low Hb'];
  const merged = E.mergeLibraries(base, local, remote);
  assert.equal(diag(merged).content.advice[0].text, 'Local advice.');
  assert.equal(diag(merged).reviewed, true);
  assert.deepEqual(diag(merged).aliases, ['Low Hb']);
});

test('sync: the same text changed on both devices keeps both wordings', () => {
  const { base, local, remote, diag } = syncSetup();
  E.setDefaultText(local, diag(local).id, 'advice', 'Local wording.');
  E.setDefaultText(remote, diag(remote).id, 'advice', 'Remote wording.');
  const merged = E.mergeLibraries(base, local, remote);
  assert.deepEqual(diag(merged).content.advice.map((v) => v.text), ['Local wording.', 'Remote wording.']);
});

test('sync: undoing an approval and deleting a version travel to the other device', () => {
  const { local, remote, diag } = syncSetup();
  diag(local).reviewed = true;
  diag(remote).reviewed = true;
  const base = JSON.parse(JSON.stringify(remote));
  diag(remote).reviewed = false;
  assert.equal(diag(E.mergeLibraries(base, local, remote)).reviewed, false);
});

test('sync: a deletion spreads, unless the other device changed that item', () => {
  const { base, local, remote, diag } = syncSetup();
  remote.diagnoses = remote.diagnoses.filter((d) => d !== diag(remote));
  assert.equal(diag(E.mergeLibraries(base, local, remote)), null);
  const edited = buildStarterLibrary();
  E.setDefaultText(edited, diag(edited).id, 'advice', 'Keep this.');
  assert.ok(diag(E.mergeLibraries(base, edited, remote)));
  assert.ok(diag(E.mergeLibraries(base, remote, edited)));
});

test('sync: a renamed diagnosis stays one diagnosis once both devices share a sync id', () => {
  const { base, local, remote, diag } = syncSetup();
  const first = E.mergeLibraries(base, local, remote);
  const other = E.mergeLibraries(base, remote, first);
  const synced = JSON.parse(JSON.stringify(first));
  diag(other).name = 'Anaemia, unspecified';
  const merged = E.mergeLibraries(synced, first, other);
  assert.equal(merged.diagnoses.length, first.diagnoses.length);
  assert.ok(diag(merged, 'Anaemia, unspecified'));
  assert.equal(diag(merged, 'Anaemia, unspecified').id, diag(first).id);
});

test('sync: shared summary wording travels, and a device on the old format joins in', () => {
  const { base, local, remote } = syncSetup();
  remote.summaryOpening = 'New opening for {diagnoses}.';
  assert.equal(E.mergeLibraries(base, local, remote).summaryOpening, 'New opening for {diagnoses}.');
  const { summaryOpening, summaryClosing, ...rest } = buildStarterLibrary();
  const old = { ...rest, summaryTemplate: `${summaryOpening}[ The patient has been prescribed {medicines}.]` };
  assert.ok(E.mergeLibraries(old, local, old).summaryClosing);
});

test('sync: medicines merge by field, a custom text kind joins up, and nothing is lost on repeat', () => {
  const { base, local, remote, diag } = syncSetup();
  const med = (lib) => E.findExact(lib.medicines, diag(lib).meds[0].name);
  med(local).dose = '200 mg';
  med(remote).notes = 'after food';
  local.types.push({ id: 't-local', name: 'Warning signs' });
  remote.types.push({ id: 't-remote', name: 'Warning signs' });
  E.setDefaultText(remote, diag(remote).id, 't-remote', 'See a doctor.');
  const merged = E.mergeLibraries(base, local, remote);
  assert.equal(med(merged).dose, '200 mg');
  assert.equal(med(merged).notes, 'after food');
  assert.equal(merged.types.filter((t) => t.name === 'Warning signs').length, 1);
  assert.equal(diag(merged).content['t-local'][0].text, 'See a doctor.');
  assert.ok(E.sameLibrary(E.mergeLibraries(merged, merged, merged), merged));
});
