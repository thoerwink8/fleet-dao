// 走真 grok 插头（adapters 的 runGrok，输入输出走收发目录）的「脱开跑 → 新引擎接回 → 下一段续会话」（#2259）。
// 法国 2026-10-15：#2245 起动手会话发版时脱开引擎跑、新引擎接回；接回那一下 segment-spawner 又调一次 newSessionId，grok 的号原来是
// 随机数，于是核对用的号和命令行上 -s 的那个不一样——跑完判「续会话没续上」（#2251 第三段，55 分钟作废），被杀的记下一个不存在的号，
// 下一段 -r 它报「not found locally」（#2251 第二段）。这里用真插头、真收发目录、假执行体（回放 grok 帧、照 -s 回号，法国会话
// 记录里 -s 给的号就是会话目录名）把这三步走一遍。外壳是 /bin/sh：只在 Linux、macOS 上跑。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type GrokRunSpec, judgeRun, runGrok } from '@fleet-dao/adapters';
import { afterEach, describe, expect, it } from 'vitest';
import { type HostRunSpec, hostDrivers, sessionUuidOf } from '../../src/real/hosts.ts';
import { fakeMirasimDeps, grokFixture } from './fixtures.ts';

const FAKE_AGENT = fileURLToPath(new URL('../../../adapters/test/fake-agent.ts', import.meta.url));
const onPosix = process.platform !== 'win32';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** 法国 #2251 第三段的真帧，终帧会话号换成命令行上给的那个（grok 照 -s 开会话，法国 ~/.grok/sessions 里目录名就是它）。 */
function framesFor(dir: string, sessionId: string): string {
  const { lines } = grokFixture('grok-fr-renamed');
  const file = join(dir, `frames-${sessionId}.ndjson`);
  writeFileSync(
    file,
    `${lines.map((l) => (l.includes('"type":"end"') ? l.replace(/"sessionId":"[^"]+"/, `"sessionId":"${sessionId}"`) : l)).join('\n')}\n`,
  );
  return file;
}

/** 每次起会话交给插头的假执行体：脚本写进临时文件，命令是 node fake-agent.ts 脚本。 */
function grokDriverWith(script: () => Record<string, unknown>) {
  const scripts = tempDir('fleet-grok-fake-');
  let n = 0;
  return hostDrivers({
    claudeCommand: () => ['/opt/fake/reclaude'],
    cursorCommand: () => ['/opt/fake/cursor-agent'],
    grokCommand: () => {
      n += 1;
      const file = join(scripts, `script-${n}.json`);
      writeFileSync(file, JSON.stringify(script()));
      return [process.execPath, FAKE_AGENT, file];
    },
    ...fakeMirasimDeps(),
    sessionProxy: undefined,
    // 真插头；测试机上没有 fleet-agent-scope，不进 scope（其余照生产传进去的那一份）
    run: {
      grok: (spec: GrokRunSpec, options) => {
        const bare: GrokRunSpec = { ...spec };
        delete bare.cgroup;
        return runGrok(bare, options);
      },
    },
  }).grok;
}

function spec(runId: string, cwd: string, session: HostRunSpec['session']): HostRunSpec {
  return {
    runId,
    user: 'fleet-agent-carpool',
    cwd,
    prompt: '照任务书改，改完提交',
    env: { base: { PATH: process.env.PATH ?? '' }, fleetApi: '', fleetToken: '' },
    limits: { startupMs: 10_000, wallClockMs: 20_000, killGraceMs: 300 },
    testCommands: [],
    cgroup: {
      id: runId,
      user: 'fleet-agent-carpool',
      limits: { memoryHigh: '1G', memoryMax: '1G', memorySwapMax: '0' },
    },
    model: 'grok-4.7',
    session,
    purpose: 'work',
  };
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('等不到');
}

const outLines = (dir: string) =>
  existsSync(join(dir, 'out'))
    ? readFileSync(join(dir, 'out'), 'utf8')
        .split('\n')
        .filter((l) => l.trim()).length
    : 0;

describe('会话号按执行编号算（sessionUuidOf）', () => {
  it('同一个编号永远同一个号、UUID 形状（两家都只认 UUID）；不同编号不同号', () => {
    const a = sessionUuidOf('f821ae56-d4fd-44e4-bfaf-5a9f677b577e');
    expect(sessionUuidOf('f821ae56-d4fd-44e4-bfaf-5a9f677b577e')).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sessionUuidOf('bf919e31-1619-477c-96ce-bb7e800cd0e0')).not.toBe(a);
  });

  it('【故意造出的失败】驱动开新会话的号两次一样：接回时再调一次拿到的就是命令行上那个（原来随机，#2251 接回后对不上）', () => {
    const driver = grokDriverWith(() => ({}));
    const runId = randomUUID();
    expect(driver.newSessionId(runId).id).toBe(driver.newSessionId(runId).id);
    expect(driver.newSessionId(runId).id).toBe(sessionUuidOf(runId));
  });
});

