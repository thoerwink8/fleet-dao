// 会话进 scope：插头交给 fleet-agent-scope 的参数、环境对不对，收尸是不是经它的 stop。真帮手的端到端在 e2e/scope-e2e.ts。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROCESS_LIMITS, runAgentProcess, type SpawnInfo } from '../src/process.ts';
import { type CgroupScope, scopeLaunch, scopePrefix, scopeUnit } from '../src/procs.ts';
import { fakeAgent, fixturePath, tempDir } from './helpers.ts';

const onPosix = process.platform !== 'win32';
const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'fake-scope-helper.ts');

describe('scope 的参数与环境', () => {
  const scope: CgroupScope = {
    id: 'run-1',
    user: 'fleet-agent-carpool',
    limits: { memoryHigh: '1536M', memoryMax: '2G', memorySwapMax: '0', tasksMax: 512, cpuWeight: 100 },
  };

  it('前缀：sudo -n 帮手 run 编号 --user 会话用户 上限 --cwd 目录 --', () => {
    expect(scopePrefix(scope, '/w/tree')).toEqual([
      '/usr/bin/sudo',
      '-n',
      '/usr/local/sbin/fleet-agent-scope',
      'run',
      'run-1',
      '--user',
      'fleet-agent-carpool',
      '--memory-high',
      '1536M',
      '--memory-max',
      '2G',
      '--memory-swap-max',
      '0',
      '--tasks-max',
      '512',
      '--cpu-weight',
      '100',
      '--cwd',
      '/w/tree',
      '--',
    ]);
    expect(scopeUnit(scope)).toBe('fleet-agent-run-1.scope');
  });

  it('编号、用户、上限、目录不合规矩当场拒（和帮手脚本同一套规矩）', () => {
    expect(() => scopePrefix({ ...scope, id: 'a b' }, '/w')).toThrow('会话编号');
    expect(() => scopePrefix({ ...scope, id: 'x'.repeat(64) }, '/w')).toThrow('会话编号');
    expect(() => scopePrefix({ ...scope, user: 'someone-else' as CgroupScope['user'] }, '/w')).toThrow(
      '会话用户',
    );
    expect(() => scopePrefix({ ...scope, limits: { memoryMax: '2 GB' } }, '/w')).toThrow('memoryMax');
    expect(() => scopePrefix({ ...scope, limits: { cpuWeight: 0 } }, '/w')).toThrow('cpuWeight');
    expect(() => scopePrefix(scope, 'relative/dir')).toThrow('绝对路径');
  });

  it('环境拆两份：FLEET_* 这几类经 sudo 的环境，PATH 改名，执行体开关上命令行，HOME 这类不传', () => {
    const { sudoEnv, envArgs } = scopeLaunch({
      PATH: '/opt/fleet/bin:/usr/bin',
      HOME: '/home/fleet',
      USER: 'fleet',
      TMPDIR: '/tmp/fleet',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      FLEET_API: 'http://127.0.0.1:8788',
      FLEET_TOKEN: 'secret-token',
      GROK_DISABLE_AUTOUPDATER: '1',
      BASH_DEFAULT_TIMEOUT_MS: '600000',
    });
    expect(sudoEnv).toEqual({
      PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
      FLEET_SESSION_PATH: '/opt/fleet/bin:/usr/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      FLEET_API: 'http://127.0.0.1:8788',
      FLEET_TOKEN: 'secret-token',
    });
    expect(envArgs).toEqual(['GROK_DISABLE_AUTOUPDATER=1', 'BASH_DEFAULT_TIMEOUT_MS=600000']);
  });

  it('像凭据的变量不许写上命令行（sudo 记日志、/proc 谁都看得到）', () => {
    for (const key of [
      'CURSOR_API_KEY',
      'XAI_API_KEY',
      'OPENAI_API_KEY',
      'SOME_TOKEN',
      'DB_PASSWORD',
      'AUTH_COOKIE',
    ]) {
      expect(() => scopeLaunch({ [key]: 'x' })).toThrow(key);
    }
    expect(() => scopeLaunch({ BAD: 'a\nb' })).toThrow('写不进命令行');
  });
});

