import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '@fleet-dao/adapters/testing';
import { describe, expect, it } from 'vitest';
import {
  ensureDaemon,
  gatewayLog,
  gatewayTest,
  type HealthEnv,
  parseGatewayTest,
  parseStatus,
  parseVersions,
  readGatewayRecords,
  runSync,
  summary,
  THROTTLE_MS,
  updateCheck,
  updateFile,
} from '../src/reclaude-health.ts';

const GATEWAY = [
  'OK      2. https://asia.route.reclaude.ai         672ms',
  'FAIL    3. https://la.route.reclaude.ai           timeout',
  'OK      1. https://www.reclaude.ai                821ms',
].join('\n');
const STATUS =
  'daemon_running: true\ndaemon_version: v1.4.1\ngateway_url: https://asia.route.reclaude.ai\ngateway_healthy: true\n';

interface Fake {
  env: HealthEnv;
  home: string;
  calls: () => string[];
  /** 设某条子命令的输出（键如 "status"、"update --check"）；sleep 秒数写 `sleep:<键>` */
  set: (key: string, out: string, sleepSec?: number) => void;
  clock: { now: Date };
}

function fake(): Fake {
  const home = tempDir();
  const dir = join(home, 'fake');
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'reclaude');
  writeFileSync(
    bin,
    `#!/bin/sh
d="$(dirname "$0")"
echo "$*" >> "$d/calls.log"
k="$(echo "$*" | tr ' ' '_')"
[ -f "$d/sleep-$k" ] && exec sleep "$(cat "$d/sleep-$k")"
[ -f "$d/fail-$k" ] && exit 3
[ -f "$d/out-$k" ] && cat "$d/out-$k" >&2
exit 0
`,
  );
  chmodSync(bin, 0o755);
  const clock = { now: new Date('2026-10-14T00:00:00Z') };
  const f: Fake = {
    home,
    clock,
    env: { home, platform: process.platform, bin, now: () => clock.now },
    calls: () =>
      existsSync(join(dir, 'calls.log'))
        ? readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean)
        : [],
    set: (key, out, sleepSec) => {
      const k = key.replaceAll(' ', '_');
      writeFileSync(join(dir, `out-${k}`), out);
      if (sleepSec) writeFileSync(join(dir, `sleep-${k}`), String(sleepSec));
    },
  };
  return f;
}

describe('解析', () => {
  it('测速行、status 行、版本行', () => {
    expect(parseGatewayTest(GATEWAY)).toEqual([
      { url: 'https://asia.route.reclaude.ai', ok: true, ms: 672 },
      { url: 'https://la.route.reclaude.ai', ok: false, ms: null },
      { url: 'https://www.reclaude.ai', ok: true, ms: 821 },
    ]);
    expect(parseGatewayTest('OK      1. https://www.reclaude.ai  1.2s')[0]).toEqual({
      url: 'https://www.reclaude.ai',
      ok: true,
      ms: 1200,
    });
    expect(parseStatus(STATUS).gateway_url).toBe('https://asia.route.reclaude.ai');
    expect(parseVersions('当前版本: v1.4.1\n最新版本: v1.5.0\n')).toEqual({
      current: 'v1.4.1',
      latest: 'v1.5.0',
    });
    expect(parseVersions('乱码')).toEqual({});
  });
});

