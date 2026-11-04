// 桌面外壳（apps/desktop，Tauri 2，#3870，决定 0125 第 8 条）不含业务代码、不开 HTTP 路由、不给页面开调外壳的接口。
// 这里把这三句话写成可以红的检查（纯判断，读文件经 RepoView，测试用内存假仓造违规的外壳看它红）：
//   1. Rust 源码里没有 Tauri 命令（#[tauri::command]、invoke_handler、generate_handler）、没有自定义协议（register_*uri_scheme_protocol，
//      那是页面能请求到的「路由」）、没有监听（TcpListener、UdpSocket）、不引用任何 HTTP 服务端的库；
//   2. Cargo.toml 的依赖里没有 HTTP 服务端的库；
//   3. capabilities/ 是空的（Tauri 2 里没有授权，页面连插件的命令都调不了），tauri.conf.json 没有内联授权、没有 withGlobalTauri、
//      没有 dangerousRemoteDomainIpcAccess；
//   4. 自带的启动页（ui/）不发请求、不碰 Tauri 的桥。
// 外壳只做四件事：起内核、等 /health 开窗口、托盘和单实例和自启、退出时收内核；业务全在内核和页面里。
import type { RepoView } from './repo.ts';

export const SHELL_DIR = 'apps/desktop';
const SRC = `${SHELL_DIR}/src-tauri`;

/** 源码里出现就红的写法：[正则, 为什么]。 */
export const FORBIDDEN_RUST: readonly (readonly [RegExp, string])[] = [
  [/#\s*\[\s*tauri::command/, 'Tauri 命令：页面能调到外壳里的函数'],
  [/\binvoke_handler\b|\bgenerate_handler\b/, '注册命令的入口：外壳不给页面开接口'],
  [/register_(?:asynchronous_)?uri_scheme_protocol/, '自定义协议：等于给页面开了一条外壳里的路由'],
  [/\bTcpListener\b|\bUdpSocket\b|\bUnixListener\b/, '监听：外壳自己不监听任何口，只当客户端'],
  [
    /\b(?:tiny_http|axum|hyper::server|warp::|actix_web|rouille|rocket::|poem::|salvo::)/,
    'HTTP 服务端：外壳没有路由',
  ],
];

/** Cargo.toml 的依赖里出现就红的包名。 */
export const FORBIDDEN_CRATES: readonly string[] = [
  'axum',
  'tiny_http',
  'warp',
  'actix-web',
  'rouille',
  'rocket',
  'poem',
  'salvo',
  'hyper',
  'tower-http',
  'tauri-plugin-localhost',
  'tauri-plugin-http',
];

const FORBIDDEN_PAGE = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|__TAURI|\binvoke\s*\(|@tauri-apps/;

function walk(repo: RepoView, dir: string, out: string[] = []): string[] {
  for (const name of repo.list(dir) ?? []) {
    const p = `${dir}/${name}`;
    if (repo.isDir(p)) walk(repo, p, out);
    else out.push(p);
  }
  return out;
}

/** 去掉 // 行注释和 /* *\/ 块注释：注释里写「没有 #[tauri::command]」不算违规。 */
export function stripRustComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}

export function checkDesktopShell(repo: RepoView): string[] {
  const problems: string[] = [];
  if (!repo.isDir(SRC)) return [`找不到 ${SRC}（桌面外壳不在了？检查要跟着改）`];

  // 1. Rust 源码
  const rust = walk(repo, `${SRC}/src`).filter((f) => f.endsWith('.rs'));
  if (rust.length === 0) problems.push(`${SRC}/src 下一个 .rs 都没有：读不到外壳源码，不当成没问题`);
  for (const f of [...rust, `${SRC}/build.rs`]) {
    const text = repo.read(f);
    if (text === undefined) {
      if (f !== `${SRC}/build.rs`) problems.push(`读不到 ${f}`);
      continue;
    }
    const code = stripRustComments(text);
    for (const [re, why] of FORBIDDEN_RUST) if (re.test(code)) problems.push(`${f}：${why}（${re.source}）`);
  }

  // 2. 依赖
  const cargo = repo.read(`${SRC}/Cargo.toml`);
  if (cargo === undefined) problems.push(`读不到 ${SRC}/Cargo.toml`);
  else {
    const deps = cargo
      .split(/^\[(?=[^\]]*dependencies)/m)
      .slice(1)
      .join('\n');
    for (const name of FORBIDDEN_CRATES) {
      if (new RegExp(`^\\s*${name.replace(/-/g, '[-_]')}\\s*=`, 'm').test(deps)) {
        problems.push(`${SRC}/Cargo.toml：依赖了 ${name}（HTTP 服务端或给页面开口子的库）`);
      }
    }
  }

  // 3. 授权和配置
  for (const f of repo.list(`${SRC}/capabilities`) ?? []) {
    const text = repo.read(`${SRC}/capabilities/${f}`) ?? '';
    let perms: unknown;
    let remote: unknown;
    try {
      const j = JSON.parse(text) as { permissions?: unknown; remote?: unknown };
      perms = j.permissions;
      remote = j.remote;
    } catch {
      problems.push(`${SRC}/capabilities/${f}：读不懂（授权文件要么删掉，要么 permissions 为空）`);
      continue;
    }
    if (Array.isArray(perms) ? perms.length > 0 : perms !== undefined) {
      problems.push(`${SRC}/capabilities/${f}：授权了权限，页面就能调外壳（capabilities 要保持为空）`);
    }
    if (remote !== undefined) problems.push(`${SRC}/capabilities/${f}：给远端地址开了桥`);
  }
  const confText = repo.read(`${SRC}/tauri.conf.json`);
  if (confText === undefined) problems.push(`读不到 ${SRC}/tauri.conf.json`);
  else {
    try {
      const conf = JSON.parse(confText) as {
        app?: { withGlobalTauri?: unknown; security?: Record<string, unknown> };
      };
      if (conf.app?.withGlobalTauri === true)
        problems.push('tauri.conf.json：withGlobalTauri 打开了，页面全局就有 Tauri 的桥');
      const sec = conf.app?.security ?? {};
      const caps = sec.capabilities;
      if (Array.isArray(caps) ? caps.length > 0 : caps !== undefined) {
        problems.push('tauri.conf.json：app.security.capabilities 内联了授权');
      }
      if ('dangerousRemoteDomainIpcAccess' in sec)
        problems.push('tauri.conf.json：dangerousRemoteDomainIpcAccess 给远端域名开了桥');
    } catch {
      problems.push('tauri.conf.json 不是合法 JSON');
    }
  }

  // 4. 启动页
  for (const f of walk(repo, `${SHELL_DIR}/ui`)) {
    const text = repo.read(f);
    if (text !== undefined && FORBIDDEN_PAGE.test(text)) {
      problems.push(`${f}：启动页发请求或碰 Tauri 的桥（${FORBIDDEN_PAGE.source}）`);
    }
  }
  return problems;
}
