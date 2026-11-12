//! Colors are stored as `#rrggbbaa` hex strings in files: readable by humans
//! and by every tool that understands CSS colors.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Rgba {
    pub const BLACK: Rgba = Rgba::rgb(0x1c, 0x1c, 0x1e);

    pub const fn rgb(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b, a: 255 }
    }

    pub fn alpha_f32(&self) -> f32 {
        self.a as f32 / 255.0
    }

    /// `#rrggbb` (no alpha), handy for SVG `fill`.
    pub fn to_hex_rgb(&self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
    }

    pub fn to_hex(&self) -> String {
        format!("#{:02x}{:02x}{:02x}{:02x}", self.r, self.g, self.b, self.a)
    }

    /// Parses `#rgb`, `#rrggbb` and `#rrggbbaa`.
    pub fn parse(s: &str) -> Option<Rgba> {
        let h = s.trim().strip_prefix('#')?;
        if !h.is_ascii() {
            return None;
        }
        let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
        match h.len() {
            3 => {
                let n = |i: usize| u8::from_str_radix(&h[i..i + 1], 16).ok().map(|v| v * 17);
                Some(Rgba::rgb(n(0)?, n(1)?, n(2)?))
            }
            6 => Some(Rgba::rgb(byte(0)?, byte(2)?, byte(4)?)),
            8 => Some(Rgba { r: byte(0)?, g: byte(2)?, b: byte(4)?, a: byte(6)? }),
            _ => None,
        }
    }
}

impl Serialize for Rgba {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for Rgba {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Rgba::parse(&s).ok_or_else(|| serde::de::Error::custom(format!("invalid color {s:?}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_format() {
        assert_eq!(Rgba::parse("#fff"), Some(Rgba::rgb(255, 255, 255)));
        assert_eq!(Rgba::parse("#102030"), Some(Rgba::rgb(16, 32, 48)));
        let c = Rgba::parse("#10203040").unwrap();
        assert_eq!(c.a, 0x40);
        assert_eq!(c.to_hex(), "#10203040");
        assert_eq!(c.to_hex_rgb(), "#102030");
        assert_eq!(Rgba::parse("nope"), None);
        assert_eq!(Rgba::parse("#ééé"), None);
    }
}
