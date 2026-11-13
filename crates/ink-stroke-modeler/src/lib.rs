//! Google's [Ink Stroke Modeler](https://github.com/google/ink-stroke-modeler)
//! (C++, Apache-2.0), with a safe Rust interface.
//!
//! The modeler turns raw pen samples into a smooth stroke: a wobble smoother
//! for slow, shaky movement, a spring and mass model that pulls the line
//! along behind the pen, resampling to a steady rate, and the pen's
//! pressure, tilt and orientation carried along. It can also predict where
//! the pen is going.
//!
//! Times are in seconds, positions in any unit (the parameters' speeds and
//! distances are in the same unit).

#![allow(clippy::missing_safety_doc)]

use std::ptr::NonNull;

mod ffi {
    #[repr(C)]
    pub struct IsmModeler {
        _private: [u8; 0],
    }

    #[repr(C)]
    pub struct IsmParams {
        pub wobble_timeout: f64,
        pub wobble_speed_floor: f64,
        pub wobble_speed_ceiling: f64,
        pub spring_mass_constant: f32,
        pub drag_constant: f32,
        pub min_output_rate: f64,
        pub end_of_stroke_stopping_distance: f32,
        pub end_of_stroke_max_iterations: i32,
        pub predict: i32,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct IsmResult {
        pub x: f32,
        pub y: f32,
        pub vx: f32,
        pub vy: f32,
        pub ax: f32,
        pub ay: f32,
        pub time: f64,
        pub pressure: f32,
        pub tilt: f32,
        pub orientation: f32,
    }

    extern "C" {
        pub fn ism_new() -> *mut IsmModeler;
        pub fn ism_free(m: *mut IsmModeler);
        pub fn ism_reset(m: *mut IsmModeler, p: *const IsmParams) -> i32;
        #[allow(clippy::too_many_arguments)]
        pub fn ism_update(
            m: *mut IsmModeler,
            kind: i32,
            x: f32,
            y: f32,
            time: f64,
            pressure: f32,
            tilt: f32,
            orientation: f32,
        ) -> i32;
        pub fn ism_predict(m: *mut IsmModeler) -> i32;
        pub fn ism_result_count(m: *const IsmModeler) -> usize;
        pub fn ism_result(m: *const IsmModeler, i: usize, out: *mut IsmResult);
    }
}

/// The modeler's settings. [`Params::default`] holds the values Google's
/// own tests use, for positions in centimetres-like units; scale the speeds
/// and distances to the unit you use.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Params {
    /// Wobble smoother: how far back it averages, seconds.
    pub wobble_timeout: f64,
    /// Below this speed the wobble smoother is fully on (units per second).
    pub wobble_speed_floor: f64,
    /// Above this speed it is off.
    pub wobble_speed_ceiling: f64,
    /// Spring and mass model: how tightly the line follows the pen.
    pub spring_mass_constant: f32,
    /// Spring and mass model: how much it is damped.
    pub drag_constant: f32,
    /// Fewest output samples per second.
    pub min_output_rate: f64,
    /// At the end of a stroke, catching up stops this close to the pen.
    pub end_of_stroke_stopping_distance: f32,
    /// At the end of a stroke, at most this many catch-up steps.
    pub end_of_stroke_max_iterations: i32,
    /// Whether [`Modeler::predict`] is available.
    pub predict: bool,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            wobble_timeout: 0.04,
            wobble_speed_floor: 1.31,
            wobble_speed_ceiling: 1.44,
            spring_mass_constant: 11.0 / 32400.0,
            drag_constant: 72.0,
            min_output_rate: 180.0,
            end_of_stroke_stopping_distance: 0.001,
            end_of_stroke_max_iterations: 20,
            predict: true,
        }
    }
}

/// What the pen did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Down,
    Move,
    Up,
}

/// A raw pen sample. Pressure, tilt and orientation are -1 when unknown.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Input {
    pub x: f32,
    pub y: f32,
    /// Seconds.
    pub time: f64,
    pub pressure: f32,
    pub tilt: f32,
    pub orientation: f32,
}

/// A modelled point on the stroke.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Sample {
    pub x: f32,
    pub y: f32,
    pub vx: f32,
    pub vy: f32,
    pub ax: f32,
    pub ay: f32,
    /// Seconds.
    pub time: f64,
    pub pressure: f32,
    pub tilt: f32,
    pub orientation: f32,
}

