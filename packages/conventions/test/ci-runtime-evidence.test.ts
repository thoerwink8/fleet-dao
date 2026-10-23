import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestSpecification, Vitest } from 'vitest/node';
import { parse } from 'yaml';
import {
  ARTIFACT_FILES,
  boundedRead,
  configSnapshot,
  diagnosisRule,
  digestList,
  identity,
  MAX_JSON_BYTES,
  MAX_PROJECTS,
  parseResource,
  type ReporterEvidence,
  type RunnerEvidence,
  readEvidence,
  reporterRule,
  resourceSnapshot,
  runnerRule,
  UNKNOWN,
  writeEvidence,
} from '../src/ci-runtime-evidence.ts';
import RuntimeEvidenceReporter from '../src/ci-runtime-reporter.ts';
import { cacheSummary, diagnoseCiRuntime } from '../src/ci-runtime-run.ts';
import { fsRepo } from '../src/repo.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = fileURLToPath(new URL('../src/bin/ci-runtime.ts', import.meta.url));
const SENTINEL = 'private_RUNTIME_SENTINEL_do_not_upload';
interface CiStep {
  id?: string;
  run?: string;
  if?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string | number>;
  'continue-on-error'?: boolean;
}
function testSteps(): CiStep[] {
  return parse(fsRepo(ROOT).read('.github/workflows/ci.yml') as string).jobs.test.steps;
}
const temp = () => mkdtempSync(join(tmpdir(), 'fleet-runtime-evidence-'));
function envFor(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FLEET_CI_EVIDENCE_DIR: join(dir, 'raw'),
    FLEET_CI_ARTIFACT_DIR: join(dir, 'upload'),
    GITHUB_RUN_ID: '1234',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_JOB: 'test',
    FLEET_CI_SHARD: '1/3 · pg',
    GITHUB_SHA: 'a'.repeat(40),
    FLEET_CI_PR_HEAD: 'b'.repeat(40),
    STEP_VITEST: 'success',
  };
}
function lifecycle(dir: string, phase: 'init' | 'start' | 'end' = 'end') {
  vi.stubEnv('FLEET_CI_EVIDENCE_DIR', join(dir, 'raw'));
  const reporter = new RuntimeEvidenceReporter();
  const config = {
    pool: 'threads',
    isolate: true,
    fileParallelism: true,
    testTimeout: 5000,
    hookTimeout: 10000,
    secret: SENTINEL,
  };
  reporter.onInit({ config, version: '5.0.1' } as unknown as Vitest);
  if (phase !== 'init') reporter.onTestRunStart([{ project: { config } }] as unknown as TestSpecification[]);
  if (phase === 'end') reporter.onTestRunEnd([], [], 'passed');
  return reporter;
}
function json<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function uploaded(env: NodeJS.ProcessEnv): string {
  const dir = env.FLEET_CI_ARTIFACT_DIR as string;
  const names = readdirSync(dir);
  expect(names.every((name) => (ARTIFACT_FILES as readonly string[]).includes(name))).toBe(true);
  expect(names.length).toBeLessThanOrEqual(3);
  let total = 0;
  const texts = names.map((name) => {
    const text = readFileSync(join(dir, name), 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_JSON_BYTES);
    total += Buffer.byteLength(text);
    JSON.parse(text);
    return text;
  });
  expect(total).toBeLessThanOrEqual(256 * 1024);
  const text = texts.join('\n');
  expect(text).not.toContain(SENTINEL);
  return text;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('白名单配置与有界资源', () => {
  it('未公开的默认worker保持unknown，不复制preset、不计算并发峰值', () => {
    expect(configSnapshot({ maxWorkers: undefined, pool: SENTINEL, secret: SENTINEL })).toMatchObject({
      maxWorkers: UNKNOWN,
      maxWorkersMeaning: 'unknown-default-deferred',
      pool: UNKNOWN,
    });
    expect(
      JSON.stringify(configSnapshot({ maxWorkers: 3, testTimeout: 5000, env: { secret: SENTINEL } })),
    ).not.toContain(SENTINEL);
  });
  it('身份不带未核验文本，checkout与PR source分列', () => {
    expect(
      identity({
        GITHUB_JOB: SENTINEL,
        GITHUB_SHA: 'a'.repeat(40),
        FLEET_CI_PR_HEAD: 'b'.repeat(40),
        FLEET_CI_CHECKOUT_HEAD: 'c'.repeat(40),
        FLEET_CI_SHARD: SENTINEL,
      }),
    ).toMatchObject({
      job: UNKNOWN,
      shard: UNKNOWN,
      checkoutHead: 'c'.repeat(40),
      prSourceHead: 'b'.repeat(40),
      eventHead: 'a'.repeat(40),
    });
  });
  it('资源的未知、无限制与真0分开；CPU quota/period不冒充核数', () => {
    expect(parseResource('max 100000', 'cpu-max')).toEqual({ status: 'unlimited' });
    expect(parseResource('200000 100000', 'cpu-max')).toEqual({ status: 'known', value: 200000 });
    expect(parseResource('0', 'number')).toEqual({ status: 'known', value: 0 });
    expect(parseResource('max', 'number')).toEqual({ status: 'unlimited' });
    expect(parseResource('0-3,5,7-8', 'cpuset')).toEqual({ status: 'known', value: 7 });
    for (const [text, kind] of [
      ['', 'cpuset'],
      ['3-1', 'cpuset'],
      ['0-3,2', 'cpuset'],
      ['1 0', 'cpu-max'],
      [SENTINEL, 'number'],
    ] as const)
      expect(parseResource(text, kind)).toMatchObject({ status: 'unknown', reason: 'invalid-data' });
    expect(parseResource('1'.repeat(4097), 'number')).toMatchObject({
      status: 'unknown',
      reason: 'too-large',
    });
  });
  it('只读取受控cgroup路径；不支持和读失败不会写0', () => {
    const read = vi.fn((path: string) => {
      if (path.endsWith('cpu.max')) return '200000 100000';
      if (path.endsWith('memory.max')) return 'max';
      throw new Error(SENTINEL);
    });
    const linux = resourceSnapshot('linux', read);
    expect(linux.cgroupV2CpuQuotaMicros).toEqual({ status: 'known', value: 200000 });
    expect(linux.cgroupV2CpuPeriodMicros).toEqual({ status: 'known', value: 100000 });
    expect(linux.cgroupV2MemoryMaxBytes.status).toBe('unlimited');
    expect(linux.cgroupV2CpusetEffectiveCount).toEqual({ status: 'unknown', reason: 'read-failed' });
    expect(new Set(read.mock.calls.map(([path]) => path))).toEqual(
      new Set([
        '/sys/fs/cgroup/cpu.max',
        '/sys/fs/cgroup/memory.max',
        '/sys/fs/cgroup/cpuset.cpus.effective',
      ]),
    );
    expect(read.mock.calls.filter(([path]) => path.endsWith('cpu.max'))).toHaveLength(1);
    const unsupported = resourceSnapshot('win32', read);
    expect(unsupported.cgroupV2CpuQuotaMicros).toEqual({ status: 'unknown', reason: 'unsupported' });
    expect(JSON.stringify(linux)).not.toContain(SENTINEL);
  });
  it('读盘先限长，超长JSON不能复制进附件', () => {
    const dir = temp();
    writeFileSync(join(dir, 'reporter.json'), ' '.repeat(MAX_JSON_BYTES + 1));
    expect(() => boundedRead(join(dir, 'reporter.json'), MAX_JSON_BYTES)).toThrow(RangeError);
    expect(readEvidence(dir, 'reporter.json', reporterRule)).toEqual({ status: 'invalid' });
  });
  it('输出超64KiB直接拒绝，超长cgroup读数明确too-large且不留正文', () => {
    const dir = temp();
    expect(writeEvidence(dir, 'reporter.json', { data: SENTINEL.repeat(3000) }, () => true)).toBe(false);
    expect(existsSync(join(dir, 'reporter.json'))).toBe(false);
    const resources = resourceSnapshot('linux', () => SENTINEL.repeat(300));
    expect(resources.cgroupV2CpuQuotaMicros).toEqual({ status: 'unknown', reason: 'too-large' });
    expect(resources.cgroupV2CpuPeriodMicros).toEqual({ status: 'unknown', reason: 'too-large' });
    expect(resources.cgroupV2MemoryMaxBytes).toEqual({ status: 'unknown', reason: 'too-large' });
    expect(JSON.stringify(resources)).not.toContain(SENTINEL);
  });
  it('实际project各取自身配置，16个以外计数省略，不上传名称路径', () => {
    const dir = temp();
    const reporter = lifecycle(dir, 'init');
    reporter.onTestRunStart(
      Array.from({ length: 19 }, (_, i) => ({
        project: {
          config: { pool: 'threads', maxWorkers: i + 1, root: SENTINEL, name: SENTINEL },
        },
      })) as unknown as TestSpecification[],
    );
    const snapshot = json<ReporterEvidence>(join(dir, 'raw/reporter.json'));
    expect(snapshot.projects).toHaveLength(MAX_PROJECTS);
    expect(snapshot.omittedProjects).toBe(3);
    expect(snapshot.specificationCount).toBe(19);
    expect(snapshot.projects[0]?.maxWorkers).toBe(1);
    expect(snapshot.projects[15]?.maxWorkers).toBe(16);
    expect(JSON.stringify(snapshot)).not.toContain(SENTINEL);
  });
  it('观测与sink失败不抛进测试，也不打印原error', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reporter = new RuntimeEvidenceReporter();
    expect(() =>
      reporter.onInit({
        get config() {
          throw new Error(SENTINEL);
        },
      } as unknown as Vitest),
    ).not.toThrow();
    const dir = temp();
    writeFileSync(join(dir, 'blocked'), SENTINEL);
    vi.stubEnv('FLEET_CI_EVIDENCE_DIR', join(dir, 'blocked'));
    expect(() => reporter.onInit({ config: {}, version: '5.0.1' } as unknown as Vitest)).not.toThrow();
    expect(error.mock.calls.flat().join(' ')).not.toContain(SENTINEL);
    expect(error.mock.calls.flat().join(' ')).toContain('write-failed');
  });
});

