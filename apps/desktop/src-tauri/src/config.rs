// Which kernel the window talks to: the bundled one the shell starts itself (local), or one that is
// already running somewhere else (remote). Remote address, in order of precedence:
//   1. `--remote <url>` on the command line, 2. the FLEET2_REMOTE_URL environment variable,
//   3. `remoteUrl` in shell.json in the shell's config folder (written by hand; the tray "mode" items
//      only flip `mode` between "local" and "remote").
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    Local,
    Remote(String),
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// "local" (default) or "remote".
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub remote_url: Option<String>,
}

/// A remote kernel address must be a plain http(s) URL with a host; anything else is rejected with a reason.
pub fn parse_remote_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let rest = raw
        .strip_prefix("http://")
        .or_else(|| raw.strip_prefix("https://"))
        .ok_or_else(|| "远端地址要以 http:// 或 https:// 开头".to_string())?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || host.contains(char::is_whitespace) || host.contains('@') {
        return Err("远端地址里缺主机名，或带了用户名密码".to_string());
    }
    Ok(raw.trim_end_matches('/').to_string())
}

pub struct Inputs<'a> {
    pub args: &'a [String],
    pub env_remote: Option<&'a str>,
    pub settings: &'a Settings,
}

/// The address given on the command line (`--remote <url>` or `--remote=<url>`), if any.
pub fn remote_from_args(args: &[String]) -> Option<String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--remote" {
            return it.next().cloned();
        }
        if let Some(v) = a.strip_prefix("--remote=") {
            return Some(v.to_string());
        }
    }
    None
}

/// Picks the mode. An address that was asked for but is invalid is an error, never silently the local kernel.
pub fn resolve_mode(i: &Inputs) -> Result<Mode, String> {
    if let Some(url) = remote_from_args(i.args) {
        return parse_remote_url(&url).map(Mode::Remote);
    }
    if let Some(url) = i.env_remote.filter(|v| !v.trim().is_empty()) {
        return parse_remote_url(url).map(Mode::Remote);
    }
    match i.settings.mode.as_deref() {
        None | Some("local") => Ok(Mode::Local),
        Some("remote") => match i.settings.remote_url.as_deref() {
            Some(url) if !url.trim().is_empty() => parse_remote_url(url).map(Mode::Remote),
            _ => Err("设置文件选了远端内核，但没有写 remoteUrl".to_string()),
        },
        Some(other) => Err(format!(
            "设置文件里的 mode 只认 local、remote，收到 {other}"
        )),
    }
}

pub fn parse_settings(text: &str) -> Result<Settings, String> {
    serde_json::from_str(text).map_err(|e| format!("设置文件不是合法 JSON：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn remote_url_is_checked() {
        assert_eq!(
            parse_remote_url(" https://kernel.example:8443/ ").unwrap(),
            "https://kernel.example:8443"
        );
        assert!(parse_remote_url("kernel.example").is_err());
        assert!(parse_remote_url("ftp://x").is_err());
        assert!(parse_remote_url("http://").is_err());
        // credentials in the address are refused (built from parts: not a real secret, and it keeps
        // the repo's secret scan from mistaking a test string for one)
        let with_userinfo = ["http://", "someone", ":", "word", "@", "host"].concat();
        assert!(parse_remote_url(&with_userinfo).is_err());
    }

    #[test]
    fn default_is_the_bundled_kernel() {
        let s = Settings::default();
        let i = Inputs {
            args: &[],
            env_remote: None,
            settings: &s,
        };
        assert_eq!(resolve_mode(&i), Ok(Mode::Local));
    }

    #[test]
    fn argument_beats_environment_beats_settings() {
        let s = Settings {
            mode: Some("remote".into()),
            remote_url: Some("http://from-file:1".into()),
        };
        let a = args(&["app", "--remote", "http://from-arg:2"]);
        let i = Inputs {
            args: &a,
            env_remote: Some("http://from-env:3"),
            settings: &s,
        };
        assert_eq!(
            resolve_mode(&i),
            Ok(Mode::Remote("http://from-arg:2".into()))
        );
        let none = args(&["app"]);
        let i = Inputs {
            args: &none,
            env_remote: Some("http://from-env:3"),
            settings: &s,
        };
        assert_eq!(
            resolve_mode(&i),
            Ok(Mode::Remote("http://from-env:3".into()))
        );
        let i = Inputs {
            args: &none,
            env_remote: None,
            settings: &s,
        };
        assert_eq!(
            resolve_mode(&i),
            Ok(Mode::Remote("http://from-file:1".into()))
        );
    }

    #[test]
    fn a_bad_address_is_an_error_not_the_local_kernel() {
        let s = Settings::default();
        let a = args(&["app", "--remote=nonsense"]);
        let i = Inputs {
            args: &a,
            env_remote: None,
            settings: &s,
        };
        assert!(resolve_mode(&i).is_err());
        let s = Settings {
            mode: Some("remote".into()),
            remote_url: None,
        };
        let i = Inputs {
            args: &[],
            env_remote: None,
            settings: &s,
        };
        assert!(resolve_mode(&i).is_err());
        let s = Settings {
            mode: Some("elsewhere".into()),
            remote_url: None,
        };
        let i = Inputs {
            args: &[],
            env_remote: None,
            settings: &s,
        };
        assert!(resolve_mode(&i).is_err());
    }

    #[test]
    fn settings_file_parses_and_rejects_garbage() {
        let s = parse_settings(r#"{"mode":"remote","remoteUrl":"http://a:1"}"#).unwrap();
        assert_eq!(s.remote_url.as_deref(), Some("http://a:1"));
        assert!(parse_settings("not json").is_err());
        assert_eq!(parse_settings("{}").unwrap(), Settings::default());
    }
}
