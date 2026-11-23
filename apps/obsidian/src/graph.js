// A tidy graph view. Obsidian's graph shows every handwritten note twice
// when attachments are on (its index note, and the .bedrock file the index
// note links to) and joins every index note to a `#bedrock` tag node when
// tags are on. Obsidian has no setting or plugin API for the graph's
// filters, so the plugin hands the writer a search filter to paste into the
// graph's "Search files" box: it hides the .bedrock files (each note is then
// one node, its index note, which carries the note's links, PDF pages
// included) and the `#bedrock` tag node, and keeps everything else.
//
// - `-file:/\.bedrock$/` hides files whose name ends in `.bedrock`. A
//   sidecar (`Name.bedrock.md`) does not end so, and stays.
// - `-(#bedrock)` hides the `#bedrock` tag node and keeps the notes that
//   carry the tag (`-tag:#bedrock` would hide those notes too). Index notes
//   list it in their front matter, never as `#bedrock` in their text, so no
//   index note matches it.

export const GRAPH_FILTER_PARTS = ['-file:/\\.bedrock$/', '-(#bedrock)'];
export const GRAPH_FILTER = GRAPH_FILTER_PARTS.join(' ');

export const GRAPH_HOW = 'Open the graph view, turn on "Attachments" under Filters (so PDFs show), and paste it into "Search files".';

/** Put the filter on the clipboard and say what to do with it. Falls back
 *  to showing the filter where the clipboard is not allowed. */
export async function copyGraphFilter(clipboard, notice) {
  try {
    await clipboard.writeText(GRAPH_FILTER);
    notice(`Graph filter copied. ${GRAPH_HOW}`);
    return true;
  } catch (_) {
    notice(`Graph filter: ${GRAPH_FILTER}  ${GRAPH_HOW}`);
    return false;
  }
}