describe('最终诊断不会把缺回执、缓存或框架reason当成功', () => {
  it.each(['init', 'start'] as const)('%s-only被标为incomplete且独立诊断红', (phase) => {
    const dir = temp();
    const env = envFor(dir);
    lifecycle(dir, phase);
    const reporter = json<ReporterEvidence>(join(dir, 'raw/reporter.json'));
    if (phase === 'init') expect(reporter.specificationCount).toBe(UNKNOWN);
    const state = {
      schema: 1,
      writer: 'ci-vitest-wrapper',
      identity: reporter.identity,
      phase: 'exited',
      selected: digestList(['a']),
      invoked: digestList(['a']),
      invocationSemantics: 'argv-file-selection-not-collected-or-passed',
      cache: { key: UNKNOWN, covered: UNKNOWN, sourceRun: UNKNOWN, sourceHead: UNKNOWN },
      childPid: reporter.pid,
      exitCode: 0,
      signal: UNKNOWN,
      startedAt: '2020-01-01T00:00:00.000Z',
      endedAt: new Date().toISOString(),
    };
    expect(writeEvidence(join(dir, 'raw'), 'runner.json', state, runnerRule)).toBe(true);
    expect(diagnoseCiRuntime(env)).toBe(1);
    expect(json(join(dir, 'upload/diagnosis.json')).issues).toContain('reporter-incomplete');
    uploaded(env);
  });
  it.each(['INSTALL', 'POSTGRES_READY', 'TEST_SERVER_CACHE', 'TEST_SERVER_READY'])(
    '%s准备失败只采用具名outcome，不从缺snapshot猜故障',
    (step) => {
      const dir = temp();
      const env = { ...envFor(dir), [`STEP_${step}`]: 'failure', STEP_VITEST: 'skipped' };
      expect(diagnoseCiRuntime(env)).toBe(0);
      const d = json(join(dir, 'upload/diagnosis.json'));
      expect(d).toMatchObject({
        status: 'not-started',
        steps: { [step.toLowerCase().replaceAll('_', '-')]: 'failure', vitest: 'skipped' },
      });
      expect(diagnosisRule(d)).toBe(true);
      uploaded(env);
    },
  );
  it('Vitest步骤outcome未知时不把缺文件冒充未运行或诊断通过', () => {
    const dir = temp();
    const env = { ...envFor(dir), STEP_VITEST: '' };
    expect(diagnoseCiRuntime(env)).toBe(1);
    expect(json(join(dir, 'upload/diagnosis.json')).issues).toContain('step-outcome-unknown');
    uploaded(env);
  });
  it('坏JSON/额外敏感字段不复制上传，只留固定分类', () => {
    const dir = temp();
    const env = envFor(dir);
    mkdirSync(env.FLEET_CI_EVIDENCE_DIR as string);
    writeFileSync(join(dir, 'raw/runner.json'), JSON.stringify({ secret: SENTINEL }));
    writeFileSync(join(dir, 'raw/reporter.json'), SENTINEL);
    expect(diagnoseCiRuntime(env)).toBe(1);
    expect(readdirSync(join(dir, 'upload'))).toEqual(['diagnosis.json']);
    uploaded(env);
  });
  it('缓存来源不在State里，不能拿当前run/head填；原文件名只转成摘要', () => {
    const dir = temp();
    const path = join(dir, 'state.json');
    writeFileSync(
      path,
      JSON.stringify({ schema: 4, mode: 'none', key: 'd'.repeat(64), covered: [SENTINEL], run: [] }),
    );
    expect(cacheSummary(path)).toEqual({
      key: 'd'.repeat(64),
      covered: digestList([SENTINEL]),
      sourceRun: UNKNOWN,
      sourceHead: UNKNOWN,
    });
    writeFileSync(path, JSON.stringify({ key: SENTINEL, covered: [SENTINEL] }));
    expect(cacheSummary(path)).toMatchObject({ key: UNKNOWN, covered: UNKNOWN });
  });
});

