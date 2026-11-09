//! # bedrock-core
//!
//! The platform independent heart of Bedrock. Everything that does not need a
//! GPU or a browser lives here so it can be unit tested natively and reused by
//! every Bedrock app (web via WebAssembly today, native iPad/desktop later).
//!
//! * [`input`]: raw pen samples (position, pressure, tilt, time)
//! * [`brush`]: vector brushes and how pressure / tilt shape them
//! * [`tessellate`]: turns a stroke into a triangle mesh (GPU) and an outline (SVG)
//! * [`camera`]: the infinite canvas viewport (pan / zoom)
//! * [`document`]: strokes, undo/redo and a change feed for live consumers
//!   such as handwriting recognition
//! * [`format`]: the open, durable note file format (SVG with embedded JSON)
//! * [`engine`]: pointer / gesture state machine tying it all together

pub mod brush;
pub mod camera;
pub mod color;
pub mod document;
pub mod engine;
pub mod eraser;
pub mod format;
pub mod geom;
pub mod handwriting;
pub mod input;
pub mod mirror;
pub mod overview;
pub mod pen;
pub mod scene;
pub mod spell;
pub mod stroke;
pub mod tessellate;
pub mod words;
pub mod zip;

pub use brush::{Brush, BrushKind};
pub use camera::Camera;
pub use color::Rgba;
pub use document::{Change, Document};
pub use engine::{Engine, PointerKind, Tool};
pub use geom::{Rect, Vec2};
pub use input::InputPoint;
pub use stroke::{Stroke, StrokeId};
