// 引导钩子（agents/hooks/bootstrap.mjs，登记在仓里的 .claude/settings.json）：另一台机器上挂着旧钩子时，
// 在 fleet-dao 检出里一开会话就发现并换新；是新的就一个字不说；不该管的机器（法国会话用户、第一次装机）不动手。
// 全用临时目录当家目录；同步换成假的（真同步在 agents-sync 包里的测试）。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface Health {
  reasons?: string[];
  unreadable?: string;
}
interface SyncArgs {
  home: string;
  seed: string | null;
  force: boolean;
}
interface Lib {
  shouldManage(o: { home: string; env?: Record<string, string> }): {
    manage: boolean;
    why?: string;
    unreadable?: string;
  };
  healthReasons(o: { home: string }): Health;
  bootstrap(o: {
    home: string;
    projectDir: string;
    env?: Record<string, string>;
    syncFleet: (a: SyncArgs) => string;
    git?: unknown;
    sync?: unknown;
  }): string[];
}
const HOOK = fileURLToPath(new URL('../hooks/bootstrap.mjs', import.meta.url));
const lib = (await import(pathToFileURL(HOOK).href)) as Lib;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const write = (file: string, text: string) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};
const cmd = (home: string, script: string) =>
  `node "${home.replaceAll('\\', '/')}/.fleet-dao/hooks/${script}"`;

/** 一台「现在这一代」的机器：设置里登记了新位置、装着的钩子和专用检出里的一样 */
function currentMachine(
  files: Record<string, string> = { 'session-start.mjs': 'new\n', 'pretool.mjs': 'p\n' },
) {
  const home = mkdtempSync(join(tmpdir(), 'bootstrap-'));
  dirs.push(home);
  write(join(home, '.fleet-dao', 'synced.json'), '{}');
  write(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: cmd(home, 'session-start.mjs') }] }] },
    }),
  );
  for (const [n, t] of Object.entries(files)) {
    write(join(home, '.fleet-dao', 'hooks', n), t);
    write(join(home, '.fleet-dao', 'origin-main', 'agents', 'hooks', n), t);
  }
  return home;
}

/** 假同步：记下怎么被叫的；可选「同步成功」时把旧的换成新的 */
function fakeSync(home: string, fix = true) {
  const calls: SyncArgs[] = [];
  const syncFleet = (a: SyncArgs) => {
    calls.push(a);
    if (fix) {
      write(join(home, '.fleet-dao', 'hooks', 'session-start.mjs'), 'new\n');
      write(join(home, '.fleet-dao', 'origin-main', 'agents', 'hooks', 'session-start.mjs'), 'new\n');
      write(
        join(home, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: cmd(home, 'session-start.mjs') }] }],
          },
        }),
      );
    }
    return '规矩同步：这台刚同步到主线最新。';
  };
  return { syncFleet, calls };
}

describe('是现在这一代：一个字不说、不同步', () => {
  it('开会话钩子登记成 Windows 静默启动器，也算现在这一代', () => {
    const home = currentMachine();
    const exe = `${home.replaceAll('\\', '/')}/.fleet-dao/bin/quiet-session-start.exe`;
    write(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: exe }] }] },
      }),
    );
    expect(lib.healthReasons({ home })).toEqual({ reasons: [] });
  });

  it('登记对、脚本和专用检出一样', () => {
    const home = currentMachine();
    expect(lib.healthReasons({ home })).toEqual({ reasons: [] });
    const f = fakeSync(home);
    expect(lib.bootstrap({ home, projectDir: '/p', syncFleet: f.syncFleet })).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });
});

describe('发现旧钩子 → 说为什么 → 强制同步换新', () => {
  it('更老的一代：还挂着 fleet-guard 手装的，开会话钩子没登记到新位置', () => {
    const home = currentMachine();
    write(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'node "/old/fleet-guard/session-start.mjs"' }] },
          ],
          PreToolUse: [{ hooks: [{ type: 'command', command: 'node "/old/fleet-guard/pretool.mjs"' }] }],
        },
      }),
    );
    const r = lib.healthReasons({ home }).reasons ?? [];
    expect(r.join('；')).toMatch(/fleet-guard 目录的钩子（2 条）/);
    expect(r.join('；')).toMatch(/开会话钩子没登记到/);
    const f = fakeSync(home);
    const out = lib.bootstrap({ home, projectDir: '/p/fleet-dao', syncFleet: f.syncFleet });
    expect(out[0]).toMatch(/^发现旧钩子：/);
    expect(out[1]).toContain('规矩同步：这台刚同步到主线最新。');
    expect(out[1]).not.toMatch(/没换好/);
    // 种子是会话所在的检出，且是强制的（不被「3 分钟内刚同步过」挡掉）
    expect(f.calls).toEqual([
      { home, seed: '/p/fleet-dao', force: true, git: undefined, sync: undefined, now: expect.any(Number) },
    ]);
  });

  it('同一代但脚本旧：装着的和专用检出里的不一样，点出是哪几个文件', () => {
    const home = currentMachine();
    write(join(home, '.fleet-dao', 'hooks', 'pretool.mjs'), 'OLD\n');
    const r = lib.healthReasons({ home }).reasons ?? [];
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/和主线不一样（pretool\.mjs）/);
  });

  it('还没有同步专用检出（新办法之前装的）：算旧', () => {
    const home = currentMachine();
    rmSync(join(home, '.fleet-dao', 'origin-main'), { recursive: true, force: true });
    expect((lib.healthReasons({ home }).reasons ?? []).join('；')).toMatch(/没有同步专用检出/);
  });

  it('【故意造出的失败】同步说成功了，核回来还是旧：报「没换好」，不当成换新了', () => {
    const home = currentMachine();
    write(join(home, '.fleet-dao', 'hooks', 'pretool.mjs'), 'OLD\n');
    const f = fakeSync(home, false);
    const out = lib.bootstrap({ home, projectDir: '/p', syncFleet: f.syncFleet });
    expect(out[1]).toMatch(/还有 1 处没换好/);
  });

  it('【故意造出的失败】同步自己抛错：说「没做成」并指到手动命令，钩子不抛', () => {
    const home = currentMachine();
    write(join(home, '.fleet-dao', 'hooks', 'pretool.mjs'), 'OLD\n');
    const out = lib.bootstrap({
      home,
      projectDir: '/p',
      syncFleet: () => {
        throw new Error('炸了');
      },
    });
    expect(out.join('')).toMatch(/换新没做成.*炸了.*pnpm agents:sync/);
  });
});

