//! `points.bin`: the pen samples of a `.bedrock` note in a compact binary
//! form, about a third the size of the same numbers written as JSON text.
//! It holds exactly the numbers `note.json` would hold: each value is saved
//! as a whole number of its channel's smallest step (1/1000 of a world unit
//! for positions, 1/10 ms for time), which is how `note.json` already rounds
//! them, so reading it back gives the very same values, bit for bit.
//!
//! The layout fits in a paragraph (also in `docs/note-format.md`), so any
//! language can read it without Bedrock's code:
//!
//! ```text
//! "BDPT"                      4 bytes
//! version                     1 (LEB128)
//! channel count C             LEB128
//! C × { name length, name (UTF-8), decimals }   LEB128, bytes, LEB128
//! stroke count N              LEB128
//! N × { sample count n,       LEB128
//!       n × C deltas }        signed LEB128
//! ```
//!
//! A value is `integer / 10^decimals`. Each integer is stored as the
//! difference from the same channel of the previous sample of that stroke
//! (the first from 0). LEB128 is the variable-length integer encoding of
//! WebAssembly and DWARF, read and written by the `leb128` crate.

use std::io::Read;

pub const MAGIC: &[u8; 4] = b"BDPT";
pub const VERSION: u64 = 1;

/// Largest whole number an `f64` holds exactly.
const EXACT: f64 = 9_007_199_254_740_992.0;

/// A channel's name and how many decimals its values keep.
#[derive(Clone, Debug, PartialEq)]
pub struct Channel {
    pub name: String,
    pub decimals: u32,
}

/// `value` as a whole number of `10^-decimals` steps, if that gives back
/// exactly the same `f64` (it does for every value `note.json` rounds to
/// `decimals`; anything else stays in `note.json` as text).
pub fn to_steps(value: f64, decimals: u32) -> Option<i64> {
    if !value.is_finite() {
        return None;
    }
    let scale = 10f64.powi(decimals as i32);
    let k = (value * scale).round();
    if k.abs() >= EXACT || from_steps(k as i64, decimals).to_bits() != value.to_bits() {
        return None;
    }
    Some(k as i64)
}

pub fn from_steps(k: i64, decimals: u32) -> f64 {
    let v = k as f64 / 10f64.powi(decimals as i32);
    if v == 0.0 {
        0.0
    } else {
        v
    }
}

/// The steps of one stroke's flat `points` (`channels.len()` per sample),
/// or `None` if any value cannot be stored exactly.
pub fn stroke_steps(points: &[f64], channels: &[Channel]) -> Option<Vec<i64>> {
    let c = channels.len();
    if c == 0 || !points.len().is_multiple_of(c) {
        return None;
    }
    points.iter().enumerate().map(|(i, v)| to_steps(*v, channels[i % c].decimals)).collect()
}

/// Write `points.bin` for `strokes` (each a flat list of steps).
pub fn encode(channels: &[Channel], strokes: &[Vec<i64>]) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + strokes.iter().map(|s| s.len() * 2).sum::<usize>());
    let u = |out: &mut Vec<u8>, v: u64| {
        leb128::write::unsigned(out, v).expect("writing to memory");
    };
    out.extend_from_slice(MAGIC);
    u(&mut out, VERSION);
    u(&mut out, channels.len() as u64);
    for ch in channels {
        u(&mut out, ch.name.len() as u64);
        out.extend_from_slice(ch.name.as_bytes());
        u(&mut out, ch.decimals as u64);
    }
    let c = channels.len().max(1);
    u(&mut out, strokes.len() as u64);
    for s in strokes {
        u(&mut out, (s.len() / c) as u64);
        let mut prev = vec![0i64; c];
        for (i, k) in s.iter().enumerate() {
            let p = &mut prev[i % c];
            leb128::write::signed(&mut out, k.wrapping_sub(*p)).expect("writing to memory");
            *p = *k;
        }
    }
    out
}

/// What `points.bin` holds: its channels, and each stroke's values.
#[derive(Debug, PartialEq)]
pub struct Decoded {
    pub channels: Vec<Channel>,
    pub strokes: Vec<Vec<f64>>,
}

