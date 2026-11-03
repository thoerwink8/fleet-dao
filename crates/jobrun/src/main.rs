// jobrun: keep one command's whole process tree inside a Windows Job Object.
//
//   jobrun run   --name N --report FILE [--grace-ms MS] -- CMD ARGS...   run CMD under supervision
//   jobrun kill  --name N [--grace-ms MS]                                 stop the whole tree of a running job
//   jobrun list  --name N                                                 pids inside a running job
//   jobrun check --report FILE                                            recorded descendants still alive
//   jobrun reap  --report FILE                                            stop recorded descendants (pid + creation time must match)
//
// `run` inherits stdin/stdout/stderr, working directory and environment, so the caller talks to CMD
// directly. The supervisor's exit code is CMD's exit code; what happened to the rest of the tree is
// written to the report file. Exit 3 means "no such job", 4 "name already taken", 64 usage, 127 spawn failure.
#[cfg(windows)]
mod win;

#[cfg(windows)]
mod app;

#[cfg(windows)]
fn main() {
    std::process::exit(app::main());
}

#[cfg(not(windows))]
fn main() {
    eprintln!("jobrun only runs on Windows (Job Objects)");
    std::process::exit(64);
}