describe('不该管的机器不动手', () => {
  it('法国会话用户 / 第一次装机：没 synced.json、也没挂 fleet-guard → 不管（哪怕开会话钩子没登记）', () => {
    const home = mkdtempSync(join(tmpdir(), 'bootstrap-'));
    dirs.push(home);
    write(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    expect(lib.shouldManage({ home }).manage).toBe(false);
    const f = fakeSync(home);
    expect(lib.bootstrap({ home, projectDir: '/p', syncFleet: f.syncFleet })).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it('只有 fleet-guard、没 synced.json（最老的一代）：要管', () => {
    const home = mkdtempSync(join(tmpdir(), 'bootstrap-'));
    dirs.push(home);
    write(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'node "/o/fleet-guard/session-start.mjs"' }] },
          ],
        },
      }),
    );
    expect(lib.shouldManage({ home }).manage).toBe(true);
  });

  it('【故意造出的失败】没有 synced.json 的老机器、设置文件又读不了：明说判不了，不当成「没有旧钩子」静默退出（#829 的审查挑出来的）', () => {
    const home = mkdtempSync(join(tmpdir(), 'bootstrap-'));
    dirs.push(home);
    write(join(home, '.claude', 'settings.json'), '{坏了');
    expect(lib.shouldManage({ home })).toMatchObject({
      manage: false,
      unreadable: expect.stringMatching(/读不了/),
    });
    const f = fakeSync(home);
    const out = lib.bootstrap({ home, projectDir: '/p', syncFleet: f.syncFleet });
    expect(out.join('')).toMatch(/引导钩子没核成.*读不了.*pnpm agents:sync/);
    expect(f.calls).toHaveLength(0);
    // 真当钩子跑也是这样：退出 0、说出来
    const r = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/引导钩子没核成/);
  });

  it('设置文件根本不存在（不是读不了）：和法国会话用户一样不管、不出声', () => {
    const home = mkdtempSync(join(tmpdir(), 'bootstrap-'));
    dirs.push(home);
    expect(lib.shouldManage({ home })).toMatchObject({ manage: false });
    expect(lib.shouldManage({ home }).unreadable).toBeUndefined();
  });

  it('FLEET_BOOTSTRAP=off：哪怕旧也不动', () => {
    const home = currentMachine();
    write(join(home, '.fleet-dao', 'hooks', 'pretool.mjs'), 'OLD\n');
    const f = fakeSync(home);
    expect(
      lib.bootstrap({ home, projectDir: '/p', env: { FLEET_BOOTSTRAP: 'off' }, syncFleet: f.syncFleet }),
    ).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it('【故意造出的失败】设置文件不是 JSON：明说判不了，不同步（不拿读不了当旧去覆盖）', () => {
    const home = currentMachine();
    write(join(home, '.claude', 'settings.json'), '{坏了');
    const f = fakeSync(home);
    const out = lib.bootstrap({ home, projectDir: '/p', syncFleet: f.syncFleet });
    expect(out.join('')).toMatch(/没核成.*读不了/);
    expect(f.calls).toHaveLength(0);
  });
});

describe('真的当钩子跑（进程、退出码、标准输出）', () => {
  it('不该管的家目录：退出 0、什么也不打', () => {
    const home = mkdtempSync(join(tmpdir(), 'bootstrap-'));
    dirs.push(home);
    const r = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('仓里的 .claude/settings.json 真的登记了它（项目级 SessionStart，路径带 $CLAUDE_PROJECT_DIR）', () => {
    const settings = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../.claude/settings.json', import.meta.url)), 'utf8'),
    );
    const handler = settings.hooks.SessionStart[0].hooks[0];
    expect(handler.command).toBe('node "$CLAUDE_PROJECT_DIR/agents/hooks/bootstrap.mjs"');
    expect(handler.timeout).toBeGreaterThanOrEqual(90);
  });
});