describe.skipIf(!onPosix)('grok 脱开跑、接回、再续会话（真插头）', { timeout: 30_000 }, () => {
  it('接回后照常收场、会话号就是 -s 的那个；下一段 -r 它', async () => {
    const work = tempDir('fleet-grok-cwd-');
    const io = tempDir('fleet-grok-io-');
    const files = tempDir('fleet-grok-files-');
    const runId = randomUUID();
    const go = join(files, 'go');
    let argv = '';
    const driver = grokDriverWith(() => {
      argv = join(files, `argv-${randomUUID()}`);
      const id = sessionUuidOf(runId);
      return { replay: framesFor(files, id), holdUntil: { afterLines: 3, file: go }, argvTo: argv };
    });

    // 第一个引擎：开新会话，跑到第 3 帧停住；引擎要走了，放手
    const release = new AbortController();
    const first = driver.newSessionId(runId);
    void driver
      .run(spec(runId, work, { mode: 'new', id: first.id }), {
        io: { dir: io, pollMs: 20, release: release.signal },
      })
      .catch(() => undefined);
    await until(() => outLines(io) === 3);
    release.abort(new Error('发版'));
    const launchedArgv = JSON.parse(readFileSync(argv, 'utf8')) as string[];
    expect(launchedArgv.slice(launchedArgv.indexOf('-s'), launchedArgv.indexOf('-s') + 2)).toEqual([
      '-s',
      first.id,
    ]);

    // 新引擎接回：segment-spawner 照样再要一次号（接回的入参里没有号）
    const again = driver.newSessionId(runId);
    const attached = driver.run(spec(runId, work, { mode: 'new', id: again.id }), {
      io: { dir: io, attach: true, pollMs: 20 },
    });
    writeFileSync(go, '');
    const report = await attached;
    expect(report.sessionId).toBe(first.id);
    expect(report.facts).not.toHaveProperty('mismatch');
    expect(judgeRun(report.facts)).toMatchObject({ outcome: 'ok' });

    // 下一段续它：-r 照记下的号
    const io2 = tempDir('fleet-grok-io-');
    const next = randomUUID();
    const resumeDriver = grokDriverWith(() => {
      argv = join(files, `argv-${randomUUID()}`);
      return { replay: framesFor(files, first.id), argvTo: argv };
    });
    const resumed = await resumeDriver.run(spec(next, work, { mode: 'resume', id: report.sessionId ?? '' }), {
      io: { dir: io2, pollMs: 20 },
    });
    const resumedArgv = JSON.parse(readFileSync(argv, 'utf8')) as string[];
    expect(resumedArgv.slice(resumedArgv.indexOf('-r'), resumedArgv.indexOf('-r') + 2)).toEqual([
      '-r',
      first.id,
    ]);
    expect(resumed.sessionId).toBe(first.id);
    expect(judgeRun(resumed.facts)).toMatchObject({ outcome: 'ok' });
  });

  it('接回后没到终帧就被叫停（#2251 第一段：总时长到顶）：记下的号还是命令行上那个，下一段 -r 得上', async () => {
    const work = tempDir('fleet-grok-cwd-');
    const io = tempDir('fleet-grok-io-');
    const files = tempDir('fleet-grok-files-');
    const runId = randomUUID();
    const driver = grokDriverWith(() => ({
      replay: framesFor(files, sessionUuidOf(runId)),
      replayLines: 3,
      after: 'hang',
    }));
    const release = new AbortController();
    const first = driver.newSessionId(runId);
    void driver
      .run(spec(runId, work, { mode: 'new', id: first.id }), {
        io: { dir: io, pollMs: 20, release: release.signal },
      })
      .catch(() => undefined);
    await until(() => outLines(io) === 3);
    release.abort(new Error('发版'));

    const stop = new AbortController();
    const attached = driver.run(spec(runId, work, { mode: 'new', id: driver.newSessionId(runId).id }), {
      signal: stop.signal,
      io: { dir: io, attach: true, pollMs: 20 },
    });
    setTimeout(() => stop.abort(), 300);
    const report = await attached;
    expect(report.facts.killed).toBeDefined();
    expect(report.sessionId).toBe(first.id);
  });
});
