# iCloud and sync plan

Decision (Frederik, Nov 2026): **iCloud Drive via the Files app now, CloudKit
sync later** once there is an Apple Developer account.

## Now: iCloud Drive through Files (shipped)

A website cannot write into iCloud Drive by itself, but the operating system
can do it for us:

| Where | Save | Open |
|---|---|---|
| iPad / iPhone Safari | Menu → "Save to iCloud Drive / Files" opens the share sheet; choose **Save to Files** → iCloud Drive. | Menu → "Open file…" shows the Files picker, which browses iCloud Drive. |
| Chrome / Edge on Mac or PC | Saves straight into a folder you pick, for example iCloud Drive. Later saves of the same note overwrite that file. | File picker. |
| Other browsers | Download, then move the file. | File picker. |

Notes are always saved on the device first (IndexedDB), automatically, so
nothing depends on the network. "Export all notes" writes every note into one
ZIP for a full backup.

## Later: automatic sync with CloudKit

CloudKit JS lets a web page read and write a CloudKit container after the
user signs in with their Apple ID. It stores CloudKit *records* (not files in
iCloud Drive). What it needs:

1. Apple Developer Program membership.
2. A CloudKit container (e.g. `iCloud.com.bedrock.notes`) with a `Note` record
   type: `title` (String), `modified` (Date/Time), `data` (Asset: the
   `.bedrock` file).
3. A web API token for the container, with the site's domain allowed.
4. Fill `BEDROCK_CLOUD_CONFIG.cloudKit = { containerIdentifier, apiToken, environment }`
   and implement the provider in `apps/web/src/cloud.js` (interface already defined).

Sync design (from the research doc): local first, merge instead of
overwrite. Strokes have random 64-bit ids and are append-mostly, so two
devices that edited offline merge by taking the union of strokes and applying
deletions (tombstones). A CRDT library such as Automerge (Rust core, compiles
to WASM and iOS) is the next step if per-stroke merging is not enough. A
native iPad app would additionally write real `.bedrock` files into the app's
iCloud Drive folder.