describe.skipIf(process.platform === 'win32')('reclaude 健康维护（假 reclaude 脚本）', () => {
  it('ensureDaemon 跑 daemon --detach 并记耗时', async () => {
    const f = fake();
    const r = await ensureDaemon(f.env);
    expect(r.ok).toBe(true);
    expect(f.calls()).toEqual(['daemon --detach']);
    expect(readFileSync(join(f.home, '.fleet-dao', 'mirasim-reclaude', 'health.log'), 'utf8')).toMatch(
      /daemon --detach 完成 \d+ms/,
    );
  });

  it('gatewayTest 追加一行 JSON，带当前线路和健康', async () => {
    const f = fake();
    f.set('config gateway test', GATEWAY);
    f.set('status', STATUS);
    const r = await gatewayTest(f.env);
    expect(r.ok).toBe(true);
    const [rec] = readGatewayRecords(f.home);
    expect(rec).toMatchObject({
      at: '2026-10-14T00:00:00.000Z',
      platform: process.platform,
      current: 'https://asia.route.reclaude.ai',
      healthy: true,
    });
    expect(rec?.results).toHaveLength(3);
  });

  it('测速超时：明确报没查成，不写记录', async () => {
    const f = fake();
    f.set('config gateway test', GATEWAY, 5);
    const r = await gatewayTest({ ...f.env, timeouts: { gateway: 2_000 } }); // 同下「更新检查超时」：留够新建脚本的启动时间
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/没查成.*超时/);
    expect(existsSync(gatewayLog(f.home))).toBe(false);
  });

  it('测速输出认不出：没查成，不拿空当正常', async () => {
    const f = fake();
    f.set('config gateway test', 'hello');
    const r = await gatewayTest(f.env);
    expect(r.ok).toBe(false);
    expect(existsSync(gatewayLog(f.home))).toBe(false);
  });

  it('记录文件超 1MB：截掉旧的一半', async () => {
    const f = fake();
    f.set('config gateway test', GATEWAY);
    f.set('status', STATUS);
    mkdirSync(join(f.home, '.fleet-dao', 'mirasim-reclaude'), { recursive: true });
    const line = `${JSON.stringify({ at: 'old', platform: 'x', current: null, healthy: null, results: [], pad: 'p'.repeat(1000) })}\n`;
    writeFileSync(gatewayLog(f.home), line.repeat(1100));
    expect(statSync(gatewayLog(f.home)).size).toBeGreaterThan(1024 * 1024);
    await gatewayTest(f.env);
    const size = statSync(gatewayLog(f.home)).size;
    expect(size).toBeLessThan(700 * 1024);
    const records = readGatewayRecords(f.home);
    expect(records.at(-1)?.at).toBe('2026-10-14T00:00:00.000Z');
    expect(records.length).toBeGreaterThan(500);
  });

  it('有新版且有在途回合：只记待装，不跑 update', async () => {
    const f = fake();
    f.set('update --check', '当前版本: v1.4.1\n最新版本: v1.5.0\n');
    const r = await updateCheck({ ...f.env, idle: () => false });
    expect(r).toMatchObject({ status: 'ok', hasNew: true, pending: 'busy' });
    expect(f.calls()).toEqual(['update --check']);
    expect(JSON.parse(readFileSync(updateFile(f.home), 'utf8')).pending).toBe('busy');
  });

  it('判不了空闲：只记待装，不跑 update', async () => {
    const f = fake();
    f.set('update --check', '当前版本: v1.4.1\n最新版本: v1.5.0\n');
    const r = await updateCheck({
      ...f.env,
      idle: () => {
        throw new Error('状态不认识');
      },
    });
    expect(r.pending).toBe('unknown');
    expect(f.calls()).toEqual(['update --check']);
  });

  it('有一个会话记录读不了（其余都空闲）：按判不了空闲，只记待装，不跑 update', async () => {
    const f = fake();
    f.set('update --check', '当前版本: v1.4.1\n最新版本: v1.5.0\n');
    const dir = join(f.home, '.mirasim', 'sessions', 'claude');
    mkdirSync(join(dir, 'ok'), { recursive: true });
    writeFileSync(join(dir, 'ok', 'record.json'), JSON.stringify({ runState: 'completed' }));
    mkdirSync(join(dir, 'bad'), { recursive: true });
    writeFileSync(join(dir, 'bad', 'record.json'), '{broken');
    const r = await updateCheck(f.env);
    expect(r.pending).toBe('unknown');
    expect(f.calls()).toEqual(['update --check']);
  });

  it('空闲且有新版：跑 update；没新版不跑', async () => {
    const f = fake();
    f.set('update --check', '当前版本: v1.4.1\n最新版本: v1.5.0\n');
    const r = await updateCheck({ ...f.env, idle: () => true });
    expect(r.updated?.ok).toBe(true);
    expect(f.calls()).toEqual(['update --check', 'update']);
    const g = fake();
    g.set('update --check', '当前版本: v1.4.1\n最新版本: v1.4.1\n');
    const same = await updateCheck({ ...g.env, idle: () => true });
    expect(same.hasNew).toBe(false);
    expect(g.calls()).toEqual(['update --check']);
  });

  it('更新检查超时：记没查成', async () => {
    const f = fake();
    f.set('update --check', '当前版本: v1.4.1\n最新版本: v1.5.0\n', 5);
    // 超时要远大于起一个新建脚本的时间：macOS 首次执行新文件有安全扫描，实测 200–400ms，
    // 200ms 时脚本还没写调用记录就被杀了。假脚本睡 5 秒，2 秒超时仍一定超时。
    const r = await updateCheck({ ...f.env, timeouts: { other: 2_000 }, idle: () => true });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/没查成.*超时/);
    expect(f.calls()).toEqual(['update --check']);
  });

  it('同步节流：daemon 每次跑，测速和更新检查满 6 小时才跑', async () => {
    const f = fake();
    f.set('config gateway test', GATEWAY);
    f.set('status', STATUS);
    f.set('update --check', '当前版本: v1.4.1\n最新版本: v1.4.1\n');
    const count = (cmd: string) => f.calls().filter((c) => c === cmd).length;
    await runSync(f.env);
    await runSync(f.env);
    expect(count('daemon --detach')).toBe(2);
    expect(count('config gateway test')).toBe(1);
    expect(count('update --check')).toBe(1);
    f.clock.now = new Date(f.clock.now.getTime() + THROTTLE_MS - 1000);
    await runSync(f.env);
    expect(count('config gateway test')).toBe(1);
    f.clock.now = new Date(f.clock.now.getTime() + 2000);
    await runSync(f.env);
    expect(count('daemon --detach')).toBe(4);
    expect(count('config gateway test')).toBe(2);
    expect(count('update --check')).toBe(2);
  });

  it('汇总：当前线路最近测速、最近 5 次中位数、版本', async () => {
    const f = fake();
    f.set('config gateway test', GATEWAY);
    f.set('status', STATUS);
    f.set('update --check', '当前版本: v1.4.1\n最新版本: v1.5.0\n');
    for (let i = 0; i < 3; i++) {
      await gatewayTest(f.env);
      f.clock.now = new Date(f.clock.now.getTime() + 1000);
    }
    await updateCheck({ ...f.env, idle: () => false });
    const text = await summary(f.env);
    expect(text).toContain('daemon：在运行（v1.4.1）');
    expect(text).toContain('当前线路：https://asia.route.reclaude.ai（健康）');
    expect(text).toContain('当前线路最近一次测速：672ms');
    expect(text).toContain('https://asia.route.reclaude.ai  672ms');
    expect(text).toContain('https://la.route.reclaude.ai  全部失败');
    expect(text).toContain('有新版 v1.5.0 待装（有在途回合）');
  });

  it('汇总：reclaude 起不来时明说没查成', async () => {
    const f = fake();
    const text = await summary({ ...f.env, bin: join(f.home, 'nope') });
    expect(text).toMatch(/daemon：没查成/);
    expect(text).toContain('线路测速：还没有记录');
    expect(text).toContain('还没检查过更新');
  });
});
