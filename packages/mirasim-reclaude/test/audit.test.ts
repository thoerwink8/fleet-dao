import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tempDir } from '@fleet-dao/adapters/testing';
import { describe, expect, it } from 'vitest';
import { AuditUnreadable, audit, judgeSession, launchLogPath, parseLaunchLog } from '../src/audit.ts';
import { runChild } from './child.ts';

const H = 60 * 60_000;
const NOW = Math.floor(Date.now() / 1000) * 1000;
const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');
const SID_LOCAL = '11111111-1111-4111-8111-111111111111';
const SID_CLOUD = '22222222-2222-4222-8222-222222222222';
const SID_BYPASS = '33333333-3333-4333-8333-333333333333';

function logLine(t: number, rest: string): string {
  return `${iso(t)} pid=1 version=2.0.0 ${rest}`;
}

describe('启动器日志解析', () => {
  it('取 route 和 gateway 词；旧行没有 gateway 记为 ?；记下日志最早时间', () => {
    const text = [
      logLine(NOW - 5 * H, 'event=target-spawned ms=1'),
      logLine(
        NOW - 4 * H,
        `event=launch route=local gateway=stripped sid=${SID_LOCAL} generation=1 sinceProcessMs=2`,
      ),
      logLine(NOW - 3 * H, `event=launch route=cloud sid=${SID_CLOUD} generation=1 sinceProcessMs=2`),
      'garbage line',
    ].join('\n');
    const parsed = parseLaunchLog(text);
    expect(parsed.logStart).toBe(NOW - 5 * H);
    expect(parsed.launches.get(SID_LOCAL)).toEqual([
      { at: NOW - 4 * H, route: 'local', gateway: 'stripped' },
    ]);
    expect(parsed.launches.get(SID_CLOUD)).toEqual([{ at: NOW - 3 * H, route: 'cloud', gateway: '?' }]);
  });

  it('三个平台的日志位置', () => {
    expect(launchLogPath('/h', 'darwin', {})).toBe(
      join('/h', 'Library', 'Caches', 'reclaude-mirasim', 'launch.log'),
    );
    expect(launchLogPath('/h', 'linux', {})).toBe(join('/h', '.cache', 'reclaude-mirasim', 'launch.log'));
    expect(launchLogPath('/h', 'win32', { LOCALAPPDATA: 'C:/L' })).toBe(
      join('C:/L', 'reclaude-mirasim', 'launch.log'),
    );
  });
});

describe('逐回合比对', () => {
  const turn = { start: NOW - 2 * H, end: NOW - 2 * H + 60_000 };
  const relayIn = [{ at: turn.start + 1_000, relay: true }];
  const directIn = [{ at: turn.start + 1_000, relay: false }];

  it('(a) 选平台却没有中继账', () => {
    const r = judgeSession(
      [turn],
      [{ at: turn.start - H, route: 'cloud', gateway: 'kept' }],
      directIn,
      NOW - 9 * H,
    );
    expect(r.flags.join()).toContain('(a)');
  });

  it('(b) 选自有账本却有中继账', () => {
    const r = judgeSession(
      [turn],
      [{ at: turn.start - H, route: 'local', gateway: 'stripped' }],
      relayIn,
      NOW - 9 * H,
    );
    expect(r.flags.join()).toContain('(b)');
    expect(r.launchCounts).toEqual({ 'local/stripped': 1 });
  });

  it('(c) 有回合却没有拉起记录；早于日志覆盖的回合不判', () => {
    expect(judgeSession([turn], [], relayIn, NOW - 9 * H).flags.join()).toContain('(c)');
    expect(judgeSession([turn], [], relayIn, NOW - H).flags).toEqual([]);
  });

  it('对得上不标红：平台有中继账、自有没中继账；回合中途才拉起也算这一回合', () => {
    expect(
      judgeSession([turn], [{ at: turn.start - H, route: 'cloud', gateway: 'kept' }], relayIn, 0).flags,
    ).toEqual([]);
    expect(
      judgeSession([turn], [{ at: turn.start + 500, route: 'local', gateway: 'stripped' }], directIn, 0)
        .flags,
    ).toEqual([]);
  });

  it('gateway 词优先于路由：default 但保留网关按平台判', () => {
    const r = judgeSession([turn], [{ at: turn.start - H, route: 'default', gateway: 'kept' }], directIn, 0);
    expect(r.flags.join()).toContain('(a)');
  });

  it('default 且没给网关（none）＝经 reclaude 走自有：账本有中继账判 (b)', () => {
    const r = judgeSession([turn], [{ at: turn.start - H, route: 'default', gateway: 'none' }], relayIn, 0);
    expect(r.flags.join()).toContain('(b)');
    expect(
      judgeSession([turn], [{ at: turn.start - H, route: 'default', gateway: 'none' }], directIn, 0).flags,
    ).toEqual([]);
  });
});

