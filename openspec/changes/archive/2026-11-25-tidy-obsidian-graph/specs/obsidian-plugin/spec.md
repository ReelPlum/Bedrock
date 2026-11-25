# obsidian-plugin Specification

## ADDED Requirements

### Requirement: The plugin SHALL offer a graph filter that shows each note once, without the #bedrock tag

Obsidian gives plugins no way to set the graph's filters, so the plugin
hands the writer one to paste into the graph's "Search files":
`-file:/\.bedrock$/ -(#bedrock)`. `-file:/\.bedrock$/` hides the `.bedrock`
files, so each handwritten note is one node, its index note (sidecars end
in `.bedrock.md` and stay). `-(#bedrock)` hides the `#bedrock` tag node
and keeps the notes that carry the tag. With "Attachments" on, PDFs show,
and a note linking a PDF page is an edge from its index note to the PDF.

#### Scenario: What the filter hides and keeps
- **GIVEN** a handwritten note with a tag and a link to a PDF page, its index note, a sidecar and the PDF
- **WHEN** the graph's search is the plugin's filter
- **THEN** the `.bedrock` file matches `-file:/\.bedrock$/` and the index note, sidecar and PDF do not; the index note says `bedrock` only in its front matter tags, never `#bedrock` in its text, and keeps its link to the PDF page
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the graph filter hides .bedrock files and the #bedrock tag node, and keeps index notes, sidecars and PDFs -->

#### Scenario: Copying the filter
- **GIVEN** the plugin is loaded, on a computer or an iPad
- **WHEN** "Copy graph filter that hides .bedrock files and the #bedrock tag" is run, or "Copy filter" is pressed in the settings
- **THEN** the filter is on the clipboard and a notice says to turn on "Attachments" and paste it into "Search files"; where the clipboard is refused the notice shows the filter itself
<!-- test-js: apps/obsidian/tests/unit.test.mjs :: the graph filter goes on the clipboard, or is shown where the clipboard is refused -->
<!-- test-js: apps/obsidian/tests/plugin.test.mjs :: registers the .bedrock view, commands and settings, and writes nothing into the plugin folder -->
