// The tray menu as plain data first (so a test can read it), then turned into Tauri menu items.
use crate::config::Mode;

pub const ID_OPEN: &str = "open";
pub const ID_RESTART: &str = "restart";
pub const ID_MODE_LOCAL: &str = "mode-local";
pub const ID_MODE_REMOTE: &str = "mode-remote";
pub const ID_AUTOSTART: &str = "autostart";
pub const ID_CONFIG: &str = "config";
pub const ID_QUIT: &str = "quit";

#[derive(Debug, PartialEq, Eq)]
pub enum Kind {
    Plain,
    Check(bool),
    Separator,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: &'static str,
    pub label: String,
    pub kind: Kind,
    pub enabled: bool,
}

fn entry(id: &'static str, label: &str, kind: Kind, enabled: bool) -> Entry {
    Entry {
        id,
        label: label.to_string(),
        kind,
        enabled,
    }
}

/// `remote_url` is what the settings say, shown even when the local kernel is the current mode.
pub fn model(mode: &Mode, remote_url: Option<&str>, autostart: bool) -> Vec<Entry> {
    let local = matches!(mode, Mode::Local);
    let status = match mode {
        Mode::Local => "当前：本机内核".to_string(),
        Mode::Remote(url) => format!("当前：远端内核 {url}"),
    };
    let remote_label = match remote_url {
        Some(url) => format!("连远端内核（{url}）"),
        None => "连远端内核（先在设置文件里写地址）".to_string(),
    };
    vec![
        entry("status", &status, Kind::Plain, false),
        entry(ID_OPEN, "打开窗口", Kind::Plain, true),
        entry(
            ID_RESTART,
            if local {
                "重启内核"
            } else {
                "重新连接"
            },
            Kind::Plain,
            true,
        ),
        entry("sep-1", "", Kind::Separator, true),
        entry(ID_MODE_LOCAL, "用本机内核", Kind::Check(local), true),
        entry(
            ID_MODE_REMOTE,
            &remote_label,
            Kind::Check(!local),
            remote_url.is_some() || !local,
        ),
        entry(ID_AUTOSTART, "开机自启", Kind::Check(autostart), true),
        entry(ID_CONFIG, "打开设置文件夹", Kind::Plain, true),
        entry("sep-2", "", Kind::Separator, true),
        entry(ID_QUIT, "退出", Kind::Plain, true),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(m: &[Entry]) -> Vec<&'static str> {
        m.iter().map(|e| e.id).collect()
    }

    #[test]
    fn tray_has_open_restart_modes_autostart_and_quit() {
        let m = model(&Mode::Local, None, false);
        let got = ids(&m);
        for id in [
            ID_OPEN,
            ID_RESTART,
            ID_MODE_LOCAL,
            ID_MODE_REMOTE,
            ID_AUTOSTART,
            ID_QUIT,
        ] {
            assert!(got.contains(&id), "{id} missing from {got:?}");
        }
        assert_eq!(got.last(), Some(&ID_QUIT));
    }

    #[test]
    fn autostart_item_shows_the_real_state() {
        let on = model(&Mode::Local, None, true);
        let off = model(&Mode::Local, None, false);
        let kind = |m: &[Entry]| {
            m.iter()
                .find(|e| e.id == ID_AUTOSTART)
                .map(|e| match e.kind {
                    Kind::Check(b) => Some(b),
                    _ => None,
                })
        };
        assert_eq!(kind(&on), Some(Some(true)));
        assert_eq!(kind(&off), Some(Some(false)));
    }

    #[test]
    fn remote_choice_needs_an_address_unless_already_remote() {
        let enabled = |m: &[Entry]| m.iter().find(|e| e.id == ID_MODE_REMOTE).unwrap().enabled;
        assert!(!enabled(&model(&Mode::Local, None, false)));
        assert!(enabled(&model(&Mode::Local, Some("http://a:1"), false)));
        assert!(enabled(&model(
            &Mode::Remote("http://a:1".into()),
            None,
            false
        )));
    }

    #[test]
    fn labels_follow_the_mode() {
        let l = model(&Mode::Local, None, false);
        assert_eq!(
            l.iter().find(|e| e.id == ID_RESTART).unwrap().label,
            "重启内核"
        );
        let r = model(&Mode::Remote("http://a:1".into()), None, false);
        assert_eq!(
            r.iter().find(|e| e.id == ID_RESTART).unwrap().label,
            "重新连接"
        );
        assert!(r[0].label.contains("http://a:1"));
    }
}