/// The modeler refused something; `code` is an `absl::StatusCode` (3: an
/// argument is invalid, for example a time going backwards; 9: not ready,
/// for example a move before a down).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Error {
    pub code: i32,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let what = match self.code {
            3 => "invalid argument",
            9 => "failed precondition",
            _ => "error",
        };
        write!(f, "ink stroke modeler: {what} (code {})", self.code)
    }
}

impl std::error::Error for Error {}

fn check(code: i32) -> Result<(), Error> {
    if code == 0 {
        Ok(())
    } else {
        Err(Error { code })
    }
}

/// One stroke modeler. Each stroke starts with [`Event::Down`].
pub struct Modeler {
    ptr: NonNull<ffi::IsmModeler>,
}

impl Modeler {
    pub fn new(params: &Params) -> Result<Self, Error> {
        let ptr = NonNull::new(unsafe { ffi::ism_new() }).expect("allocation");
        let mut m = Modeler { ptr };
        m.reset(params)?;
        Ok(m)
    }

    /// New settings; also forgets the stroke in progress.
    pub fn reset(&mut self, params: &Params) -> Result<(), Error> {
        let p = ffi::IsmParams {
            wobble_timeout: params.wobble_timeout,
            wobble_speed_floor: params.wobble_speed_floor,
            wobble_speed_ceiling: params.wobble_speed_ceiling,
            spring_mass_constant: params.spring_mass_constant,
            drag_constant: params.drag_constant,
            min_output_rate: params.min_output_rate,
            end_of_stroke_stopping_distance: params.end_of_stroke_stopping_distance,
            end_of_stroke_max_iterations: params.end_of_stroke_max_iterations,
            predict: i32::from(params.predict),
        };
        check(unsafe { ffi::ism_reset(self.ptr.as_ptr(), &p) })
    }

    /// Feeds one raw sample and appends the modelled points it gives to `out`.
    pub fn update(&mut self, event: Event, input: Input, out: &mut Vec<Sample>) -> Result<(), Error> {
        let kind = match event {
            Event::Down => 0,
            Event::Move => 1,
            Event::Up => 2,
        };
        let i = input;
        check(unsafe {
            ffi::ism_update(self.ptr.as_ptr(), kind, i.x, i.y, i.time, i.pressure, i.tilt, i.orientation)
        })?;
        self.take(out);
        Ok(())
    }

    /// Where the stroke in progress is likely going, from the last modelled
    /// point to the pen and a little beyond. Appended to `out`.
    pub fn predict(&mut self, out: &mut Vec<Sample>) -> Result<(), Error> {
        check(unsafe { ffi::ism_predict(self.ptr.as_ptr()) })?;
        self.take(out);
        Ok(())
    }

    fn take(&self, out: &mut Vec<Sample>) {
        let n = unsafe { ffi::ism_result_count(self.ptr.as_ptr()) };
        out.reserve(n);
        for k in 0..n {
            let mut r = ffi::IsmResult::default();
            unsafe { ffi::ism_result(self.ptr.as_ptr(), k, &mut r) };
            out.push(Sample {
                x: r.x,
                y: r.y,
                vx: r.vx,
                vy: r.vy,
                ax: r.ax,
                ay: r.ay,
                time: r.time,
                pressure: r.pressure,
                tilt: r.tilt,
                orientation: r.orientation,
            });
        }
    }
}

impl Drop for Modeler {
    fn drop(&mut self) {
        unsafe { ffi::ism_free(self.ptr.as_ptr()) }
    }
}

/// The C library is built against WASI, but Bedrock's WebAssembly runs in a
/// browser page with no WASI host. These stand in for the WASI calls the C
/// library refers to; the modeler itself never makes them (no files, no
/// clock, no exit), and the C library's start-up finds no open directories.
#[cfg(target_arch = "wasm32")]
mod wasi_stubs {
    const EBADF: i32 = 8;
    const ENOSYS: i32 = 52;

