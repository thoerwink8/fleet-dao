// jobrun as a library: the `jobrun` binary is a thin wrapper, and `hostd` reuses the same Job Object code
// (it re-executes itself as `hostd jobrun ...` so one static file does both jobs).
#![cfg_attr(not(windows), allow(unused))]

#[cfg(windows)]
pub mod app;
#[cfg(windows)]
pub mod win;
