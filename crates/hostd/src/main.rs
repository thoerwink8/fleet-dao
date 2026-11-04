// hostd: the host helper. One static program, the same locally and on an SSH remote (no node needed there).
//
//   hostd --stdio [--state-dir DIR]   serve the frame protocol on stdin/stdout (one JSON object per line)
//   hostd --version                   print the version and the protocol it speaks
//
// Workers are started detached from this process, write their output to files under the state directory, and
// keep running when the connection or this process ends; a later connection attaches again by run id and line
// number. `supervise` (Unix) and `jobrun` (Windows) are internal: how it re-executes itself to keep a worker.
use std::io::{BufReader, Write};
use std::path::PathBuf;
use std::sync::Arc;

use hostd::frames::PROTOCOL_VERSION;
use hostd::server::serve;
use hostd::store::{default_state_dir, Store};

fn usage(msg: &str) -> i32 {
    eprintln!("hostd: {msg}");
    eprintln!("usage: hostd --stdio [--state-dir DIR] | --version");
    64
}

fn run() -> i32 {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(unix)]
    if argv.first().map(String::as_str) == Some("supervise") {
        return hostd::platform::supervise(&argv[1..]);
    }
    #[cfg(windows)]
    if argv.first().map(String::as_str) == Some("jobrun") {
        return jobrun::app::main_with(argv[1..].to_vec());
    }
    let mut stdio = false;
    let mut state_dir: Option<PathBuf> = None;
    let mut it = argv.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--stdio" => stdio = true,
            "--state-dir" => match it.next() {
                Some(dir) => state_dir = Some(PathBuf::from(dir)),
                None => return usage("--state-dir needs a value"),
            },
            "--version" => {
                println!(
                    "hostd {} protocol {PROTOCOL_VERSION}",
                    env!("CARGO_PKG_VERSION")
                );
                return 0;
            }
            other => return usage(&format!("unknown argument {other}")),
        }
    }
    if !stdio {
        return usage("nothing to do");
    }
    let root = state_dir.unwrap_or_else(default_state_dir);
    let store = match Store::open(&root) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("hostd: cannot use state directory {}: {e}", root.display());
            return 2;
        }
    };
    let stdout: Box<dyn Write + Send> = Box::new(std::io::stdout());
    serve(store, BufReader::new(std::io::stdin()), stdout)
}

fn main() {
    std::process::exit(run());
}
