# QuickDS

Drafts discharge summaries from selected diagnoses and medicines, then produces plain text to paste into the hospital's existing system. It sits beside that system and does not connect to it.

It runs in any browser, installs on a phone, and works with no internet. There is no server and no account. Everything is plain HTML, CSS and JavaScript with no dependencies and no build step.

## Using it

1. Enter the patient details.
2. Search or tick one or more diagnoses. Most-used ones come first, then A to Z. Search understands abbreviations (T2DM), both spellings (anemia, anaemia) and small typos. A name that is not listed can be added, and duplicates are blocked.
3. Each section fills itself. Every section has a selector that decides what fills it: Blank, Diagnosis line, Auto summary, Description, Recommendations, Prescription, or any new kind of text you create.
4. Edit anything. Text you edited is never overwritten.
5. Fill the yellow medicine fields. An empty dose, frequency or duration appears in the report as `[dose?]`, so it cannot be missed.
6. Copy one section at a time or the whole report, or send it by WhatsApp or email, then paste it into the hospital system. The hospital system takes plain text, so copying always gives plain text.
7. For a report on paper or as a file, switch the Report panel to **Formatted** and press **Print or PDF**. Choose Save as PDF in the print window. The report follows the same patient details setting as the shared text.
8. Under **Save for next time**, choose what future reports should use, then press **Finish report**.

## How it learns

| What happens | What the app does |
| --- | --- |
| A paragraph is edited | Shows a word-by-word comparison with three choices: make default, save as a version, or just this patient |
| Patient details appear in that text | Replaces name, age, numbers and dates with placeholders before saving, and warns about any number or date left over |
| A dose or duration is filled in | Offers to save it as the default for that diagnosis |
| A medicine is added or removed | Offers to update the diagnosis defaults, and shows how many times it was added by hand before |
| A report is finished | Updates usage counts, which reorder the Most used list |
| A default changes | Keeps the earlier text, with date and author, and allows restoring it |

Nothing changes silently. Every default change is a doctor's choice.

To share across a team, one person keeps the reference library: **Setup > Save library file**, then colleagues use **Merge a file**. Merging adds what is new and never deletes. When the wording differs, both are kept as versions.

## Starter content needs clinical review

The starter library was written as a first draft and has not been checked by a clinician. Each diagnosis shows **Not yet reviewed** until a doctor marks it reviewed.

Medicines have no dose, frequency or duration on purpose. Those values come from the doctor, once, and are then remembered.

## Privacy

- Patient reports stay in the browser of the device that made them. There is no server to send them to.
- The shared copy leaves out patient name and numbers by default, because the hospital system already holds them. It carries a short reference (initials and the last 4 characters of the hospital number) to match it to the right patient. Names and numbers typed into free text are removed as well.
- Report text is never put in a link. Links such as `wa.me/?text=` would send it through third-party servers and into browser history. On a phone the system share sheet is used. On a computer the text is copied, then the destination opens for pasting.
- Reports delete themselves after 14 days (adjustable in Setup). **Saved > Delete all patient reports** clears them at once.
- WhatsApp and personal email are outside the hospital's control. Get the hospital's approval before using this with real patients, and check its data rules and India's DPDP Act.

## Offline

| Feature | Offline |
| --- | --- |
| Open the app, write reports, search, edit the library | Yes, once it has been opened online one time |
| Copy to the clipboard | Yes |
| WhatsApp and email | They need a connection. The report stays saved until then |
| Library merge by file | Yes |

Installing it matters on iPhone: use Safari > Share > Add to Home Screen. Safari can clear data for sites that are not installed after about 7 days without use.

Data lives in one browser on one device. Clearing browser data or losing the phone loses it, so save a library file now and then.

## Testing phase

The app shows a permanent "example patients only" notice. Set `TEST_PHASE` to `false` in `js/app.js` only after the hospital approves use with real patients.

## Hosting

Offline use needs HTTPS, and any static host works: GitHub Pages, Cloudflare Pages or Netlify. Publish this folder as it is. Serving from a plain `http://` address works for trying it out, but the app will show a notice and will not work offline.

When you change any file, bump `VERSION` in `sw.js`. Installed copies pick up the change the next time they open with a connection.

## Development

```bash
npm start
```

```bash
npm test
```

`js/engine.js` holds all the logic and has tests. `js/app.js` is the interface, `js/seed.js` the starter library, `js/store.js` the storage, and `sw.js` the offline support.