    #[no_mangle]
    extern "C" fn __imported_wasi_snapshot_preview1_clock_time_get(_id: i32, _precision: i64, _time: i32) -> i32 {
        ENOSYS
    }
    #[no_mangle]
    extern "C" fn __imported_wasi_snapshot_preview1_fd_close(_fd: i32) -> i32 {
        EBADF
    }
    #[no_mangle]
    extern "C" fn __imported_wasi_snapshot_preview1_fd_prestat_get(_fd: i32, _buf: i32) -> i32 {
        EBADF
    }
    #[no_mangle]
    extern "C" fn __imported_wasi_snapshot_preview1_fd_prestat_dir_name(_fd: i32, _path: i32, _len: i32) -> i32 {
        EBADF
    }
    #[no_mangle]
    extern "C" fn __imported_wasi_snapshot_preview1_fd_seek(_fd: i32, _offset: i64, _whence: i32, _new: i32) -> i32 {
        EBADF
    }
    #[no_mangle]
    extern "C" fn __imported_wasi_snapshot_preview1_fd_write(_fd: i32, _iovs: i32, _len: i32, _written: i32) -> i32 {
        EBADF
    }
    #[no_mangle]
    extern "C" fn __imported_wasi_snapshot_preview1_poll_oneoff(_in: i32, _out: i32, _n: i32, _events: i32) -> i32 {
        ENOSYS
    }
    #[no_mangle]
    extern "C" fn __imported_wasi_snapshot_preview1_proc_exit(_code: i32) {
        core::arch::wasm32::unreachable()
    }
    #[no_mangle]
    extern "C" fn __imported_wasi_snapshot_preview1_sched_yield() -> i32 {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(x: f32, y: f32, time: f64) -> Input {
        Input { x, y, time, pressure: 0.5, tilt: -1.0, orientation: -1.0 }
    }

    #[test]
    fn a_stroke_is_modelled_from_down_to_up() {
        let mut m = Modeler::new(&Params::default()).unwrap();
        let mut out = Vec::new();
        let n = 30;
        for i in 0..=n {
            let event = match i {
                0 => Event::Down,
                i if i == n => Event::Up,
                _ => Event::Move,
            };
            let t = i as f64 / 120.0;
            m.update(event, input(i as f32 * 0.2, (t * 20.0).sin() as f32, t), &mut out).unwrap();
        }
        assert!(out.len() > n, "resampled at 180 Hz or more: {}", out.len());
        assert!(out.windows(2).all(|w| w[1].time >= w[0].time), "in time order");
        let last = out.last().unwrap();
        assert!((last.x - n as f32 * 0.2).abs() < 0.05, "ends at the pen: {last:?}");
        assert!(out.iter().all(|s| (s.pressure - 0.5).abs() < 1e-4), "pressure carried along");
    }

    #[test]
    fn shaky_slow_movement_is_smoothed() {
        // A slow line with sideways jitter: the model is straighter.
        let mut m = Modeler::new(&Params::default()).unwrap();
        let mut out = Vec::new();
        let n = 120;
        for i in 0..=n {
            let event = if i == 0 {
                Event::Down
            } else if i == n {
                Event::Up
            } else {
                Event::Move
            };
            let jitter = if i % 2 == 0 { 0.02 } else { -0.02 };
            m.update(event, input(i as f32 * 0.01, jitter, i as f64 / 120.0), &mut out).unwrap();
        }
        // The first point is the pen-down sample itself; after it, the line
        // stays well inside the jitter.
        let rest = &out[out.len() / 10..];
        let mean = rest.iter().map(|s| s.y.abs()).sum::<f32>() / rest.len() as f32;
        assert!(mean < 0.005, "jitter of 0.02 is smoothed to {mean} on average");
    }

    #[test]
    fn mistakes_are_refused_not_crashes() {
        let mut m = Modeler::new(&Params::default()).unwrap();
        let mut out = Vec::new();
        assert_eq!(m.update(Event::Move, input(0.0, 0.0, 0.0), &mut out), Err(Error { code: 9 }), "no down yet");
        m.update(Event::Down, input(0.0, 0.0, 1.0), &mut out).unwrap();
        assert!(m.update(Event::Move, input(1.0, 0.0, 0.5), &mut out).is_err(), "time going backwards");
        assert!(Modeler::new(&Params { drag_constant: -1.0, ..Params::default() }).is_err(), "bad settings");
    }

    #[test]
    fn prediction_runs_ahead_of_the_model() {
        let mut m = Modeler::new(&Params::default()).unwrap();
        let mut out = Vec::new();
        for i in 0..20 {
            let event = if i == 0 { Event::Down } else { Event::Move };
            m.update(event, input(i as f32 * 0.1, 0.0, i as f64 / 120.0), &mut out).unwrap();
        }
        let modelled = out.last().unwrap().x;
        let mut ahead = Vec::new();
        m.predict(&mut ahead).unwrap();
        assert!(ahead.last().is_some_and(|p| p.x > modelled), "{modelled} then {:?}", ahead.last());
    }
}
