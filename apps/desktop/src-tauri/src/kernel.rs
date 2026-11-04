// The bundled kernel: `node.exe kernel.mjs`, started as a sidecar of the shell inside a Windows Job Object
// created with KILL_ON_JOB_CLOSE. The shell owns the only handle to the job, so when the shell exits or is
// killed in any way, Windows closes the handle and takes the kernel (and anything it spawned) down with it.
//
// The kernel is told what to do only through environment variables (FLEET2_PROFILE=local, FLEET2_WEB_DIST,
// FLEET2_UI_PORT); it tells the shell where it listens and how to log in through its stdout, which is the
// same output a person sees when running `pnpm fleet2 up`. No file or socket is shared with the page.
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Port tried first so the page keeps the same origin between launches; if it is taken, any free port.
pub const PREFERRED_PORT: u16 = 7347;
const LOG_LINES: usize = 40;

/// Where the pieces of the bundled kernel live under the install (resource) directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub node: PathBuf,
    pub kernel: PathBuf,
    pub web: PathBuf,
    pub jobrun: PathBuf,
}

pub fn layout(resources: &Path) -> Layout {
    Layout {
        node: resources.join("kernel").join("node.exe"),
        kernel: resources.join("kernel").join("kernel.mjs"),
        web: resources.join("web"),
        jobrun: resources.join("jobrun.exe"),
    }
}

impl Layout {
    /// The first missing piece, as a sentence for the person looking at the window.
    pub fn missing(&self) -> Option<String> {
        for (what, p) in [
            ("node.exe", &self.node),
            ("kernel.mjs", &self.kernel),
            ("页面目录", &self.web),
        ] {
            if !p.exists() {
                return Some(format!("安装目录里缺 {what}：{}", p.display()));
            }
        }
        None
    }
}

/// Windows hands out resource paths as `\\?\C:\...`; node and the kernel are happier with the plain form.
pub fn plain_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p.to_path_buf(),
    }
}

/// What one line of kernel output means to the shell.
#[derive(Debug, PartialEq, Eq)]
pub enum Line {
    /// The one-time login address (it carries a short-lived code, never the token itself).
    Login(String),
    /// `{"started":true,...,"ui":"http://127.0.0.1:PORT/"}`: the server is listening.
    Started(String),
    Other,
}

pub fn classify(line: &str) -> Line {
    if let Some(at) = line.find("/local-login?code=") {
        if let Some(start) = line[..at].rfind("http") {
            let tail = &line[start..];
            let end = tail.find(char::is_whitespace).unwrap_or(tail.len());
            return Line::Login(tail[..end].to_string());
        }
    }
    if line.trim_start().starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if v["started"] == true {
                if let Some(ui) = v["ui"].as_str() {
                    return Line::Started(ui.trim_end_matches('/').to_string());
                }
            }
        }
    }
    Line::Other
}

/// The line as it may be shown or kept: the login code is a credential for five minutes, so it is blanked.
pub fn redact(line: &str) -> String {
    match line.find("code=") {
        Some(i) => {
            let rest = &line[i + 5..];
            let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
            format!("{}code=***{}", &line[..i], &rest[end..])
        }
        None => line.to_string(),
    }
}

#[derive(Default)]
struct Shared {
    login: Option<String>,
    base: Option<String>,
    log: VecDeque<String>,
}

pub struct Kernel {
    // Field order matters: the job is closed (and the tree killed) when the Kernel is dropped.
    #[cfg(windows)]
    job: jobrun::win::Job,
    child: Child,
    shared: Arc<Mutex<Shared>>,
}

/// What a started kernel offers once it is listening.
pub struct Ready {
    pub base: String,
    pub login: Option<String>,
}

impl Kernel {
    #[cfg(windows)]
    fn spawn(layout: &Layout, port: u16, tag: &str) -> Result<Kernel, String> {
        let job = jobrun::win::Job::create(&format!("fleet-shell-{}-{tag}", std::process::id()))
            .map_err(|e| format!("建不了进程组（Job）：{e}"))?;
        let mut cmd = Command::new(&layout.node);
        cmd.arg(&layout.kernel)
            .current_dir(layout.kernel.parent().unwrap_or(Path::new(".")))
            .env("FLEET2_PROFILE", "local")
            .env("FLEET2_WEB_DIST", &layout.web)
            .env("FLEET2_UI_PORT", port.to_string())
            // 内核起工人时用它收整棵进程树（harness-runner 的 jobrun 实现）
            .env("FLEET_JOBRUN", &layout.jobrun)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = jobrun::win::spawn_in_job(&job, &mut cmd)
            .map_err(|e| format!("起不来 {}：{e}", layout.node.display()))?;
        let shared = Arc::new(Mutex::new(Shared::default()));
        if let Some(out) = child.stdout.take() {
            pump(out, shared.clone());
        }
        if let Some(err) = child.stderr.take() {
            pump(err, shared.clone());
        }
        Ok(Kernel { job, child, shared })
    }