function command(
  args: string[],
  env: NodeJS.ProcessEnv,
  bin: 'ci-runtime' | 'ci-cache' | 'ci-box' = 'ci-runtime',
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const entry =
      bin === 'ci-runtime' ? BIN : fileURLToPath(new URL(`../src/bin/${bin}.ts`, import.meta.url));
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: ROOT,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 45000);
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}
function fixture(
  options: {
    fail?: boolean;
    unhandled?: boolean;
    mode?: 'all' | 'files' | 'none';
    blocked?: boolean;
    preset?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), `ci-runtime-${SENTINEL}-`));
  const test = join(dir, 'runtime.test.ts');
  const covered = join(dir, 'covered.test.ts');
  writeFileSync(
    test,
    `import { test, expect } from 'vitest';\ntest('${SENTINEL}', async () => {${options.unhandled ? `process.emit('unhandledRejection', new Error('${SENTINEL}'), Promise.resolve());` : ''} expect(1).toBe(${options.fail ? 2 : 1}); });\n`,
  );
  writeFileSync(covered, `throw new Error('${SENTINEL}_covered_must_not_run');`);
  const config = join(dir, 'vitest.config.mjs');
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      root: dir,
      resolve: {
        alias: {
          vitest: join(
            dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
            'dist/index.js',
          ),
        },
      },
      test: {
        include: [test.replaceAll('\\', '/'), covered.replaceAll('\\', '/')],
        pool: 'threads',
        isolate: true,
        ...(options.preset ? { maxWorkers: 7, testTimeout: 12345 } : {}),
        env: { PRIVATE_ENV: SENTINEL },
        name: SENTINEL,
      },
    })};`,
  );
  const box = join(dir, 'box.txt');
  const run = join(dir, 'run.txt');
  const partial = options.mode === 'files' || options.mode === 'none';
  writeFileSync(box, (partial ? [test, covered] : [test]).join('\n'));
  writeFileSync(run, test);
  const state = join(dir, 'state.json');
  writeFileSync(
    state,
    JSON.stringify({
      schema: 4,
      mode: options.mode ?? 'all',
      key: 'd'.repeat(64),
      covered: partial ? [covered] : [],
      run: [test],
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...envFor(dir),
    BOX_FILE: box,
    RUN_FILES: run,
    STATE: state,
    PRIVATE_ENV: SENTINEL,
    CACHE_MODE: options.mode ?? '',
    VITEST_MAX_WORKERS: options.preset ? '3' : '',
    FLEET_CI_CHECKOUT_HEAD: SENTINEL,
  };
  if (options.blocked) {
    writeFileSync(join(dir, 'blocked'), SENTINEL);
    env.FLEET_CI_EVIDENCE_DIR = join(dir, 'blocked');
  }
  return {
    dir,
    env,
    args: [
      'run',
      '--config',
      config,
      ...(options.preset ? ['--pool=forks', '--maxWorkers=2', '--no-isolate', '--testTimeout=7654'] : []),
    ],
  };
}

describe('真实Vitest子进程与真实wrapper退出', () => {
  it('reporter单独写失败时，真实verify0之后先diagnose1，阻止complete缓存及下一attempt的none', async () => {
    const dir = temp();
    const test = 'packages/conventions/test/ci-box.test.ts';
    const box = join(dir, 'box.txt');
    writeFileSync(box, `${test}\n`);
    const report = join(dir, 'report.json');
    const state = join(dir, 'fleet-test-cache-state.json');
    const env: NodeJS.ProcessEnv = {
      ...envFor(dir),
      BOX_FILE: box,
      STATE: state,
      RUNNER_TEMP: dir,
      CACHE_MODE: 'all',
      GITHUB_EVENT_NAME: 'pull_request',
      VITEST_MAX_WORKERS: '1',
      STEP_VERIFY: 'success',
    };
    const keyArgs = ['key', '--event', 'pull_request', '--tmp', dir, '--box-file', box, '--label', '1/1'];
    const planArgs = ['plan', '--event', 'pull_request', '--tmp', dir];
    expect((await command(keyArgs, env, 'ci-cache')).code).toBe(0);
    expect((await command(planArgs, env, 'ci-cache')).code).toBe(0);
    expect(json(state).mode).toBe('all');
    // runner仍可写，只有reporter原子写的固定临时文件被目录挡住。
    mkdirSync(join(env.FLEET_CI_EVIDENCE_DIR as string, 'reporter.json.tmp'), { recursive: true });
    const run = await command(
      ['run', '--maxWorkers=1', '--reporter=json', `--outputFile.json=${report}`],
      env,
    );
    expect(run.code).toBe(0);
    expect(json<RunnerEvidence>(join(env.FLEET_CI_EVIDENCE_DIR as string, 'runner.json')).exitCode).toBe(0);
    const matrix = { label: '1/1', files: [test], pg: false, temporal: false, estMs: 1 };
    const outcomes: Record<string, number | 'skipped'> = {};
    let success = true;
    let saved = false;
    // 只复现这四步的顺序和GitHub success()短路；本场景的PR/all/cache-miss条件均已满足。
    // 每个本地步骤仍调用真实标准CLI，调换工作流顺序会实际写出错误manifest，使本测试失败。
    for (const step of testSteps()) {
      const name = step.uses === 'actions/cache/save@v4' ? 'cache-save' : step.id;
      if (!name || !['runtime-verify', 'runtime-diagnose', 'cache-record', 'cache-save'].includes(name))
        continue;
      if (step.if?.startsWith('success()') && !success) {
        outcomes[name] = 'skipped';
        continue;
      }
      if (name === 'cache-save') {
        saved = true;
        continue;
      }
      const result =
        name === 'runtime-verify'
          ? await command(
              [
                'verify',
                '--box',
                JSON.stringify(matrix),
                '--mode',
                'all',
                '--report',
                report,
                '--state',
                state,
              ],
              env,
              'ci-box',
            )
          : name === 'runtime-diagnose'
            ? await command(['diagnose'], env)
            : await command(
                ['record', '--event', 'pull_request', '--tmp', dir, '--report', report],
                env,
                'ci-cache',
              );
      outcomes[name] = result.code ?? -1;
      if (name === 'runtime-verify') env.STEP_VERIFY = result.code === 0 ? 'success' : 'failure';
      success = success && result.code === 0;
    }
    env.GITHUB_RUN_ATTEMPT = '2';
    expect((await command(keyArgs, env, 'ci-cache')).code).toBe(0);
    expect((await command(planArgs, env, 'ci-cache')).code).toBe(0);
    expect(outcomes).toEqual({
      'runtime-verify': 0,
      'runtime-diagnose': 1,
      'cache-record': 'skipped',
      'cache-save': 'skipped',
    });
    expect(saved).toBe(false);
    expect(existsSync(join(dir, 'fleet-test-cache/manifest.json'))).toBe(false);
    expect(json(state).mode).toBe('all');
    uploaded(env);
  }, 60000);
  it('显式all走真实Vitest；未知CACHE_MODE明确失败，不降成跳过', async () => {
    const f = fixture({ mode: 'all' });
    expect((await command(f.args, f.env)).code).toBe(0);
    expect(json<RunnerEvidence>(join(f.dir, 'raw/runner.json')).identity.cacheMode).toBe('all');
    f.env.CACHE_MODE = SENTINEL;
    const bad = await command(f.args, f.env);
    expect(bad.code).toBe(1);
    expect(bad.stderr).not.toContain(SENTINEL);
    expect(json<RunnerEvidence>(join(f.dir, 'raw/runner.json')).phase).toBe('preparation-failed');
    expect(json<RunnerEvidence>(join(f.dir, 'raw/runner.json'))).toMatchObject({
      selected: UNKNOWN,
      invoked: UNKNOWN,
    });
    expect(existsSync(join(f.dir, 'raw/reporter.json'))).toBe(false);
  }, 60000);
  it('files只真跑未覆盖文件；CLI/env胜过preset，实际project值来自同进程', async () => {
    const f = fixture({ mode: 'files', preset: true });
    expect((await command(f.args, f.env)).code).toBe(0);
    const runner = json<RunnerEvidence>(join(f.dir, 'raw/runner.json'));
    const reporter = json<ReporterEvidence>(join(f.dir, 'raw/reporter.json'));
    expect(runner).toMatchObject({
      phase: 'exited',
      exitCode: 0,
      selected: { count: 2 },
      invoked: { count: 1 },
      cache: { covered: { count: 1 }, sourceRun: UNKNOWN },
    });
    expect(reporter.pid).toBe(runner.childPid);
    expect(reporter.specificationCount).toBe(1);
    expect(runner.invocationSemantics).toBe('argv-file-selection-not-collected-or-passed');
    expect(reporter.globalConfig).toMatchObject({
      pool: 'forks',
      maxWorkers: 3,
      isolate: false,
      testTimeout: 7654,
    });
    expect(reporter.projects[0]).toMatchObject({
      pool: 'forks',
      maxWorkers: 3,
      isolate: false,
      testTimeout: 7654,
    });
    expect(runner.identity.checkoutHead).toMatch(/^[0-9a-f]{40}$/);
    const diagnose = await command(['diagnose'], f.env);
    expect(diagnose.code).toBe(0);
    expect(diagnose.stdout + diagnose.stderr).not.toContain(SENTINEL);
    uploaded(f.env);
  }, 60000);
  it('模块passed+unhandled的reason仍passed，而CLI与wrapper均真实exit1；默认worker未知', async () => {
    const f = fixture({ unhandled: true });
    const result = await command(f.args, f.env);
    expect(result.code).toBe(1);
    const reporter = json<ReporterEvidence>(join(f.dir, 'raw/reporter.json'));
    expect(reporter.end).toMatchObject({ reason: 'passed', moduleCount: 1, unhandledCount: 1 });
    expect(reporter.globalConfig.maxWorkers).toBe(UNKNOWN);
    expect(json(join(f.dir, 'raw/runner.json')).exitCode).toBe(1);
    f.env.STEP_VITEST = 'failure';
    f.env.STEP_VERIFY = 'skipped';
    const diagnose = await command(['diagnose'], f.env);
    expect(diagnose.code).toBe(0);
    expect(diagnose.stdout + diagnose.stderr).not.toContain(SENTINEL);
    uploaded(f.env);
  }, 60000);
  it('none不加载故意失败的测试，不启动Vitest，不伪造本次资源0', async () => {
    const f = fixture({ mode: 'none', fail: true });
    expect((await command(f.args, f.env)).code).toBe(0);
    expect(existsSync(join(f.dir, 'raw/reporter.json'))).toBe(false);
    expect(json(join(f.dir, 'raw/runner.json'))).toMatchObject({
      phase: 'cached-not-executed',
      childPid: UNKNOWN,
      exitCode: UNKNOWN,
      invoked: { count: 0 },
    });
    expect((await command(['diagnose'], f.env)).code).toBe(0);
    expect(uploaded(f.env)).not.toContain('resources');
  }, 60000);
  it.each([false, true])(
    'sink失败不改变真实Vitest退出，原用例fail=%s，独立诊断必红',
    async (fail) => {
      const f = fixture({ blocked: true, fail });
      const run = await command(f.args, f.env);
      expect(run.code).toBe(fail ? 1 : 0);
      const diagnosticLines = (run.stdout + run.stderr)
        .split('\n')
        .filter((line) => line.includes('CI_RUNTIME_EVIDENCE'))
        .join('\n');
      expect(diagnosticLines).toContain('write-failed');
      expect(diagnosticLines).not.toContain(SENTINEL);
      f.env.STEP_VITEST = fail ? 'failure' : 'success';
      const d = await command(['diagnose'], f.env);
      expect(d.code).toBe(1);
      expect(d.stdout + d.stderr).not.toContain(SENTINEL);
      uploaded(f.env);
    },
    60000,
  );
});

it('工作流保留verify/record判据，always独立核对并只上传固定三JSON', () => {
  const steps = testSteps();
  const runtime = steps.find((s) => s.id === 'runtime-vitest');
  expect(runtime?.run).toContain('ci-runtime.ts run');
  expect(runtime?.['continue-on-error']).toBeUndefined();
  const verify = steps.find((s) => s.id === 'runtime-verify');
  expect(verify?.if).toBe('success()');
  expect(verify?.run).toContain('ci-box.ts verify');
  expect(steps.find((s) => s.id === 'cache-record')?.if).toContain('success()');
  const diagnose = steps.find((s) => s.run?.includes('ci-runtime.ts diagnose'));
  expect(diagnose?.if).toBe('always()');
  expect(diagnose?.['continue-on-error']).toBeUndefined();
  const verifyAt = steps.findIndex((step) => step.id === 'runtime-verify');
  const diagnoseAt = steps.findIndex((step) => step.id === 'runtime-diagnose');
  const recordAt = steps.findIndex((step) => step.id === 'cache-record');
  const saveAt = steps.findIndex((step) => step.uses === 'actions/cache/save@v4');
  expect(diagnoseAt).toBeGreaterThan(verifyAt);
  expect(recordAt).toBeGreaterThan(diagnoseAt);
  expect(saveAt).toBeGreaterThan(recordAt);
  expect(diagnose?.env?.STEP_INSTALL).toBe(`${'$'}{{ steps.runtime-install.outcome }}`);
  expect(diagnose?.env?.STEP_POSTGRES_READY).toBe(`${'$'}{{ steps.runtime-postgres-ready.outcome }}`);
  expect(diagnose?.env?.STEP_TEST_SERVER_CACHE).toBe(`${'$'}{{ steps.runtime-test-server-cache.outcome }}`);
  expect(diagnose?.env?.STEP_TEST_SERVER_READY).toBe(`${'$'}{{ steps.runtime-test-server-ready.outcome }}`);
  expect(steps.find((s) => s.id === 'runtime-postgres-ready')?.run).toBe(
    'node packages/conventions/src/bin/ci-postgres.ts test',
  );
  expect(steps.find((s) => s.id === 'runtime-test-server-ready')?.run).toBe('pnpm test:temporal-server');
  const upload = steps.find((s) => s.uses === 'actions/upload-artifact@v4');
  expect(upload?.if).toBe('always()');
  expect(upload?.with?.['retention-days']).toBe(7);
  const paths = String(upload?.with?.path).trim().split('\n');
  expect(paths).toHaveLength(3);
  expect(paths.map((p) => p.split('/').at(-1))).toEqual([...ARTIFACT_FILES]);
  expect(paths.every((p) => p.startsWith(`${'$'}{{ runner.temp }}/fleet-test-diagnostics/`))).toBe(true);
});
