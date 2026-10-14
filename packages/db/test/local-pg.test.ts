// pnpm pg:local（../src/local-pg.ts）：本机测试库在不在跑、脱离会话起、停。真起库的那一步只在 Windows 开发机上手动验，
// 这里换掉 powershell、端口探测，钉住判法和说法。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  type LocalPgDeps,
  localPg,
  localPgConfig,
  START_COMMAND,
  wmiStartScript,
} from '../src/local-pg.ts';

const C = localPgConfig({ FLEET_LOCAL_PG_DIR: 'D:/pg' });

function world(opts: { up?: boolean[]; platform?: NodeJS.Platform; missing?: string[]; wmi?: string } = {}) {
  const ups = [...(opts.up ?? [false])];
  const out: string[] = [];
  const err: string[] = [];
  const scripts: string[] = [];
  const ctl: string[][] = [];
  const deps: LocalPgDeps = {
    platform: opts.platform ?? 'win32',
    exists: (p) => !(opts.missing ?? []).includes(p),
    listening: async () => (ups.length > 1 ? (ups.shift() as boolean) : (ups[0] as boolean)),
    powershell: (s) => {
      scripts.push(s);
      return { status: 0, stdout: `${opts.wmi ?? '0'}\r\n`, stderr: '' };
    },
    pgCtl: (args) => {
      ctl.push(args);
      return { status: 0, stdout: '', stderr: '' };
    },
    sleep: async () => {},
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, out, err, scripts, ctl };
}

describe('pnpm pg:local', () => {
  it('默认位置和端口；FLEET_LOCAL_PG_PORT 认不出就报，不悄悄换成默认', () => {
    const c = localPgConfig({});
    expect(c.port).toBe(DEFAULT_PORT);
    expect(c.dir).toBe('D:/Tools/pg-e2e');
    expect(localPgConfig({ FLEET_LOCAL_PG_PORT: '55439' }).port).toBe(55439);
    expect(() => localPgConfig({ FLEET_LOCAL_PG_PORT: '五五' })).toThrow(/FLEET_LOCAL_PG_PORT/);
  });

  it('status：在跑退出 0 并给连接串；没跑退出 1，说起的命令', async () => {
    const up = world({ up: [true] });
    expect(await localPg(['status'], C, up.deps)).toBe(0);
    expect(up.out.join('\n')).toContain('postgres://postgres@127.0.0.1:55432/postgres');
    const down = world({ up: [false] });
    expect(await localPg([], C, down.deps)).toBe(1);
    expect(down.err.join('\n')).toContain(START_COMMAND);
  });

  it('start：经 WMI 起 pg_ctl（脱离会话），等到端口通了才说起来了', async () => {
    const w = world({ up: [false, false, false, true] });
    expect(await localPg(['start'], C, w.deps)).toBe(0);
    expect(w.scripts).toHaveLength(1);
    expect(w.scripts[0]).toContain('Invoke-CimMethod -ClassName Win32_Process -MethodName Create');
    expect(w.scripts[0]).toContain('start -D');
    expect(w.scripts[0]).toContain('-o "-p 55432"');
    expect(w.out.join('\n')).toContain('E2E_PG_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres');
  });

  it('start：已经在跑就不再起', async () => {
    const w = world({ up: [true] });
    expect(await localPg(['start'], C, w.deps)).toBe(0);
    expect(w.scripts).toEqual([]);
  });

  it('【故意造出的失败】没装、WMI 没起成、起了 30 秒还连不上、不是 Windows：都不说起来了', async () => {
    const missing = world({ missing: [C.pgCtl] });
    expect(await localPg(['start'], C, missing.deps)).toBe(2);
    expect(missing.err.join('\n')).toContain('找不到pg_ctl');
    const wmi = world({ wmi: '9' });
    expect(await localPg(['start'], C, wmi.deps)).toBe(1);
    expect(wmi.err.join('\n')).toContain('WMI 返回 9');
    const never = world({ up: [false] });
    expect(await localPg(['start'], C, never.deps)).toBe(1);
    expect(never.err.join('\n')).toContain(C.log);
    const linux = world({ platform: 'linux' });
    expect(await localPg(['start'], C, linux.deps)).toBe(2);
    expect(linux.scripts).toEqual([]);
  });

  it('stop：在跑就 pg_ctl stop；没跑也算停了；参数不认退出 2', async () => {
    const w = world({ up: [true] });
    expect(await localPg(['stop'], C, w.deps)).toBe(0);
    expect(w.ctl).toEqual([['stop', '-D', C.data, '-m', 'fast']]);
    expect(await localPg(['stop'], C, world({ up: [false] }).deps)).toBe(0);
    expect(await localPg(['restart'], C, world().deps)).toBe(2);
    expect(await localPg(['start', 'x'], C, world().deps)).toBe(2);
  });

  it('脚本里的路径带单引号也不断开 PowerShell 字符串', () => {
    const s = wmiStartScript(localPgConfig({ FLEET_LOCAL_PG_DIR: "D:/it's" }));
    expect(s).toContain("CurrentDirectory = 'D:/it''s'");
  });
});