function fixtureHome(): string {
  const home = tempDir();
  const ms = join(home, '.mirasim');
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  write(
    join(ms, 'setting.json'),
    JSON.stringify({
      agentLaunch: { claude: { command: '/r/mirasim-reclaude' } },
      auth: { token: 'tok-secret' },
    }),
  );
  write(
    join(ms, 'plugin-index', 'ws.json'),
    JSON.stringify({ routes: { [`claude:${SID_LOCAL}`]: 'local', [`claude:${SID_CLOUD}`]: 'cloud' } }),
  );
  write(join(ms, 'plugin-index', 'ws.queue.json'), '{broken but ignored');
  const turnAt = NOW - 2 * H;
  for (const sid of [SID_LOCAL, SID_CLOUD, SID_BYPASS]) {
    write(
      join(ms, 'sessions', 'claude', sid, 'turns.jsonl'),
      `${JSON.stringify({ phase: 'done', startedAt: turnAt, updatedAt: turnAt + 60_000, prompt: 'secret-prompt' })}\n`,
    );
  }
  // 太久以前的会话不进对账。
  write(
    join(ms, 'sessions', 'claude', 'old-session', 'turns.jsonl'),
    `${JSON.stringify({ startedAt: NOW - 10 * 24 * H, updatedAt: NOW - 10 * 24 * H })}\n`,
  );
  const ledger = (sid: string, relay: boolean) =>
    write(
      join(ms, 'traffic', sid, 'index-0.ndjson'),
      [
        { ts: iso(turnAt + 1_000), path: '/v1/messages', viaRelay: relay },
        { ts: iso(turnAt + 2_000), path: '/v1/messages/count_tokens', viaRelay: !relay },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n'),
    );
  ledger(SID_LOCAL, false);
  ledger(SID_CLOUD, false); // 选了平台却没有中继账
  ledger(SID_BYPASS, true);
  return home;
}

function writeLog(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      logLine(NOW - 9 * H, 'event=target-spawned ms=1'),
      logLine(
        NOW - 3 * H,
        `event=launch route=local gateway=stripped sid=${SID_LOCAL} generation=1 sinceProcessMs=2`,
      ),
      logLine(
        NOW - 3 * H,
        `event=launch route=cloud gateway=kept sid=${SID_CLOUD} generation=1 sinceProcessMs=2`,
      ),
    ].join('\n'),
  );
}

