//! Spell checking for recognised handwriting.
//!
//! Words are checked and corrections suggested by the `spellbook` crate,
//! which reads Hunspell dictionaries (an `.aff` file of rules and a `.dic`
//! file of words), the format used by LibreOffice, Firefox and most spell
//! checkers, so any language with a Hunspell dictionary works. The rules
//! know names and weekdays (which keep their capitals), contractions,
//! plurals and other word endings, and ordinals like 21st.
//!
//! Around it, Bedrock adds what handwriting needs: punctuation and quotes
//! around a word are ignored, numbers, units and single letters are never
//! flagged, and each part of a hyphenated word is checked on its own.
//!
//! The English dictionary shipped with the web app is SCOWL's en_US and
//! en_GB merged, so both spellings pass; see apps/web/dict/README.md.

/// A spell-check dictionary.
pub struct Dictionary {
    inner: spellbook::Dictionary,
    words: usize,
}

impl std::fmt::Debug for Dictionary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Dictionary").field("words", &self.words).finish()
    }
}

/// Characters stripped from the ends of a word before checking: punctuation
/// and quotes.
fn is_edge_punct(c: char) -> bool {
    !c.is_alphanumeric()
}

impl Dictionary {
    /// A Hunspell dictionary from its `.aff` and `.dic` files.
    pub fn from_hunspell(aff: &str, dic: &str) -> Result<Self, String> {
        let inner = spellbook::Dictionary::new(aff, dic).map_err(|e| e.to_string())?;
        let words = dic.lines().skip(1).filter(|l| !l.trim().is_empty()).count();
        Ok(Dictionary { inner, words })
    }

    /// A dictionary from a plain word list, one word per line. Words with
    /// capitals must be written that way; others pass in any case.
    pub fn from_list(text: &str) -> Self {
        let words: Vec<&str> = text.lines().map(str::trim).filter(|w| !w.is_empty() && !w.contains('/')).collect();
        let dic = format!("{}\n{}\n", words.len(), words.join("\n"));
        let mut d =
            Self::from_hunspell("SET UTF-8\nICONV 1\nICONV ’ '\n", &dic).expect("a plain word list always reads");
        d.words = words.len();
        d
    }

    /// How many entries the dictionary has (words or word stems).
    pub fn len(&self) -> usize {
        self.words
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// True if `word` (as written, possibly with punctuation) is spelled
    /// correctly, or isn't a word at all (numbers, symbols).
    pub fn check(&self, word: &str) -> bool {
        let core = word.trim_matches(is_edge_punct);
        if core.is_empty() || !core.chars().any(char::is_alphabetic) {
            return true;
        }
        // Numbers with units or ordinals: 3rd, 10km, 2x.
        if core.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            return true;
        }
        // Single letters (a, I, x) are fine.
        if core.chars().count() == 1 {
            return true;
        }
        if self.inner.check(core) {
            return true;
        }
        // A possessive the dictionary does not list ("Bedrock's").
        for suffix in ["'s", "’s", "'", "’"] {
            if let Some(stem) = core.strip_suffix(suffix) {
                if !stem.is_empty() && self.inner.check(stem) {
                    return true;
                }
            }
        }
        if core.contains('-') {
            return core.split('-').all(|p| p.is_empty() || self.check(p));
        }
        false
    }

    /// Up to `max` corrections for a misspelled word, best first.
    pub fn suggest(&self, word: &str, max: usize) -> Vec<String> {
        let core = word.trim_matches(is_edge_punct);
        if core.is_empty() {
            return Vec::new();
        }
        let mut found = Vec::new();
        self.inner.suggest(core, &mut found);
        // Splitting one handwritten word in two ("until l") is rarely what
        // was meant; keep those only when the word already had a break.
        let split = |w: &str| w.contains([' ', '-']);
        if !split(core) {
            found.retain(|w| !split(w));
        }
        found.truncate(max);
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dict() -> Dictionary {
        Dictionary::from_list(
            "the\nquick\nbrown\nfox\njumps\nover\nlazy\ndog\nParis\nNASA\nwell\nknown\nhello\nhelp\nheld\n",
        )
    }

    #[test]
    fn checks_words_with_the_usual_allowances() {
        let d = dict();
        for ok in [
            "the",
            "The",
            "THE",
            "fox,",
            "(dog)",
            "dog's",
            "well-known",
            "Paris",
            "PARIS",
            "NASA",
            "42",
            "3rd",
            "x",
            "—",
            "\"hello\"",
        ] {
            assert!(d.check(ok), "{ok} should pass");
        }
        for bad in ["teh", "qiuck", "paris", "brwon", "well-knwon", "nasa"] {
            assert!(!d.check(bad), "{bad} should be flagged");
        }
    }

    #[test]
    fn suggests_close_words_best_first() {
        let d = dict();
        assert_eq!(d.suggest("teh", 3).first().map(String::as_str), Some("the"), "a swap is one edit");
        assert_eq!(d.suggest("Qiuck", 1), vec!["Quick".to_string()], "keeps the capital");
        let s = d.suggest("helo", 3);
        assert_eq!(s.first().map(String::as_str), Some("hello"), "{s:?}");
        assert!(d.suggest("zzzzzzzz", 3).is_empty());
    }

    /// A file from the web app's `dict` folder, unzipped if it is gzip.
    fn shipped(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/dict").join(name);
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let mut text = String::new();
        if bytes.starts_with(&[0x1f, 0x8b]) {
            std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(&bytes[..]), &mut text).unwrap();
        } else {
            text = String::from_utf8(bytes).unwrap();
        }
        text
    }

    #[test]
    fn the_shipped_dictionary_knows_names_weekdays_and_contractions() {
        // Regression: the word list shipped before had no capitalised words
        // and no apostrophes, so all of these were underlined.
        let d = Dictionary::from_hunspell(&shipped("en.aff"), &shipped("en.dic.gz")).unwrap();
        for ok in ["Tuesday", "January", "Paris", "PARIS", "NASA", "I'm", "don't", "can’t", "it's", "Einstein"] {
            assert!(d.check(ok), "{ok} should pass");
        }
        // British and American spellings both pass; real mistakes do not.
        for ok in ["colour", "color", "organise", "organize", "theatre", "theater", "running", "unhappiness"] {
            assert!(d.check(ok), "{ok} should pass");
        }
        for bad in ["teh", "recieve", "tuesday", "paris", "nasa", "seperate"] {
            assert!(!d.check(bad), "{bad} should be flagged");
        }
    }

    #[test]
    fn the_shipped_dictionary_suggests_the_word_meant() {
        let d = Dictionary::from_hunspell(&shipped("en.aff"), &shipped("en.dic.gz")).unwrap();
        for (bad, meant) in [
            ("recieve", "receive"),
            ("becuase", "because"),
            ("tomorow", "tomorrow"),
            ("untill", "until"),
            ("goverment", "government"),
            ("Qiuck", "Quick"),
            ("hendwriting", "handwriting"),
        ] {
            let s = d.suggest(bad, 5);
            assert_eq!(s.first().map(String::as_str), Some(meant), "{bad}: {s:?}");
            assert!(s.iter().all(|w| !w.contains(' ')), "no word split in two: {s:?}");
        }
        assert!(d.suggest("teh", 3).contains(&"the".to_string()));
    }
}
