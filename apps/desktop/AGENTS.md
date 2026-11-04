# apps/desktop：桌面外壳（Tauri 2，#3870，决定 0125 第 8 条）

Windows 桌面软件的外壳：起内核、开窗口、托盘。**不含业务代码**；业务全在内核（`packages/harness-*`）和页面（`harness-web` 的本机版）里，外壳可以和 Electron 互换。

## 外壳做的四件事

1. 本机模式：把 `node.exe kernel.mjs` 当附带进程，放进 `KILL_ON_JOB_CLOSE` 的 Job（`src-tauri/src/kernel.rs`，用 `crates/jobrun` 当库）。外壳独占 Job 句柄，所以外壳怎么死（退出、崩、被强杀）内核都跟着没。环境变量交接：`FLEET2_PROFILE=local`、`FLEET2_WEB_DIST`、`FLEET2_UI_PORT`（先试 7347，被占才换口）、`FLEET_JOBRUN`（内核起工人时收进程树用）。内核从 stdout 报「已起 + 一次性登录地址」，外壳读到再探 `/health`（`health.rs`），通了才把窗口导航到登录地址（一次性登录码换 cookie，再跳首页）。
2. 远端模式：不起内核，只探地址再开窗口。地址优先级：`--remote <url>`、环境变量 `FLEET2_REMOTE_URL`、设置文件 `%APPDATA%\com.fleet2.desktop\shell.json` 的 `remoteUrl`（`mode` 为 `remote`）；写了但不合法是报错，不悄悄换成本机内核（`config.rs`）。
3. 托盘（`tray.rs`，菜单先是纯数据好测）、单实例（第二份自己退出、叫醒第一份）、开机自启（`tauri-plugin-autostart`，自启起的带 `--autostart`，窗口先藏着）。关窗口是藏到托盘，托盘「退出」才退。
4. 窗口里的启动页（`ui/index.html`）只显示状态；外壳靠网址的 `#status:`/`#error:` 片段告诉它，页面不调外壳。

## 不许有的东西（`pnpm check` 里的 `packages/conventions/test/desktop-shell.test.ts` 守着）

没有 Tauri 命令（`#[tauri::command]`、`invoke_handler`）、没有自定义协议、没有监听口、不依赖 HTTP 服务端的库、`src-tauri/capabilities/` 保持空（页面连插件命令也调不了）、`withGlobalTauri` 不开、启动页不发请求。要加这些先改决定，不是改检查。

## 构建和验证

- `node apps/desktop/scripts/stage.ts`：备 `build/`（页面、打包内核加 `node.exe`、迁移目录、`jobrun.exe`），再 `cd apps/desktop && pnpm exec tauri build --bundles nsis` 出安装包（不签名；签名要掏钱，先问创始人）。`src-tauri` 是独立的 cargo workspace（仓根的 `cargo` 不编译它）。
- `node apps/desktop/e2e/run.ts --app <装好的 fleet-desktop.exe> --tauri-driver <exe> --edge-driver <msedgedriver.exe>`：托盘和自启（`--selftest`）、真开窗口、五块导航、页面调不了外壳命令、1440 和 390 截图、单实例、强杀外壳后内核 2 秒内不在。msedgedriver 版本要和 WebView2 运行时一致。CI 的 `desktop` 台（不挡合并）整套跑。
- Windows 上本机跑 cargo 要 MSVC 的 `link.exe` 排在 Git 的前面。
- 安装包体积和闲置内存的实测在 `specs/3851-harness-shape/讨论稿.md` 6.4a。