describe.skipIf(!onPosix)('经帮手起停（假帮手）', () => {
  let log: string;
  beforeEach(() => {
    log = join(tempDir(), 'scope.log');
    process.env.FLEET_FAKE_SCOPE_LOG = log;
  });
  afterEach(() => {
    delete process.env.FLEET_FAKE_SCOPE_LOG;
  });
  const entries = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l)
      .map((l) => JSON.parse(l) as { action: string; args: string[]; env: Record<string, string> });
  const scopeOf = (id: string): CgroupScope => ({
    id,
    user: 'fleet-agent-dedicated',
    helper: HELPER,
    sudo: [process.execPath],
  });

  it('命令接在帮手后面、环境按规矩拆；会话看到的是帮手给的环境', async () => {
    const cwd = tempDir();
    const envOut = join(tempDir(), 'env.json');
    const command = fakeAgent({ replay: fixturePath('claude-code', 'cc-haiku-read'), envTo: envOut });
    const spawned: SpawnInfo[] = [];
    const report = await runAgentProcess(
      {
        command,
        cwd,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/home/fleet',
          FLEET_FAKE_SCOPE_LOG: log,
          GROK_DISABLE_AUTOUPDATER: '1',
        },
        stdin: 'x',
        limits: DEFAULT_PROCESS_LIMITS,
        runId: 'run-s1',
        scope: scopeOf('run-s1'),
      },
      { onLine: () => {}, onSpawn: (info) => void spawned.push(info) },
    );
    expect(report.exitCode).toBe(0);
    expect(report.lines).toBeGreaterThan(0);
    expect(spawned[0]?.scope).toBe('fleet-agent-run-s1.scope');
    const run = entries().find((e) => e.action === 'run');
    expect(run?.args).toEqual([
      'run-s1',
      '--user',
      'fleet-agent-dedicated',
      '--cwd',
      cwd,
      '--',
      '/usr/bin/env',
      'GROK_DISABLE_AUTOUPDATER=1',
      ...command,
    ]);
    expect(run?.env.FLEET_RUN_ID).toBe('run-s1');
    expect(run?.env.FLEET_SESSION_PATH).toBe('/usr/bin:/bin');
    expect(run?.env.HOME).toBeUndefined();
    expect(run?.env.GROK_DISABLE_AUTOUPDATER).toBeUndefined();
    const seen = JSON.parse(readFileSync(envOut, 'utf8')) as Record<string, string>;
    expect(seen.GROK_DISABLE_AUTOUPDATER).toBe('1');
    expect(seen.HOME).toBe('/home/fake-session-user');
  });

  it('叫停：经帮手 stop 整个 scope', async () => {
    const controller = new AbortController();
    const report = await runAgentProcess(
      {
        command: fakeAgent({
          replay: fixturePath('claude-code', 'cc-haiku-read'),
          replayLines: 2,
          after: 'hang',
        }),
        cwd: tempDir(),
        env: { PATH: '/usr/bin:/bin', FLEET_FAKE_SCOPE_LOG: log },
        stdin: 'x',
        limits: { ...DEFAULT_PROCESS_LIMITS, killGraceMs: 500 },
        runId: 'run-s2',
        scope: scopeOf('run-s2'),
        signal: controller.signal,
      },
      { onLine: () => controller.abort() },
      undefined,
    );
    expect(report.killed?.reason).toBe('aborted');
    expect(
      entries()
        .filter((e) => e.action === 'stop')
        .map((e) => e.args),
    ).toContainEqual(['run-s2']);
  }, 20_000);

  it('命令没写绝对路径、环境里有凭据：不起会话，交报告说没起来', async () => {
    const base = {
      cwd: tempDir(),
      stdin: 'x',
      limits: DEFAULT_PROCESS_LIMITS,
      runId: 'run-s3',
      scope: scopeOf('run-s3'),
    };
    const relative = await runAgentProcess(
      { ...base, command: ['node', 'x.js'], env: {} },
      { onLine: () => {} },
    );
    expect(relative.spawnError).toContain('绝对路径');
    const secret = await runAgentProcess(
      { ...base, command: [process.execPath, 'x.js'], env: { XAI_API_KEY: 'k' } },
      { onLine: () => {} },
    );
    expect(secret.spawnError).toContain('XAI_API_KEY');
  });
});
