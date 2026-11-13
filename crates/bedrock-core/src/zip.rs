//! The ZIP container of `.bedrock` files and of the exported library,
//! written and read with the `zip` crate (deflate through `flate2`'s pure
//! Rust backend, so it builds for WebAssembly). Any standard unzip tool can
//! open the output.
//!
//! What Bedrock asks of it, and the tests below hold it to:
//! * the same files always give the same bytes (a fixed 1980 timestamp, no
//!   clock), so a note that did not change does not look changed to sync;
//! * pictures are stored as they are: they are compressed already;
//! * one damaged entry is skipped and reported, never hiding the others;
//! * an entry cannot unpack to more than it declares (no ZIP bombs).

use std::fmt;
use std::io::{Cursor, Read, Write};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

/// Fast compression: autosave runs after every stroke, and level 2 is several
/// times faster than the default 6 for only slightly larger files.
const DEFLATE_LEVEL: i64 = 2;

#[derive(Debug, PartialEq)]
pub struct ZipError(pub String);

impl fmt::Display for ZipError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "zip: {}", self.0)
    }
}

/// CRC-32 (the ZIP and PNG checksum) of `data`.
pub fn crc32(data: &[u8]) -> u32 {
    crc32fast::hash(data)
}

/// Write files (name, bytes) into a ZIP archive, deflating each. A name
/// that ends in `/` is a folder.
pub fn write(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    // 1980-01-01 00:00, the earliest a ZIP can say; we deliberately don't
    // embed clock time.
    let base = SimpleFileOptions::default().last_modified_time(DateTime::default()).unix_permissions(0o644);
    for (name, data) in files {
        // Pictures are compressed already: deflating megabytes again on
        // every autosave would only cost time.
        let packed =
            [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"].iter().any(|e| name.to_ascii_lowercase().ends_with(e));
        let options = if packed || data.is_empty() {
            base.compression_method(CompressionMethod::Stored)
        } else {
            base.compression_method(CompressionMethod::Deflated).compression_level(Some(DEFLATE_LEVEL))
        };
        // Writing into memory cannot fail; a name the format cannot hold
        // (longer than 65 535 bytes) is left out rather than panicking.
        let added = if name.ends_with('/') {
            zip.add_directory(*name, base.unix_permissions(0o755))
        } else {
            zip.start_file(*name, options).and_then(|()| zip.write_all(data).map_err(Into::into))
        };
        if added.is_err() {
            let _ = zip.abort_file();
        }
    }
    zip.finish().map(Cursor::into_inner).unwrap_or_default()
}

/// `(name, bytes)` for each entry.
pub type Files = Vec<(String, Vec<u8>)>;

pub fn is_zip(b: &[u8]) -> bool {
    b.len() >= 4 && b[..4] == [0x50, 0x4b, 0x03, 0x04]
}

/// Read every file in the archive. Entries that are damaged are skipped and
/// reported in the second list, so one bad entry never hides the others.
pub fn read(b: &[u8]) -> Result<(Files, Vec<String>), ZipError> {
    let mut archive = ZipArchive::new(Cursor::new(b)).map_err(|e| ZipError(e.to_string()))?;
    let mut files = Vec::new();
    let mut problems = Vec::new();
    for i in 0..archive.len() {
        let name =
            archive.name_for_index(i).and_then(Result::ok).map_or_else(|| format!("entry {i}"), |n| n.into_owned());
        let entry = (|| -> Result<Option<Vec<u8>>, String> {
            let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
            if file.is_dir() {
                return Ok(None);
            }
            // Never unpack more than the entry says it holds.
            let size = file.size();
            let mut data = Vec::with_capacity(size.min(1 << 24) as usize);
            (&mut file).take(size + 1).read_to_end(&mut data).map_err(|e| e.to_string())?;
            if data.len() as u64 != size {
                return Err("the entry is larger than it says".into());
            }
            Ok(Some(data))
        })();
        match entry {
            Ok(Some(d)) => files.push((name, d)),
            Ok(None) => {}
            Err(e) => problems.push(format!("{name}: {e}")),
        }
    }
    Ok((files, problems))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_known_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn roundtrip() {
        let big = "stroke ".repeat(1000);
        let z = write(&[("a.txt", b"hello"), ("dir/b.json", big.as_bytes())]);
        assert!(is_zip(&z));
        let (files, problems) = read(&z).unwrap();
        assert!(problems.is_empty());
        assert_eq!(files[0], ("a.txt".to_string(), b"hello".to_vec()));
        assert_eq!(files[1].1, big.as_bytes());
        assert!(z.len() < big.len(), "large entries are compressed");
    }

    #[test]
    fn corrupt_entry_is_reported_not_fatal() {
        let mut z = write(&[("a.txt", b"hello world, hello world"), ("b.txt", b"fine")]);
        // Flip a byte inside the first entry's data (after its 30 + 5 byte header).
        z[40] ^= 0xFF;
        let (files, problems) = read(&z).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "b.txt");
        assert_eq!(problems.len(), 1);
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(read(b"definitely not a zip").is_err());
        assert!(read(&[]).is_err());
    }

    #[test]
    fn the_same_files_give_the_same_bytes() {
        let files: [(&str, &[u8]); 3] =
            [("note.json", b"{\"strokes\":[]}"), ("images/a.png", b"\x89PNG"), ("School/", b"")];
        assert_eq!(write(&files), write(&files));
    }

    #[test]
    fn pictures_are_stored_and_text_is_deflated() {
        let text = "stroke ".repeat(200);
        let z = write(&[("images/a.png", text.as_bytes()), ("note.json", text.as_bytes())]);
        let mut a = ZipArchive::new(Cursor::new(&z[..])).unwrap();
        assert_eq!(a.by_name("images/a.png").unwrap().compression(), CompressionMethod::Stored);
        assert_eq!(a.by_name("note.json").unwrap().compression(), CompressionMethod::Deflated);
    }

    #[test]
    fn a_folder_entry_is_kept_for_other_tools_and_skipped_when_reading() {
        let z = write(&[("School/", b""), ("School/a.txt", b"hi")]);
        let mut a = ZipArchive::new(Cursor::new(&z[..])).unwrap();
        assert!(a.by_name("School/").unwrap().is_dir());
        let (files, problems) = read(&z).unwrap();
        assert!(problems.is_empty());
        assert_eq!(files, vec![("School/a.txt".to_string(), b"hi".to_vec())]);
    }

    /// A `.bedrock` written by the hand-written ZIP code this module
    /// replaced still opens, entry for entry.
    #[test]
    fn archives_from_the_earlier_writer_still_open() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/old-formats");
        for name in ["v1-first-release", "v1-before-pictures", "v1-pictures-and-text-boxes"] {
            let bytes = std::fs::read(dir.join(format!("{name}.bedrock"))).unwrap();
            let (files, problems) = read(&bytes).unwrap();
            assert!(problems.is_empty(), "{name}: {problems:?}");
            let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
            assert!(names.contains(&"note.json") && names.contains(&"preview.svg"), "{name}: {names:?}");
        }
    }
}
