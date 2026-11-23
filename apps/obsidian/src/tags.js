// Every tag in the vault, for the canvas's tag box to suggest
// (`list-tags`, apps/web/src/tag-suggest.js). Read from Obsidian's metadata
// cache with its public `getAllTags`, so it finds what Obsidian's own tag
// pane and search find: `#tags` in the text and `tags` in the front matter
// of every Markdown note. A handwritten note's tags are in its index note's
// front matter, so they are found the same way. `bedrock`, which every
// index note has, is left out.

import { tallyTags } from '../../web/src/tag-suggest.js';

/** `[{ tag, count }]`: each tag (without `#`) and how many notes have it.
 *  `getAllTags` is Obsidian's (passed in, so this runs outside Obsidian). */
export function vaultTags(app, getAllTags) {
  const lists = [];
  for (const f of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(f);
    if (cache) lists.push(getAllTags(cache) || []);
  }
  return tallyTags(lists);
}
