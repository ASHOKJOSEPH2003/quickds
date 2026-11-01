# QuickDS

Drafts discharge summaries from selected diagnoses and medicines, then produces plain text to paste into the hospital's existing system. It sits beside that system and does not connect to it.

It runs in any browser, installs on a phone, and works with no internet. Everyone signs in with email or Google, which keeps their library safe online and shared across their devices. The app is plain HTML, CSS and JavaScript with no build step. Firebase's own code loads only for the Google sign-in window.

## Using it

1. Sign in. After the first time, the app stays signed in and opens straight away, even offline.
2. Enter the patient details.
3. Search or tick one or more diagnoses. Most-used ones come first, then A to Z. Search understands abbreviations (T2DM), both spellings (anemia, anaemia) and small typos. A name that is not listed can be added, and duplicates are blocked.
4. Each section fills itself. Every section has a selector that decides what fills it: Blank, Diagnosis line, Auto summary, Description, Recommendations, Prescription, or any new kind of text you create.
5. Edit anything. Text you edited is never overwritten.
6. Fill the yellow medicine fields. An empty dose, frequency or duration appears in the report as `[dose?]`, so it cannot be missed.
7. Copy one section at a time or the whole report, or send it by WhatsApp or email, then paste it into the hospital system. The hospital system takes plain text, so copying always gives plain text.
8. For a report on paper or as a file, switch the Report panel to **Formatted** and press **Print or PDF**. Choose Save as PDF in the print window. It follows the same **Include patient details** setting as the text.
9. Under **Save for next time**, choose what future reports should use, then press **Finish report**.

## Sections for one diagnosis

A diagnosis can have sections of its own, added at the end of its Library page. Name it, write the text, reorder, rename or delete it. It appears in a report, before the Prescription, while that diagnosis is selected. Diagnoses that use the same section name share one report section, with a block for each. In a report it can be edited or removed for that patient, and edits can be saved back like any other text.

## How the summary is built

Every summary has three parts, in this order, however many diagnoses are selected:

1. **Opening:** one sentence with the age, sex, admission date and all the diagnoses.
2. **A note for each diagnosis** that has one, written in the Library. It holds only what is specific to that diagnosis, such as the treatment given.
3. **Closing:** one sentence with all the medicines.

The opening and closing wording is set once under **Setup > Summary wording**. In a report, all three parts can be edited for that patient. Only notes can be saved back to a diagnosis.

## How it learns

| What happens | What the app does |
| --- | --- |
| A paragraph is edited | Shows a word-by-word comparison with three choices: make default, save as a version, or just this patient |
| Patient details appear in that text | Replaces name, age, numbers and dates with placeholders before saving, and warns about any number or date left over |
| A diagnosis note in the summary is edited | Same choices, saved as that diagnosis's note |
| A dose or duration is filled in | Offers to save it as the default for that diagnosis |
| A medicine is added or removed | Offers to update the diagnosis defaults, and shows how many times it was added by hand before |
| A report is finished | Updates usage counts, which reorder the Most used list |
| A default changes | Keeps the earlier text, with date and author, and allows restoring it |

Nothing changes silently. Every default change is a doctor's choice.

Everything for a diagnosis can also be edited directly in the Library: its name, other names, summary, every kind of text, and its default medicines.

To share across a team, one person keeps the reference library: **Setup > Save library file**, then colleagues use **Merge a file**. Merging adds what is new and never deletes. When the wording differs, both are kept as versions.

## Starter content needs clinical review

The starter library was written as a first draft and has not been checked by a clinician. Each diagnosis shows **Not yet approved** until a doctor presses **Approve** at the end of its Library page, which then shows a green **Approved**.

Medicines have no dose, frequency or duration on purpose. Those values come from the doctor, once, and are then remembered.

## Privacy

- Patient reports stay in the browser of the device that made them. They are never uploaded, even when signed in.
- Reports include the patient details by default, so anything copied or sent carries them. Untick **Include patient details** to replace them with a short reference (initials and the last 4 characters of the hospital number). Names and numbers typed into free text are then removed as well.
- Report text is never put in a link. Links such as `wa.me/?text=` would send it through third-party servers and into browser history. On a phone the system share sheet is used. On a computer the text is copied, then the destination opens for pasting.
- Reports delete themselves after 14 days (adjustable in Setup). **Saved > Delete all patient reports** clears them at once.
- WhatsApp and personal email are outside the hospital's control. Get the hospital's approval before using this with real patients, and check its data rules and India's DPDP Act.

## Offline

| Feature | Offline |
| --- | --- |
| Open the app, write reports, search, edit the library | Yes, after signing in online once on that device |
| First sign-in on a device | No |
| Copy to the clipboard | Yes |
| WhatsApp and email | They need a connection. The report stays saved until then |
| Library merge by file | Yes |

Installing it matters on iPhone: use Safari > Share > Add to Home Screen. Safari can clear data for sites that are not installed after about 7 days without use.

Closing the tab or app loses nothing: work saves as you type, and an unfinished report reopens where you left it. Tabs open at the same time keep each other up to date.

Data lives in one browser on one device. Private windows, clearing browser data or losing the phone loses it, so save a library file now and then.

## Accounts and sync

The first screen is sign-in, and the app opens only after it. Each account has its own library, reports and settings on the device, so people sharing a computer do not see each other's work. Signing out hides them until that person signs in again. Anything already on a device goes to the first person who signs in there.

The account saves the library to Firebase for use on other devices. The library is the only thing sent: diagnoses, wording, medicines, approvals and the report layout. Reports and patient details are not.

- Each account has one library, at `users/{uid}/library/main`, stored as a single document.
- Sync is automatic. A device syncs when it opens or regains focus, when it comes back online, 2 seconds after a library change, and every 30 seconds while it is on screen. The top bar shows the state. With no connection it keeps working and catches up later.
- Each device remembers the library as it stood after its last sync, and compares both sides to that. A change made on one side carries over, including deletions. When both sides changed the same text, both wordings are kept as versions.
- Google sign-in needs the Google provider turned on in Firebase Authentication, and the site's address listed under Authorized domains.
- The web API key in `js/sync.js` only names the project and is safe to publish. These Firestore rules are what protect the data:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

## Testing phase

The app shows a permanent "example patients only" notice. Set `TEST_PHASE` to `false` in `js/app.js` only after the hospital approves use with real patients.

## Hosting

Offline use needs HTTPS, and any static host works: GitHub Pages, Cloudflare Pages or Netlify. Publish this folder as it is. Serving from a plain `http://` address works for trying it out, but the app will show a notice and will not work offline.

When you change any file, bump `VERSION` in `sw.js`. Open copies download the change when they next start with a connection, save the draft, and reload themselves once nobody is typing.

## Development

```bash
npm start
```

```bash
npm test
```

`js/engine.js` holds all the logic and has tests. `js/app.js` is the interface, `js/seed.js` the starter library, `js/store.js` the storage, `js/sync.js` the account and online library, and `sw.js` the offline support.