/// Read `points.bin`. A damaged or truncated file is an error, never a
/// panic, and never allocates more than the file could hold.
pub fn decode(bytes: &[u8]) -> Result<Decoded, String> {
    let mut r = bytes;
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic).map_err(|_| "too short".to_string())?;
    if &magic != MAGIC {
        return Err("not a Bedrock points file".into());
    }
    let u = |r: &mut &[u8]| leb128::read::unsigned(r).map_err(|e| format!("damaged: {e}"));
    let version = u(&mut r)?;
    if version != VERSION {
        return Err(format!("points file version {version} is not known"));
    }
    let c = u(&mut r)? as usize;
    if c == 0 || c > 64 {
        return Err(format!("{c} channels"));
    }
    let mut channels = Vec::with_capacity(c);
    for _ in 0..c {
        let len = u(&mut r)? as usize;
        if len > r.len() || len > 256 {
            return Err("damaged channel name".into());
        }
        let (name, rest) = r.split_at(len);
        r = rest;
        let name = std::str::from_utf8(name).map_err(|_| "damaged channel name".to_string())?.to_string();
        let decimals = u(&mut r)?;
        if decimals > 15 {
            return Err(format!("{decimals} decimals"));
        }
        channels.push(Channel { name, decimals: decimals as u32 });
    }
    let n = u(&mut r)? as usize;
    // Every stroke takes at least one byte.
    if n > r.len() {
        return Err("damaged stroke count".into());
    }
    let mut strokes = Vec::with_capacity(n);
    for _ in 0..n {
        let samples = u(&mut r)? as usize;
        // Every value takes at least one byte.
        let values = samples.checked_mul(c).filter(|v| *v <= r.len()).ok_or("damaged sample count")?;
        let mut prev = vec![0i64; c];
        let mut out = Vec::with_capacity(values);
        for i in 0..values {
            let d = leb128::read::signed(&mut r).map_err(|e| format!("damaged: {e}"))?;
            let p = &mut prev[i % c];
            *p = p.checked_add(d).ok_or("damaged: a value overflows")?;
            out.push(from_steps(*p, channels[i % c].decimals));
        }
        strokes.push(out);
    }
    if !r.is_empty() {
        return Err(format!("{} bytes after the last stroke", r.len()));
    }
    Ok(Decoded { channels, strokes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn chans() -> Vec<Channel> {
        [("x", 3), ("y", 3), ("pressure", 3), ("t", 1)]
            .iter()
            .map(|(n, d)| Channel { name: n.to_string(), decimals: *d })
            .collect()
    }

    #[test]
    fn values_come_back_bit_for_bit() {
        let pts = [100.5, -200.25, 0.237, 0.0, 101.75, -200.125, 0.3, 4.2, 1e9, -1e9, 1.0, 1794000000000.5];
        let c = chans();
        let steps = stroke_steps(&pts, &c).unwrap();
        let d = decode(&encode(&c, &[steps])).unwrap();
        assert_eq!(d.channels, c);
        let bits = |v: &[f64]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&d.strokes[0]), bits(&pts));
    }

    #[test]
    fn values_that_are_not_exact_steps_are_refused() {
        let c = chans();
        assert_eq!(stroke_steps(&[0.0005, 0.0, 0.0, 0.0], &c), None, "more decimals than the channel keeps");
        assert_eq!(stroke_steps(&[f64::NAN, 0.0, 0.0, 0.0], &c), None);
        assert_eq!(stroke_steps(&[1e300, 0.0, 0.0, 0.0], &c), None);
        assert_eq!(stroke_steps(&[1.0, 2.0, 3.0], &c), None, "an incomplete sample");
    }

    #[test]
    fn damaged_files_are_errors_not_panics() {
        let c = chans();
        let good = encode(&c, &[stroke_steps(&[1.0, 2.0, 0.5, 0.0, 1.5, 2.5, 0.5, 4.2], &c).unwrap()]);
        assert!(decode(&good).is_ok());
        for cut in 0..good.len() {
            assert!(decode(&good[..cut]).is_err(), "cut at {cut}");
        }
        let mut huge = MAGIC.to_vec();
        huge.extend_from_slice(&[1, 1, 1, b'x', 0, 0xff, 0xff, 0xff, 0xff, 0x0f]);
        assert!(decode(&huge).is_err(), "a stroke count larger than the file");
        assert!(decode(b"PK\x03\x04").is_err());
    }

    proptest! {
        #[test]
        fn any_rounded_values_round_trip(raw in prop::collection::vec(prop::collection::vec(-1e7f64..1e7, 0..40), 0..6)) {
            let c = chans();
            let strokes: Vec<Vec<f64>> = raw.iter().map(|s| {
                let n = s.len() - s.len() % c.len();
                s[..n].iter().enumerate().map(|(i, v)| {
                    let m = 10f64.powi(c[i % c.len()].decimals as i32);
                    let r = (v * m).round() / m;
                    if r == 0.0 { 0.0 } else { r }
                }).collect()
            }).collect();
            let steps: Vec<Vec<i64>> = strokes.iter().map(|s| stroke_steps(s, &c).unwrap()).collect();
            let d = decode(&encode(&c, &steps)).unwrap();
            for (a, b) in d.strokes.iter().zip(&strokes) {
                prop_assert_eq!(a.iter().map(|x| x.to_bits()).collect::<Vec<_>>(), b.iter().map(|x| x.to_bits()).collect::<Vec<_>>());
            }
        }
    }
}
