// jobrun as a library: the Windows Job Object wrappers (`win`) and the command-line front end (`app`).
// The `jobrun` binary is a thin main over `app`; the desktop shell links `win` to keep its own sidecar
// (the kernel) in a kill-on-close job without going through a second supervisor process.
// `hostd` reuses both (it re-executes itself as `hostd jobrun ...` so one static file does both jobs).
#[cfg(windows)]
pub mod app;
#[cfg(windows)]
pub mod win;