    #[cfg(not(windows))]
    fn spawn(_layout: &Layout, _port: u16, _tag: &str) -> Result<Kernel, String> {
        Err("内核随包只支持 Windows".to_string())
    }

    /// Starts the kernel and waits until it reports that it is listening (or dies, or `limit` runs out).
    /// Tries the preferred port first and falls back to a free one only if the kernel dies right away.
    pub fn start(layout: &Layout, limit: Duration, tag: &str) -> Result<(Kernel, Ready), String> {
        if let Some(why) = layout.missing() {
            return Err(why);
        }
        let mut first = Kernel::spawn(layout, PREFERRED_PORT, tag)?;
        match first.wait_started(limit) {
            Ok(r) => Ok((first, r)),
            Err(WaitError::Exited) => {
                let mut second = Kernel::spawn(layout, 0, &format!("{tag}b"))?;
                match second.wait_started(limit) {
                    Ok(r) => Ok((second, r)),
                    Err(e) => Err(second.explain(e)),
                }
            }
            Err(e) => Err(first.explain(e)),
        }
    }

    fn wait_started(&mut self, limit: Duration) -> Result<Ready, WaitError> {
        let until = Instant::now() + limit;
        loop {
            {
                let s = self.shared.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(base) = &s.base {
                    return Ok(Ready {
                        base: base.clone(),
                        login: s.login.clone(),
                    });
                }
            }
            if self.has_exited() {
                return Err(WaitError::Exited);
            }
            if Instant::now() >= until {
                return Err(WaitError::TimedOut);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn explain(&self, e: WaitError) -> String {
        let tail = self.log_tail();
        let head = match e {
            WaitError::Exited => "内核启动后马上退出了",
            WaitError::TimedOut => "内核没在限定时间内起来",
        };
        if tail.is_empty() {
            head.to_string()
        } else {
            format!("{head}。最后的输出：\n{tail}")
        }
    }

    pub fn has_exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    /// `Some(last output)` once the kernel has exited.
    pub fn exit_tail(&mut self) -> Option<String> {
        self.has_exited().then(|| self.log_tail())
    }

    pub fn log_tail(&self) -> String {
        let s = self.shared.lock().unwrap_or_else(|p| p.into_inner());
        s.log.iter().cloned().collect::<Vec<_>>().join("\n")
    }

    /// Stops the whole tree now and waits for the root to be gone.
    pub fn stop(mut self) {
        #[cfg(windows)]
        let _ = self.job.terminate();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Debug)]
enum WaitError {
    Exited,
    TimedOut,
}

fn pump(stream: impl std::io::Read + Send + 'static, shared: Arc<Mutex<Shared>>) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            let mut s = shared.lock().unwrap_or_else(|p| p.into_inner());
            match classify(&line) {
                Line::Login(url) => s.login = Some(url),
                Line::Started(base) => s.base = Some(base),
                Line::Other => {}
            }
            if s.log.len() == LOG_LINES {
                s.log.pop_front();
            }
            s.log.push_back(redact(&line));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_line_is_recognised_and_redacted() {
        let line = "登录（一次性，5 分钟内有效）：http://127.0.0.1:7347/local-login?code=AbC_123-x";
        assert_eq!(
            classify(line),
            Line::Login("http://127.0.0.1:7347/local-login?code=AbC_123-x".into())
        );
        let shown = redact(line);
        assert!(!shown.contains("AbC_123"), "{shown}");
        assert!(shown.ends_with("code=***"));
    }

    #[test]
    fn started_line_gives_the_base_address() {
        let line = r#"{"started":true,"apiPort":0,"profile":"local","ui":"http://127.0.0.1:50123/","dataDir":"x"}"#;
        assert_eq!(
            classify(line),
            Line::Started("http://127.0.0.1:50123".into())
        );
        assert_eq!(classify(r#"{"started":false}"#), Line::Other);
        assert_eq!(classify("fleet2 已起：http://127.0.0.1:1/"), Line::Other);
    }

    #[test]
    fn resource_paths_lose_the_verbatim_prefix() {
        assert_eq!(
            plain_path(Path::new(r"\\?\C:\Apps\Fleet2")),
            PathBuf::from(r"C:\Apps\Fleet2")
        );
        assert_eq!(plain_path(Path::new(r"C:\Apps")), PathBuf::from(r"C:\Apps"));
        assert_eq!(
            plain_path(Path::new(r"\\?\UNC\srv\share")),
            PathBuf::from(r"\\?\UNC\srv\share")
        );
    }

    #[test]
    fn a_missing_piece_is_named() {
        let l = layout(Path::new(r"C:\no\such\place"));
        assert!(l.missing().unwrap().contains("node.exe"));
    }
}
