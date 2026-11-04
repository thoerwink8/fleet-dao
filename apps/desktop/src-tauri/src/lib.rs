// Desktop shell (Tauri 2). It does four things and nothing else:
//   1. starts the bundled kernel as a sidecar inside a kill-on-close Job (or, in remote mode, starts nothing),
//   2. waits for the kernel's /health, then points the window at its address,
//   3. keeps a tray icon, a single instance and the start-at-login switch,
//   4. kills the kernel when it exits, however it exits.
// There is no business code here, no HTTP route and no command the page can call (src-tauri/capabilities
// stays empty; `pnpm check` asserts it).
mod config;
mod health;
mod kernel;
mod tray;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use config::{Inputs, Mode, Settings};
use kernel::Kernel;

const MAIN: &str = "main";
/// Where the bundled start page (ui/index.html) lives: Tauri 2 serves it from this origin on Windows
/// (the window's own url() is still about:blank while setup runs, so it cannot be read from there).
#[cfg(windows)]
const SPLASH_URL: &str = "http://tauri.localhost/index.html";
#[cfg(not(windows))]
const SPLASH_URL: &str = "tauri://localhost/index.html";
const START_LIMIT: Duration = Duration::from_secs(60);
const HEALTH_LIMIT: Duration = Duration::from_secs(30);

struct Shell {
    mode: Mutex<Mode>,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    kernel: Mutex<Option<Kernel>>,
    /// Bumped on every (re)connect; a connect attempt that sees it change gives up quietly.
    generation: AtomicU64,
    splash: Mutex<Option<Url>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

fn show_main(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Shows a line on the bundled start page. The text rides in the URL fragment, so the page needs no
/// way to talk to the shell: `#status:<text>` or `#error:<text>`.
fn splash(app: &AppHandle, kind: &str, text: &str) {
    let shell = app.state::<Shell>();
    let (Some(win), Some(mut url)) = (main_window(app), lock(&shell.splash).clone()) else {
        return;
    };
    url.set_fragment(Some(&format!("{kind}:{text}")));
    let _ = win.navigate(url);
}

fn read_settings(path: &PathBuf) -> Result<Settings, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => config::parse_settings(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(format!("读不了设置文件 {}：{e}", path.display())),
    }
}

fn write_settings(path: &PathBuf, s: &Settings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("写不了设置文件 {}：{e}", path.display()))
}

fn resolve_mode(settings: &Settings) -> Result<Mode, String> {
    let args: Vec<String> = std::env::args().collect();
    let env = std::env::var("FLEET2_REMOTE_URL").ok();
    config::resolve_mode(&Inputs {
        args: &args,
        env_remote: env.as_deref(),
        settings,
    })
}

fn stop_kernel(app: &AppHandle) {
    let taken = lock(&app.state::<Shell>().kernel).take();
    if let Some(k) = taken {
        k.stop();
    }
}

