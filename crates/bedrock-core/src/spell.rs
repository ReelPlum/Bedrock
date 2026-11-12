//! Spell checking for recognised handwriting.
//!
//! A plain word list (one word per line, any case), checked case-insensitively
//! with the usual allowances: numbers, a leading capital at the start of a
//! sentence, possessive 's, hyphenated compounds and surrounding punctuation.
//! Suggestions are words one or two edits away (Damerau-Levenshtein), most
//! common first when the list is in frequency order, otherwise shortest edit.
//!
//! The English list shipped with the web app is SCOWL size 60 (American and
//! British), by Kevin Atkinson; see apps/web/dict/README.

use std::collections::HashMap;

#[derive(Debug, Default, Clone)]
pub struct Dictionary {
    /// Lower-cased word -> rank in the list (lower is listed earlier).
    words: HashMap<String, u32>,
    /// Words that must keep their capitals (proper nouns, acronyms).
    exact: HashMap<String, u32>,
    /// Lower-cased forms of `exact`, to accept them written in all capitals.
    exact_lower: HashMap<String, u32>,
}

/// Characters stripped from the ends of a word before checking: punctuation
/// and quotes.
fn is_edge_punct(c: char) -> bool {
    !c.is_alphanumeric()
}

impl Dictionary {
    pub fn from_list(text: &str) -> Self {
        let mut d = Dictionary::default();
        for (rank, w) in text.lines().map(str::trim).filter(|w| !w.is_empty()).enumerate() {
            let rank = rank as u32;
            let lower = w.to_lowercase();
            if w.chars().any(char::is_uppercase) {
                d.exact.entry(w.to_string()).or_insert(rank);
                d.exact_lower.entry(lower).or_insert(rank);
            } else {
                d.words.entry(lower).or_insert(rank);
            }
        }
        d
    }

    pub fn len(&self) -> usize {
        self.words.len() + self.exact.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn known(&self, w: &str) -> bool {
        if w.is_empty() {
            return true;
        }
        if self.exact.contains_key(w) {
            return true;
        }
        let lower = w.to_lowercase();
        if self.words.contains_key(&lower) {
            return true;
        }
        // "Paris" written "PARIS", or a capitalised word at sentence start.
        if self.exact_lower.contains_key(&lower) && w.chars().all(|c| !c.is_lowercase()) {
            return true;
        }
        false
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
        if self.known(core) {
            return true;
        }
        for suffix in ["'s", "’s", "'"] {
            if let Some(stem) = core.strip_suffix(suffix) {
                if self.known(stem) {
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
        let core = word.trim_matches(is_edge_punct).to_lowercase();
        let n = core.chars().count();
        if n == 0 {
            return Vec::new();
        }
        let target: Vec<char> = core.chars().collect();
        let mut found: Vec<(usize, u32, &str)> = self
            .words
            .iter()
            .filter(|(w, _)| w.chars().count().abs_diff(n) <= 2)
            .filter_map(|(w, &rank)| {
                let d = edit_distance(&target, &w.chars().collect::<Vec<_>>(), 2)?;
                Some((d, rank, w.as_str()))
            })
            .collect();
        found.sort();
        let capital = word.trim_matches(is_edge_punct).chars().next().is_some_and(char::is_uppercase);
        found
            .into_iter()
            .take(max)
            .map(|(_, _, w)| {
                if capital {
                    let mut c = w.chars();
                    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
                } else {
                    w.to_string()
                }
            })
            .collect()
    }
}

/// Damerau-Levenshtein (optimal string alignment) distance, or None if it
/// exceeds `limit`.
fn edit_distance(a: &[char], b: &[char], limit: usize) -> Option<usize> {
    let (n, m) = (a.len(), b.len());
    if n.abs_diff(m) > limit {
        return None;
    }
    let mut prev2 = vec![0usize; m + 1];
    let mut prev: Vec<usize> = (0..=m).collect();
    let mut cur = vec![0usize; m + 1];
    for i in 1..=n {
        cur[0] = i;
        let mut row_min = cur[0];
        for j in 1..=m {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut v = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                v = v.min(prev2[j - 2] + 1);
            }
            cur[j] = v;
            row_min = row_min.min(v);
        }
        if row_min > limit {
            return None;
        }
        std::mem::swap(&mut prev2, &mut prev);
        std::mem::swap(&mut prev, &mut cur);
    }
    (prev[m] <= limit).then_some(prev[m])
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

    #[test]
    fn edit_distance_is_damerau() {
        let c = |s: &str| s.chars().collect::<Vec<_>>();
        assert_eq!(edit_distance(&c("abc"), &c("abc"), 2), Some(0));
        assert_eq!(edit_distance(&c("abc"), &c("acb"), 2), Some(1));
        assert_eq!(edit_distance(&c("abc"), &c("xyz"), 2), None);
        assert_eq!(edit_distance(&c("kitten"), &c("sitting"), 3), Some(3));
    }
}
