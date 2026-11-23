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
pub const SAVE_LEVEL: i64 = 2;

/// Deflate for a file that leaves the device (Save to Files, the library
/// export): about a tenth smaller than [`SAVE_LEVEL`], and any unzip tool
/// still opens it. Entry contents are the same bytes either way. Level 9
/// is only 1% smaller again but twice as slow (a 9 MB page: 2.2 s at 6,
/// 4.4 s at 9, natively).
pub const SHARE_LEVEL: i64 = 6;

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

/// Write files (name, bytes) into a ZIP archive, deflating each at
/// [`SAVE_LEVEL`]. A name that ends in `/` is a folder.
pub fn write(files: &[(&str, &[u8])]) -> Vec<u8> {
    write_at(files, SAVE_LEVEL)
}

/// [`write`] at a deflate level from 1 (fastest) to 9 (smallest).
pub fn write_at(files: &[(&str, &[u8])], level: i64) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    // 1980-01-01 00:00, the earliest a ZIP can say; we deliberately don't
    // embed clock time.
    let base = SimpleFileOptions::default().last_modified_time(DateTime::default()).unix_permissions(0o644);
    for (name, data) in files {
        // Pictures, and notes inside a library export, are compressed
        // already: deflating them again would only cost time.
        let packed = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".bedrock"]
            .iter()
            .any(|e| name.to_ascii_lowercase().ends_with(e));
        let options = if packed || data.is_empty() {
            base.compression_method(CompressionMethod::Stored)
        } else {
            base.compression_method(CompressionMethod::Deflated).compression_level(Some(level))
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

/// The same archive written again at `level`: every entry keeps its name,
/// order and exact bytes, only the compression changes. An archive that is
/// damaged, or holds anything [`read`] does not give back whole (a folder
/// entry, a damaged entry), is returned unchanged, so repacking never loses
/// a byte of content.
pub fn repack(bytes: &[u8], level: i64) -> Vec<u8> {
    let Ok(archive) = ZipArchive::new(Cursor::new(bytes)) else { return bytes.to_vec() };
    let entries = archive.len();
    match read(bytes) {
        Ok((files, problems)) if problems.is_empty() && files.len() == entries => {
            let refs: Vec<(&str, &[u8])> = files.iter().map(|(n, d)| (n.as_str(), d.as_slice())).collect();
            let out = write_at(&refs, level);
            // Only if it reads back to exactly the same entries.
            match read(&out) {
                Ok((again, p)) if p.is_empty() && again == files => out,
                _ => bytes.to_vec(),
            }
        }
        _ => bytes.to_vec(),
    }
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

    #[test]
    fn repacking_keeps_every_entry_byte_for_byte_and_is_smaller() {
        let text: String = (0..4000).map(|i| format!("{:.3},", (i as f64 * 0.37).sin() * 100.0)).collect();
        let files: [(&str, &[u8]); 3] =
            [("note.json", text.as_bytes()), ("images/a.png", b"\x89PNG raw"), ("preview.svg", text.as_bytes())];
        let fast = write(&files);
        let small = repack(&fast, SHARE_LEVEL);
        assert!(small.len() < fast.len(), "{} < {}", small.len(), fast.len());
        assert_eq!(read(&small).unwrap(), read(&fast).unwrap());
        assert_eq!(repack(&fast, SHARE_LEVEL), small, "the same bytes every time");
    }

    #[test]
    fn repacking_never_drops_what_it_cannot_read_back() {
        let mut z = write(&[("a.txt", b"hello world, hello world"), ("b.txt", b"fine")]);
        z[40] ^= 0xFF;
        assert_eq!(repack(&z, SHARE_LEVEL), z, "a damaged archive is left as it is");
        let with_folder = write(&[("School/", b""), ("School/a.txt", b"hi")]);
        assert_eq!(repack(&with_folder, SHARE_LEVEL), with_folder, "folder entries are kept");
        assert_eq!(repack(b"not a zip", SHARE_LEVEL), b"not a zip");
    }

    #[test]
    fn notes_inside_a_library_export_are_stored_not_compressed_again() {
        let note = write(&[("note.json", b"{}")]);
        let z = write(&[("School/Physics.bedrock", &note)]);
        let mut a = ZipArchive::new(Cursor::new(&z[..])).unwrap();
        assert_eq!(a.by_name("School/Physics.bedrock").unwrap().compression(), CompressionMethod::Stored);
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
