// The window is only pointed at a kernel after its /health answers. The shell is a client here:
// it asks, it never listens.
use std::time::{Duration, Instant};

/// One probe. Returns the HTTP status, or why there was no answer at all.
pub fn probe(base: &str) -> Result<u16, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(3))
        .redirects(0)
        .build();
    match agent.get(&format!("{base}/health")).call() {
        Ok(r) => Ok(r.status()),
        Err(ureq::Error::Status(code, _)) => Ok(code),
        Err(e) => Err(e.to_string()),
    }
}

/// The bundled kernel must say 200. A remote kernel may be older or sit behind something that has no
/// /health, so there any answer that is not a server error counts as "up".
pub fn is_up(status: u16, remote: bool) -> bool {
    if remote {
        status < 500
    } else {
        status == 200
    }
}

/// Polls until the kernel is up. `abort` is asked between probes (the bundled kernel dying is a reason to stop
/// waiting); `limit` bounds the wait. The error says what the last probe saw.
pub fn wait_up(
    base: &str,
    remote: bool,
    limit: Duration,
    mut abort: impl FnMut() -> Option<String>,
) -> Result<(), String> {
    let until = Instant::now() + limit;
    loop {
        let last = match probe(base) {
            Ok(code) if is_up(code, remote) => return Ok(()),
            Ok(code) => format!("/health 回了 {code}"),
            Err(e) => e,
        };
        if let Some(why) = abort() {
            return Err(why);
        }
        if Instant::now() >= until {
            return Err(format!("{}秒内没探通：{last}", limit.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_needs_200_remote_only_needs_an_answer() {
        assert!(is_up(200, false));
        assert!(!is_up(404, false));
        assert!(!is_up(503, false));
        assert!(is_up(404, true));
        assert!(is_up(401, true));
        assert!(!is_up(502, true));
    }

    #[test]
    fn nothing_listening_is_an_error_not_up() {
        // port 9 (discard) on loopback: nothing listens in CI or on a desktop
        assert!(probe("http://127.0.0.1:9").is_err());
        let r = wait_up(
            "http://127.0.0.1:9",
            false,
            Duration::from_millis(300),
            || None,
        );
        assert!(r.is_err());
    }

    #[test]
    fn abort_stops_the_wait_early() {
        let r = wait_up("http://127.0.0.1:9", false, Duration::from_secs(30), || {
            Some("内核退出了".to_string())
        });
        assert_eq!(r, Err("内核退出了".to_string()));
    }
}
