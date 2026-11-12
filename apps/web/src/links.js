// Kinds of link a handwritten word can be. Each kind says how to ask for a
// target, how to tidy what was typed, and how to open it. Adding a kind
// (Obsidian notes, other Bedrock notes, a heading, an email address) means
// adding an entry here; the file stores { type, target } and keeps kinds it
// doesn't know, so older versions never lose a newer kind of link.

export const LINK_TYPES = [
  {
    id: 'url',
    label: 'Website',
    placeholder: 'https://example.com',
    inputType: 'url',
    available: true,
    /** Tidy what was typed; null if it can't be a web address. */
    normalize(v) {
      const t = v.trim();
      if (!t) return null;
      const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
      try {
        const u = new URL(withScheme);
        return ['http:', 'https:'].includes(u.protocol) && u.hostname.includes('.') ? u.href : null;
      } catch (_) {
        return null;
      }
    },
    open(target) {
      const a = Object.assign(document.createElement('a'), { href: target, target: '_blank', rel: 'noopener' });
      a.click();
    },
    describe: (target) => target.replace(/^https?:\/\//, '').replace(/\/$/, ''),
  },
  {
    // Another note, by name: saved as [[Name]] in links.md, which is what
    // Obsidian's graph reads. Turned on once Bedrock runs inside Obsidian.
    id: 'note',
    label: 'Obsidian note',
    placeholder: 'Note name',
    inputType: 'text',
    available: false,
    normalize: (v) => v.trim().replace(/^\[\[|\]\]$/g, '') || null,
    open(target) {
      const a = Object.assign(document.createElement('a'), { href: `obsidian://open?file=${encodeURIComponent(target)}` });
      a.click();
    },
    describe: (target) => `[[${target}]]`,
  },
];

export const linkType = (id) => LINK_TYPES.find((t) => t.id === id);