describe('对账', () => {
  it('每条近期会话出计数，标出 (a)(c)，只看 /v1/messages', () => {
    const home = fixtureHome();
    const log = join(home, 'launch.log');
    writeLog(log);
    const report = audit(home, log, 3, NOW);
    const bySid = new Map(report.sessions.map((s) => [s.sid, s]));
    expect([...bySid.keys()].sort()).toEqual([SID_LOCAL, SID_CLOUD, SID_BYPASS].sort());
    const local = bySid.get(SID_LOCAL);
    expect(local?.flags).toEqual([]);
    expect(local?.mirasimRoute).toBe('local');
    expect(local?.direct).toBe(1);
    expect(local?.relay).toBe(0);
    expect(bySid.get(SID_CLOUD)?.flags.join()).toContain('(a)');
    expect(bySid.get(SID_BYPASS)?.flags.join()).toContain('(c)');
    expect(bySid.get(SID_BYPASS)?.mirasimRoute).toBe('默认');
  });

  it('读不到或坏行：明确没查成，不拿空当没事', () => {
    const home = fixtureHome();
    expect(() => audit(home, join(home, 'missing.log'), 3, NOW)).toThrow(AuditUnreadable);
    const log = join(home, 'launch.log');
    writeLog(log);
    writeFileSync(join(home, '.mirasim', 'traffic', SID_LOCAL, 'index-1.ndjson'), '{bad');
    expect(() => audit(home, log, 3, NOW)).toThrow(/坏行/);
  });

  it('命令行：先打启动命令现状；有标红退出 1，没查成退出 2，不打内容和令牌', () => {
    const home = fixtureHome();
    const env = {
      ...process.env,
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      XDG_CACHE_HOME: join(home, '.cache'),
    };
    const bin = resolve(import.meta.dirname, '..', 'bin', 'audit');
    const missing = runChild(process.execPath, [bin, '--home', home], { env });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('没查成');
    writeLog(launchLogPath(home, process.platform, env));
    const r = runChild(process.execPath, [bin, '--home', home, '--days', '3'], { env });
    expect(r.stdout.split('\n')[0]).toContain('启动命令：');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(SID_BYPASS.slice(0, 8));
    expect(r.stdout).not.toContain(SID_BYPASS);
    expect(r.stdout + r.stderr).not.toMatch(/secret-prompt|tok-secret/);
    expect(runChild(process.execPath, [bin, '--days', 'x'], { env }).status).toBe(2);
  });

  const cliEnv = (home: string) => ({
    ...process.env,
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CACHE_HOME: join(home, '.cache'),
  });
  const bin = resolve(import.meta.dirname, '..', 'bin', 'audit');
  /** 只留对得上的自有会话：没有标红。 */
  function cleanHome(): { home: string; env: NodeJS.ProcessEnv } {
    const home = fixtureHome();
    const env = cliEnv(home);
    for (const sid of [SID_CLOUD, SID_BYPASS])
      writeFileSync(join(home, '.mirasim', 'sessions', 'claude', sid, 'turns.jsonl'), '');
    writeLog(launchLogPath(home, process.platform, env));
    return { home, env };
  }

  it('命令行：没有标红时退出 0（对照）', () => {
    const { home, env } = cleanHome();
    const r = runChild(process.execPath, [bin, '--home', home], { env });
    expect(r.stdout).toContain('没有标红');
    expect(r.status).toBe(0);
  });

  it('命令行：有没开始时间的回合（放不进对账）退出 2「没查成」', () => {
    const { home, env } = cleanHome();
    writeFileSync(
      join(home, '.mirasim', 'sessions', 'claude', SID_CLOUD, 'turns.jsonl'),
      `${JSON.stringify({ phase: 'done', updatedAt: NOW - H })}\n`,
    );
    const r = runChild(process.execPath, [bin, '--home', home], { env });
    expect(r.stdout + r.stderr).toContain('没查成');
    expect(r.status).toBe(2);
  });

  it('命令行：启动命令被改回裸 claude（顶行标红）退出 1', () => {
    const { home, env } = cleanHome();
    mkdirSync(join(home, '.fleet-dao', 'mirasim-reclaude'), { recursive: true });
    writeFileSync(
      join(home, '.fleet-dao', 'mirasim-reclaude', 'migration.json'),
      JSON.stringify({
        schema: 1,
        previous: { command: 'claude' },
        command: '/r/mirasim-reclaude',
        sourceHash: 'a'.repeat(64),
        binaryHash: 'b'.repeat(64),
        updatedAt: new Date(NOW).toISOString(),
        state: 'migrated',
      }),
    );
    writeFileSync(
      join(home, '.mirasim', 'setting.json'),
      JSON.stringify({ agentLaunch: { claude: { command: 'claude' } } }),
    );
    const r = runChild(process.execPath, [bin, '--home', home], { env });
    expect(r.stdout.split('\n')[0]).toContain('裸 claude');
    expect(r.status).toBe(1);
  });

  it('命令行：列出单会话启动命令覆盖，裸 claude 覆盖标红退出 1', () => {
    const { home, env } = cleanHome();
    writeFileSync(
      join(home, '.mirasim', 'plugin-index', 'ws.json'),
      JSON.stringify({
        routes: { [`claude:${SID_LOCAL}`]: 'local' },
        launches: { [`claude:${SID_BYPASS}`]: { command: 'claude.exe' } },
      }),
    );
    const r = runChild(process.execPath, [bin, '--home', home], { env });
    expect(r.stdout).toContain(SID_BYPASS.slice(0, 8));
    expect(r.stdout).toMatch(/裸 claude/);
    expect(r.status).toBe(1);
  });
});
