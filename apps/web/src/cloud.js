// Cloud sync interface (not active yet).
//
// Bedrock is local-first: notes are always saved in IndexedDB first. A sync
// provider then merges notes between devices in the background. Notes are
// merge-friendly by design: every stroke has a random 64-bit id and strokes
// are append-mostly, so two devices that wrote offline can be merged by
// taking the union of strokes (plus deletions) instead of overwriting.
//
// Planned provider: CloudKit JS (Sign in with Apple, private database).
// It needs an Apple Developer Program membership, a CloudKit container and
// an API token; see docs/icloud.md. Until configured, `createSyncProvider`
// returns null and the app relies on "Save to iCloud Drive / Files".

/**
 * @typedef {Object} SyncProvider
 * @property {string} name
 * @property {() => Promise<boolean>} signIn
 * @property {() => Promise<void>} signOut
 * @property {(note: {id: string, modified: number, data: Uint8Array}) => Promise<void>} push
 * @property {(since: number) => Promise<Array<{id: string, modified: number, data: Uint8Array}>>} pull
 */

/** @returns {SyncProvider | null} */
export function createSyncProvider(config = globalThis.BEDROCK_CLOUD_CONFIG) {
  if (!config || !config.cloudKit || !config.cloudKit.containerIdentifier || !config.cloudKit.apiToken) {
    return null;
  }
  // Implemented once a CloudKit container exists (docs/icloud.md).
  return null;
}
