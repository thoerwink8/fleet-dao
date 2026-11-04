// 桌面外壳不含业务代码、不开路由、不给页面开接口的检查（#3870）：真仓要干净，造出来的违规要红。
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkDesktopShell, stripRustComments } from '../src/desktop-shell.ts';
import { fsRepo } from '../src/repo.ts';
import { memRepo } from './helpers.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = 'apps/desktop/src-tauri';

const CLEAN: Record<string, string> = {
  [`${SRC}/src/lib.rs`]:
    'pub fn run() { tauri::Builder::default().run(tauri::generate_context!()).unwrap(); }',
  [`${SRC}/src/main.rs`]: 'fn main() {}',
  [`${SRC}/Cargo.toml`]:
    '[package]\nname = "x"\n[dependencies]\ntauri = "2"\nureq = "2"\n[profile.release]\nlto = true\n',
  [`${SRC}/tauri.conf.json`]: '{"app":{"withGlobalTauri":false,"security":{"csp":null}}}',
  'apps/desktop/ui/index.html': '<!doctype html><title>x</title><script>document.title="y"</script>',
};

const with_ = (extra: Record<string, string>, drop: string[] = []) => {
  const files = { ...CLEAN, ...extra };
  for (const d of drop) delete files[d];
  return memRepo(files);
};

describe('桌面外壳检查', () => {
  it('真仓里的外壳是干净的', () => {
    expect(checkDesktopShell(fsRepo(ROOT))).toEqual([]);
  });

  it('干净的假外壳没有问题；没有 capabilities 目录也行', () => {
    expect(checkDesktopShell(memRepo(CLEAN))).toEqual([]);
  });

  it('外壳目录不见了不当成通过', () => {
    expect(checkDesktopShell(memRepo({}))[0]).toContain('找不到');
  });

  it.each([
    ['Tauri 命令', '#[tauri::command]\nfn run_job() {}', 'Tauri 命令'],
    ['注册命令', 'builder.invoke_handler(tauri::generate_handler![a]);', '注册命令'],
    ['自定义协议', 'b.register_uri_scheme_protocol("app", |_, _| todo!());', '自定义协议'],
    ['异步自定义协议', 'b.register_asynchronous_uri_scheme_protocol("app", |_, _, _| ());', '自定义协议'],
    ['监听口', 'let l = std::net::TcpListener::bind("127.0.0.1:0");', '监听'],
    ['HTTP 服务端', 'let s = tiny_http::Server::http("127.0.0.1:0");', 'HTTP 服务端'],
  ])('Rust 源码里有%s就红', (_n, code, why) => {
    const p = checkDesktopShell(with_({ [`${SRC}/src/extra.rs`]: code }));
    expect(p.length).toBeGreaterThan(0);
    expect(p.join('\n')).toContain(why);
    expect(p.join('\n')).toContain('extra.rs');
  });

  it('build.rs 里的违规也红；注释里写到这些词不算', () => {
    expect(checkDesktopShell(with_({ [`${SRC}/build.rs`]: '#[tauri::command] fn x() {}' })).length).toBe(1);
    const commented = '// 没有 #[tauri::command]，也没有 TcpListener\n/* invoke_handler */\nfn ok() {}';
    expect(checkDesktopShell(with_({ [`${SRC}/src/extra.rs`]: commented }))).toEqual([]);
  });

  it('依赖里出现 HTTP 服务端的库就红（带下划线的写法也认）', () => {
    for (const dep of [
      'axum = "0.7"',
      'tiny_http = "0.12"',
      'actix-web = "4"',
      'tauri-plugin-localhost = "2"',
    ]) {
      const toml = `[package]\nname="x"\n[dependencies]\ntauri = "2"\n${dep}\n`;
      const p = checkDesktopShell(with_({ [`${SRC}/Cargo.toml`]: toml }));
      expect(p.join('\n'), dep).toContain('Cargo.toml');
    }
    const winOnly = '[target.\'cfg(windows)\'.dependencies]\nhyper = "1"\n';
    expect(checkDesktopShell(with_({ [`${SRC}/Cargo.toml`]: winOnly })).join('\n')).toContain('hyper');
  });

  it('capabilities 里授了权限就红；空的授权文件不红', () => {
    const grant = JSON.stringify({ identifier: 'x', windows: ['main'], permissions: ['core:default'] });
    expect(checkDesktopShell(with_({ [`${SRC}/capabilities/default.json`]: grant })).join('\n')).toContain(
      '授权了权限',
    );
    const remote = JSON.stringify({ identifier: 'x', permissions: [], remote: { urls: ['http://*'] } });
    expect(checkDesktopShell(with_({ [`${SRC}/capabilities/r.json`]: remote })).join('\n')).toContain('远端');
    const empty = JSON.stringify({ identifier: 'x', windows: ['main'], permissions: [] });
    expect(checkDesktopShell(with_({ [`${SRC}/capabilities/e.json`]: empty }))).toEqual([]);
    expect(checkDesktopShell(with_({ [`${SRC}/capabilities/bad.json`]: '{' })).join('\n')).toContain(
      '读不懂',
    );
  });

  it('tauri.conf.json 打开全局桥、内联授权、给远端域名开桥都红', () => {
    const conf = (app: unknown) => ({ [`${SRC}/tauri.conf.json`]: JSON.stringify({ app }) });
    expect(checkDesktopShell(with_(conf({ withGlobalTauri: true }))).join('\n')).toContain('withGlobalTauri');
    expect(
      checkDesktopShell(
        with_(conf({ security: { capabilities: [{ identifier: 'a', permissions: ['x'] }] } })),
      ).join('\n'),
    ).toContain('内联');
    expect(
      checkDesktopShell(with_(conf({ security: { dangerousRemoteDomainIpcAccess: [] } }))).join('\n'),
    ).toContain('dangerousRemoteDomainIpcAccess');
    expect(checkDesktopShell(with_({ [`${SRC}/tauri.conf.json`]: '{' })).join('\n')).toContain(
      '不是合法 JSON',
    );
  });

  it('启动页发请求或碰 Tauri 的桥就红', () => {
    for (const code of ['fetch("/x")', 'window.__TAURI_INTERNALS__.invoke("a")', 'new WebSocket("ws://x")']) {
      const p = checkDesktopShell(with_({ 'apps/desktop/ui/index.html': `<script>${code}</script>` }));
      expect(p.join('\n'), code).toContain('启动页');
    }
  });

  it('读不到源码不当成没问题', () => {
    const p = checkDesktopShell(
      memRepo({ [`${SRC}/Cargo.toml`]: '[dependencies]\n', [`${SRC}/tauri.conf.json`]: '{}' }),
    );
    expect(p.join('\n')).toContain('一个 .rs 都没有');
  });

  it('去注释的写法：行注释、行尾注释、块注释', () => {
    expect(stripRustComments('a // b\n// c\n/* d\ne */ f')).not.toMatch(/[bcde]/);
    expect(stripRustComments('let u = "http://x";')).toContain('http:');
  });
});
