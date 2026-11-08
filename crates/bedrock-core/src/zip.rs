//! Minimal ZIP reader/writer (stored + deflate), enough for `.bedrock`
//! containers. Kept tiny and dependency-light so it compiles anywhere,
//! including WebAssembly. Any standard unzip tool can open the output.

use std::fmt;

/// Fast compression: autosave runs after every stroke, and level 2 is several
/// times faster than the default 6 for only slightly larger files.
const DEFLATE_LEVEL: u8 = 2;

#[derive(Debug, PartialEq)]
pub struct ZipError(pub String);

impl fmt::Display for ZipError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "zip: {}", self.0)
    }
}

fn err<T>(s: &str) -> Result<T, ZipError> {
    Err(ZipError(s.to_string()))
}

fn crc32_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    for (i, e) in t.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *e = c;
    }
    t
}

pub fn crc32(data: &[u8]) -> u32 {
    let t = crc32_table();
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = t[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

fn u16le(v: u16, out: &mut Vec<u8>) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn u32le(v: u32, out: &mut Vec<u8>) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// Write files (name, bytes) into a ZIP archive, deflating each.
pub fn write(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    // 1980-01-01 00:00 in DOS format; we deliberately don't embed clock time.
    let (dos_time, dos_date) = (0u16, (1 << 5) | 1);
    for (name, data) in files {
        let compressed = miniz_oxide::deflate::compress_to_vec(data, DEFLATE_LEVEL);
        let (method, body): (u16, &[u8]) = if compressed.len() < data.len() { (8, &compressed) } else { (0, data) };
        let crc = crc32(data);
        let offset = out.len() as u32;
        u32le(0x0403_4b50, &mut out);
        u16le(20, &mut out); // version needed
        u16le(1 << 11, &mut out); // flags: UTF-8 names
        u16le(method, &mut out);
        u16le(dos_time, &mut out);
        u16le(dos_date, &mut out);
        u32le(crc, &mut out);
        u32le(body.len() as u32, &mut out);
        u32le(data.len() as u32, &mut out);
        u16le(name.len() as u16, &mut out);
        u16le(0, &mut out);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(body);

        u32le(0x0201_4b50, &mut central);
        u16le(20, &mut central); // made by
        u16le(20, &mut central);
        u16le(1 << 11, &mut central);
        u16le(method, &mut central);
        u16le(dos_time, &mut central);
        u16le(dos_date, &mut central);
        u32le(crc, &mut central);
        u32le(body.len() as u32, &mut central);
        u32le(data.len() as u32, &mut central);
        u16le(name.len() as u16, &mut central);
        u16le(0, &mut central); // extra
        u16le(0, &mut central); // comment
        u16le(0, &mut central); // disk
        u16le(0, &mut central); // internal attrs
        u32le(0, &mut central); // external attrs
        u32le(offset, &mut central);
        central.extend_from_slice(name.as_bytes());
    }
    let cd_offset = out.len() as u32;
    out.extend_from_slice(&central);
    u32le(0x0605_4b50, &mut out);
    u16le(0, &mut out);
    u16le(0, &mut out);
    u16le(files.len() as u16, &mut out);
    u16le(files.len() as u16, &mut out);
    u32le(central.len() as u32, &mut out);
    u32le(cd_offset, &mut out);
    u16le(0, &mut out);
    out
}

fn rd16(b: &[u8], at: usize) -> Result<u16, ZipError> {
    b.get(at..at + 2).map(|s| u16::from_le_bytes([s[0], s[1]])).ok_or(ZipError("truncated".into()))
}
fn rd32(b: &[u8], at: usize) -> Result<u32, ZipError> {
    b.get(at..at + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])).ok_or(ZipError("truncated".into()))
}

/// `(name, bytes)` for each entry.
pub type Files = Vec<(String, Vec<u8>)>;

pub fn is_zip(b: &[u8]) -> bool {
    b.len() >= 4 && b[..4] == [0x50, 0x4b, 0x03, 0x04]
}

/// Read every file in the archive. Entries that are damaged are skipped and
/// reported in the second list, so one bad entry never hides the others.
pub fn read(b: &[u8]) -> Result<(Files, Vec<String>), ZipError> {
    // Find the end of central directory record (scan back over a comment).
    let min = b.len().saturating_sub(22 + 0xFFFF);
    let eocd = (min..=b.len().saturating_sub(22)).rev().find(|&i| b.get(i..i + 4) == Some(&[0x50, 0x4b, 0x05, 0x06]));
    let Some(eocd) = eocd else { return err("not a zip archive") };
    let count = rd16(b, eocd + 10)? as usize;
    let mut p = rd32(b, eocd + 16)? as usize;
    let mut files = Vec::new();
    let mut problems = Vec::new();
    for _ in 0..count {
        if rd32(b, p)? != 0x0201_4b50 {
            return err("bad central directory");
        }
        let method = rd16(b, p + 10)?;
        let crc = rd32(b, p + 16)?;
        let csize = rd32(b, p + 20)? as usize;
        let usize_ = rd32(b, p + 24)? as usize;
        let nlen = rd16(b, p + 28)? as usize;
        let elen = rd16(b, p + 30)? as usize;
        let clen = rd16(b, p + 32)? as usize;
        let local = rd32(b, p + 42)? as usize;
        let name =
            String::from_utf8_lossy(b.get(p + 46..p + 46 + nlen).ok_or(ZipError("truncated".into()))?).into_owned();
        p += 46 + nlen + elen + clen;
        let entry = (|| -> Result<Vec<u8>, ZipError> {
            if rd32(b, local)? != 0x0403_4b50 {
                return err("bad local header");
            }
            let start = local + 30 + rd16(b, local + 26)? as usize + rd16(b, local + 28)? as usize;
            let body = b.get(start..start + csize).ok_or(ZipError("truncated entry".into()))?;
            let data = match method {
                0 => body.to_vec(),
                8 => miniz_oxide::inflate::decompress_to_vec_with_limit(body, usize_.max(1) * 2 + 1024)
                    .map_err(|_| ZipError("corrupt deflate data".into()))?,
                m => return Err(ZipError(format!("unsupported compression method {m}"))),
            };
            if crc32(&data) != crc {
                return err("checksum mismatch");
            }
            Ok(data)
        })();
        match entry {
            Ok(d) => files.push((name, d)),
            Err(e) => problems.push(format!("{name}: {}", e.0)),
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
}