/// (Re)connects the window: starts the kernel (local) or just probes (remote), waits for /health, navigates.
fn connect(app: &AppHandle) {
    let app = app.clone();
    let gen = app
        .state::<Shell>()
        .generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    std::thread::spawn(move || {
        let shell = app.state::<Shell>();
        let current = || shell.generation.load(Ordering::SeqCst) == gen;
        stop_kernel(&app);
        let mode = lock(&shell.mode).clone();
        let target = match &mode {
            Mode::Local => {
                splash(&app, "status", "正在启动内核…");
                let resources = match app.path().resource_dir() {
                    Ok(p) => kernel::plain_path(&p),
                    Err(e) => return splash(&app, "error", &format!("找不到安装目录：{e}")),
                };
                let layout = kernel::layout(&resources);
                let started = Kernel::start(&layout, START_LIMIT, &gen.to_string());
                let (k, ready) = match started {
                    Ok(v) => v,
                    Err(e) => return splash(&app, "error", &e),
                };
                if !current() {
                    return k.stop();
                }
                *lock(&shell.kernel) = Some(k);
                splash(&app, "status", "正在等内核就绪…");
                let waited = health::wait_up(&ready.base, false, HEALTH_LIMIT, || {
                    if !current() {
                        return Some("已被新的连接取代".to_string());
                    }
                    let mut guard = lock(&shell.kernel);
                    match guard.as_mut() {
                        Some(k) => k
                            .exit_tail()
                            .map(|t| format!("内核退出了。最后的输出：\n{t}")),
                        None => Some("内核已被停掉".to_string()),
                    }
                });
                if let Err(e) = waited {
                    if current() {
                        stop_kernel(&app);
                        splash(&app, "error", &e);
                    }
                    return;
                }
                watch_kernel(&app, gen);
                ready.login.unwrap_or(ready.base)
            }
            Mode::Remote(url) => {
                splash(&app, "status", &format!("正在连接 {url}…"));
                let waited = health::wait_up(url, true, HEALTH_LIMIT, || {
                    (!current()).then(|| "已被新的连接取代".to_string())
                });
                if let Err(e) = waited {
                    if current() {
                        splash(&app, "error", &format!("连不上 {url}：{e}"));
                    }
                    return;
                }
                url.clone()
            }
        };
        if !current() {
            return;
        }
        match (main_window(&app), Url::parse(&target)) {
            (Some(w), Ok(u)) => {
                let _ = w.navigate(u);
            }
            (_, Err(e)) => splash(&app, "error", &format!("地址不对：{e}")),
            _ => {}
        }
    });
}

/// After the page is up: if the bundled kernel dies on its own, say so instead of leaving a dead page.
fn watch_kernel(app: &AppHandle, gen: u64) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let shell = app.state::<Shell>();
        if shell.generation.load(Ordering::SeqCst) != gen {
            return;
        }
        let tail = {
            let mut guard = lock(&shell.kernel);
            match guard.as_mut() {
                Some(k) => k.exit_tail(),
                None => return,
            }
        };
        if let Some(tail) = tail {
            stop_kernel(&app);
            splash(
                &app,
                "error",
                &format!("内核意外退出，可在托盘里选“重启内核”。最后的输出：\n{tail}"),
            );
            return;
        }
    });
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let shell = app.state::<Shell>();
    let mode = lock(&shell.mode).clone();
    let remote_url = lock(&shell.settings).remote_url.clone();
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    let menu = Menu::new(app)?;
    for e in tray::model(&mode, remote_url.as_deref(), autostart) {
        match e.kind {
            tray::Kind::Plain => menu.append(&MenuItem::with_id(
                app,
                e.id,
                &e.label,
                e.enabled,
                None::<&str>,
            )?)?,
            tray::Kind::Check(on) => menu.append(&CheckMenuItem::with_id(
                app,
                e.id,
                &e.label,
                e.enabled,
                on,
                None::<&str>,
            )?)?,
            tray::Kind::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    Ok(menu)
}

fn refresh_tray(app: &AppHandle) {
    if let (Some(t), Ok(m)) = (app.tray_by_id(MAIN), build_menu(app)) {
        let _ = t.set_menu(Some(m));
    }
}

fn open_settings_folder(app: &AppHandle) {
    let shell = app.state::<Shell>();
    if let Some(dir) = shell.settings_path.parent() {
        let _ = std::fs::create_dir_all(dir);
        #[cfg(windows)]
        let _ = std::process::Command::new("explorer").arg(dir).spawn();
    }
}

fn switch_mode(app: &AppHandle, remote: bool) {
    let shell = app.state::<Shell>();
    let mut settings = lock(&shell.settings).clone();
    settings.mode = Some(if remote { "remote" } else { "local" }.to_string());
    if let Err(e) = write_settings(&shell.settings_path, &settings) {
        return splash(app, "error", &e);
    }
    // an address given on the command line or in the environment keeps winning over the file
    match resolve_mode(&settings) {
        Ok(mode) => {
            *lock(&shell.settings) = settings;
            *lock(&shell.mode) = mode;
            refresh_tray(app);
            connect(app);
        }
        Err(e) => splash(app, "error", &e),
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        tray::ID_OPEN => show_main(app),
        tray::ID_RESTART => {
            show_main(app);
            connect(app);
        }
        tray::ID_MODE_LOCAL => switch_mode(app, false),
        tray::ID_MODE_REMOTE => switch_mode(app, true),
        tray::ID_AUTOSTART => {
            let launch = app.autolaunch();
            let _ = if launch.is_enabled().unwrap_or(false) {
                launch.disable()
            } else {
                launch.enable()
            };
            refresh_tray(app);
        }
        tray::ID_CONFIG => open_settings_folder(app),
        tray::ID_QUIT => app.exit(0),
        _ => {}
    }
}

/// `--selftest <file>`: build the tray, flip the start-at-login switch on and off (restoring it), write what
/// was observed to <file> as JSON and exit. This is how CI checks the tray and autostart without a human.
fn selftest(app: &AppHandle, out: &str) -> i32 {
    let launch = app.autolaunch();
    let before = launch.is_enabled().unwrap_or(false);
    let enabled = launch.enable().is_ok() && launch.is_enabled().unwrap_or(false);
    let disabled = launch.disable().is_ok() && !launch.is_enabled().unwrap_or(true);
    if before {
        let _ = launch.enable();
    }
    let tray_up = app.tray_by_id(MAIN).is_some();
    let window = main_window(app).is_some();
    let ok = tray_up && enabled && disabled && window;
    let report = serde_json::json!({
        "ok": ok, "tray": tray_up, "autostartEnable": enabled, "autostartDisable": disabled,
        "autostartRestored": launch.is_enabled().unwrap_or(false) == before, "window": window,
    });
    let _ = std::fs::write(out, report.to_string());
    if ok {
        0
    } else {
        1
    }
}

/// A GUI program has no console, so a panic or a failed start would vanish without a trace. Both are written to
/// fleet2-shell.log in the temp folder (the end-to-end run prints it when the window does not come up).
fn log_to_temp(line: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("fleet2-shell.log"))
    {
        let _ = writeln!(f, "{line}");
    }
}

pub fn run() {
    std::panic::set_hook(Box::new(|info| log_to_temp(&format!("panic: {info}"))));
    let app = tauri::Builder::default()
        // must be first: a second launch asks the first to show its window, then exits on its own
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .setup(|app| {
            let handle = app.handle().clone();
            let config_dir = app.path().app_config_dir()?;
            let settings_path = config_dir.join("shell.json");
            let (settings, settings_err) = match read_settings(&settings_path) {
                Ok(s) => (s, None),
                Err(e) => (Settings::default(), Some(e)),
            };
            let (mode, mode_err) = match resolve_mode(&settings) {
                Ok(m) => (m, None),
                Err(e) => (Mode::Local, Some(e)),
            };
            app.manage(Shell {
                mode: Mutex::new(mode),
                settings: Mutex::new(settings),
                settings_path,
                kernel: Mutex::new(None),
                generation: AtomicU64::new(0),
                splash: Mutex::new(Url::parse(SPLASH_URL).ok()),
            });

            TrayIconBuilder::with_id(MAIN)
                .icon(app.default_window_icon().cloned().ok_or("没有窗口图标")?)
                .tooltip("Fleet2")
                .menu(&build_menu(&handle)?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| on_menu(app, ev.id().as_ref()))
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = ev
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            let args: Vec<String> = std::env::args().collect();
            if let Some(i) = args.iter().position(|a| a == "--selftest") {
                let out = args.get(i + 1).cloned().unwrap_or_default();
                let code = selftest(&handle, &out);
                std::process::exit(code);
            }
            if args.iter().any(|a| a == "--autostart") {
                if let Some(w) = main_window(&handle) {
                    let _ = w.hide();
                }
            }
            match settings_err.or(mode_err) {
                Some(e) => splash(&handle, "error", &e),
                None => connect(&handle),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // the close button hides to the tray; "退出" in the tray is the way out
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            log_to_temp(&format!("build failed: {e}"));
            std::process::exit(1);
        });

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            stop_kernel(app);
        }
    });
}
