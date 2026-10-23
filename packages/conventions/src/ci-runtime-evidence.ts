// CI 专用白名单证据。只保存配置、计数和摘要，不保存环境、路径、测试名或错误正文。
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';

export const ARTIFACT_FILES = ['reporter.json', 'runner.json', 'diagnosis.json'] as const;
export const MAX_JSON_BYTES = 64 * 1024;
export const MAX_PROJECTS = 16;
export const MAX_READ_BYTES = 4096;
export const UNKNOWN = 'unknown' as const;
export type Unknown = typeof UNKNOWN;
type Rule = (v: unknown) => boolean;
const oneOf =
  (...values: unknown[]): Rule =>
  (v) =>
    values.includes(v);
const uint: Rule = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const bool: Rule = (v) => typeof v === 'boolean';
const matching =
  (re: RegExp): Rule =>
  (v) =>
    typeof v === 'string' && re.test(v);
const maybe =
  (rule: Rule): Rule =>
  (v) =>
    v === UNKNOWN || rule(v);
const array =
  (rule: Rule, max: number): Rule =>
  (v) =>
    Array.isArray(v) && v.length <= max && v.every(rule);
const object =
  (fields: Record<string, Rule>): Rule =>
  (v) =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).length === Object.keys(fields).length &&
    Object.entries(fields).every(
      ([k, rule]) => Object.hasOwn(v, k) && rule((v as Record<string, unknown>)[k]),
    );
const sha = matching(/^[0-9a-f]{40}$/);
const digest = matching(/^[0-9a-f]{64}$/);
const version = matching(/^v?\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z0-9.-]{1,30})?$/);
const time = matching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
export const modeRule = oneOf('uncached', 'all', 'files', 'none', UNKNOWN);
const outcome = oneOf('success', 'failure', 'cancelled', 'skipped', UNKNOWN);
const countSummaryRule = object({ count: uint, digest });

export function digestList(values: readonly string[]) {
  return {
    count: values.length,
    digest: createHash('sha256')
      .update(JSON.stringify([...values].sort()))
      .digest('hex'),
  };
}

export function identity(env: NodeJS.ProcessEnv = process.env) {
  const field = (name: string, rule: Rule) => (rule(env[name]) ? (env[name] as string) : UNKNOWN);
  return {
    run: field('GITHUB_RUN_ID', matching(/^\d{1,20}$/)),
    attempt: field('GITHUB_RUN_ATTEMPT', matching(/^\d{1,8}$/)),
    job: field('GITHUB_JOB', oneOf('test')),
    shard: field('FLEET_CI_SHARD', matching(/^\d{1,3}\/\d{1,3}(?: · pg)?(?: · temporal)?$/)),
    checkoutHead: field('FLEET_CI_CHECKOUT_HEAD', sha),
    checkoutHeadSource: sha(env.FLEET_CI_CHECKOUT_HEAD) ? 'git-rev-parse-HEAD' : UNKNOWN,
    eventHead: field('GITHUB_SHA', sha),
    prSourceHead: field('FLEET_CI_PR_HEAD', sha),
    cacheMode: modeRule(env.FLEET_CI_CACHE_MODE) ? (env.FLEET_CI_CACHE_MODE as string) : UNKNOWN,
  };
}
const identityRule = object({
  run: maybe(matching(/^\d{1,20}$/)),
  attempt: maybe(matching(/^\d{1,8}$/)),
  job: oneOf('test', UNKNOWN),
  shard: maybe(matching(/^\d{1,3}\/\d{1,3}(?: · pg)?(?: · temporal)?$/)),
  checkoutHead: maybe(sha),
  checkoutHeadSource: oneOf('git-rev-parse-HEAD', UNKNOWN),
  eventHead: maybe(sha),
  prSourceHead: maybe(sha),
  cacheMode: modeRule,
});

export function configSnapshot(config: Record<string, unknown>) {
  const number = (v: unknown) => (uint(v) ? (v as number) : UNKNOWN);
  return {
    pool: oneOf('forks', 'threads', 'vmForks', 'vmThreads')(config.pool) ? (config.pool as string) : UNKNOWN,
    isolate: bool(config.isolate) ? (config.isolate as boolean) : UNKNOWN,
    fileParallelism: bool(config.fileParallelism) ? (config.fileParallelism as boolean) : UNKNOWN,
    maxWorkers: number(config.maxWorkers),
    maxWorkersMeaning:
      config.maxWorkers === undefined ? 'unknown-default-deferred' : 'resolved-config-not-observed-peak',
    testTimeout: number(config.testTimeout),
    hookTimeout: number(config.hookTimeout),
  };
}
const configRule = object({
  pool: oneOf('forks', 'threads', 'vmForks', 'vmThreads', UNKNOWN),
  isolate: maybe(bool),
  fileParallelism: maybe(bool),
  maxWorkers: maybe(uint),
  maxWorkersMeaning: oneOf('unknown-default-deferred', 'resolved-config-not-observed-peak'),
  testTimeout: maybe(uint),
  hookTimeout: maybe(uint),
});

export type ResourceValue =
  | { status: 'known'; value: number }
  | { status: 'unlimited' }
  | { status: 'unknown'; reason: 'unsupported' | 'read-failed' | 'invalid-data' | 'too-large' };
const resourceRule: Rule = (v) =>
  object({ status: oneOf('known'), value: uint })(v) ||
  object({ status: oneOf('unlimited') })(v) ||
  object({
    status: oneOf('unknown'),
    reason: oneOf('unsupported', 'read-failed', 'invalid-data', 'too-large'),
  })(v);
const unknownResource = (
  reason: 'unsupported' | 'read-failed' | 'invalid-data' | 'too-large',
): ResourceValue => ({ status: 'unknown', reason });

/** 只读白名单文件的前 4097 字节，不先无界读整份文件。 */
export function boundedRead(path: string, max = MAX_READ_BYTES): string {
  const fd = openSync(path, 'r');
  try {
    const data = Buffer.alloc(max + 1);
    let size = 0;
    while (size <= max) {
      const n = readSync(fd, data, size, data.length - size, null);
      if (n === 0) break;
      size += n;
    }
    if (size > max) throw new RangeError('too-large');
    return data.subarray(0, size).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function parseResource(raw: string, kind: 'number' | 'cpu-max' | 'cpuset'): ResourceValue {
  if (Buffer.byteLength(raw) > MAX_READ_BYTES) return unknownResource('too-large');
  const text = raw.trim();
  const positive = (s: string) => /^\d{1,16}$/.test(s) && Number.isSafeInteger(Number(s));
  if (kind === 'cpu-max') {
    const parts = text.split(/\s+/);
    if (parts.length !== 2 || !positive(parts[1] as string) || Number(parts[1]) === 0)
      return unknownResource('invalid-data');
    if (parts[0] === 'max') return { status: 'unlimited' };
    // 保留 quota/period 原值，各自有明确单位；不当成物理核数或实际利用率。
    return positive(parts[0] as string)
      ? { status: 'known', value: Number(parts[0]) }
      : unknownResource('invalid-data');
  }
  if (kind === 'cpuset') {
    if (!/^(?:\d{1,6}(?:-\d{1,6})?)(?:,\d{1,6}(?:-\d{1,6})?)*$/.test(text))
      return unknownResource('invalid-data');
    let count = 0;
    let previous = -1;
    for (const part of text.split(',')) {
      const [start, end = start] = part.split('-').map(Number) as [number, number?];
      if (start <= previous || end < start) return unknownResource('invalid-data');
      count += end - start + 1;
      previous = end;
    }
    return { status: 'known', value: count };
  }
  if (text === 'max') return { status: 'unlimited' };
  return positive(text) ? { status: 'known', value: Number(text) } : unknownResource('invalid-data');
}

export function resourceSnapshot(platform = process.platform, read = boundedRead) {
  const osRead = (fn: () => number): ResourceValue => {
    try {
      const value = fn();
      return uint(value) ? { status: 'known', value } : unknownResource('invalid-data');
    } catch {
      return unknownResource('read-failed');
    }
  };
  const cg = (path: string, kind: 'number' | 'cpu-max' | 'cpuset'): ResourceValue => {
    if (platform !== 'linux') return unknownResource('unsupported');
    try {
      return parseResource(read(path), kind);
    } catch (e) {
      return unknownResource(e instanceof RangeError ? 'too-large' : 'read-failed');
    }
  };
  const cpu = (): [ResourceValue, ResourceValue] => {
    if (platform !== 'linux') return [unknownResource('unsupported'), unknownResource('unsupported')];
    try {
      const raw = read('/sys/fs/cgroup/cpu.max');
      const quota = parseResource(raw, 'cpu-max');
      if (quota.status === 'unknown') return [quota, quota];
      return [quota, { status: 'known', value: Number(raw.trim().split(/\s+/)[1]) }];
    } catch (e) {
      const unknown = unknownResource(e instanceof RangeError ? 'too-large' : 'read-failed');
      return [unknown, unknown];
    }
  };
  const [cpuMax, cpuPeriod] = cpu();
  return {
    sampledAt: new Date().toISOString(),
    scope: 'node-os-api-and-readable-cgroup-root-only',
    availableParallelism: osRead(availableParallelism),
    logicalCpuCount: osRead(() => cpus().length),
    osTotalMemoryBytes: osRead(totalmem),
    osFreeMemoryBytes: osRead(freemem),
    cgroupV2CpuQuotaMicros: cpuMax,
    cgroupV2CpuPeriodMicros: cpuPeriod,
    cgroupV2MemoryMaxBytes: cg('/sys/fs/cgroup/memory.max', 'number'),
    cgroupV2CpusetEffectiveCount: cg('/sys/fs/cgroup/cpuset.cpus.effective', 'cpuset'),
    semantics: 'limits-and-os-samples-not-utilization-or-effective-ancestor-limit',
  };
}
const resourcesRule = object({
  sampledAt: time,
  scope: oneOf('node-os-api-and-readable-cgroup-root-only'),
  availableParallelism: resourceRule,
  logicalCpuCount: resourceRule,
  osTotalMemoryBytes: resourceRule,
  osFreeMemoryBytes: resourceRule,
  cgroupV2CpuQuotaMicros: resourceRule,
  cgroupV2CpuPeriodMicros: resourceRule,
  cgroupV2MemoryMaxBytes: resourceRule,
  cgroupV2CpusetEffectiveCount: resourceRule,
  semantics: oneOf('limits-and-os-samples-not-utilization-or-effective-ancestor-limit'),
});

export interface ReporterEvidence {
  schema: 1;
  writer: 'vitest-reporter';
  pid: number;
  identity: ReturnType<typeof identity>;
  node: string;
  vitest: string;
  phase: 'initialized' | 'started' | 'ended';
  specificationCount: number | Unknown;
  globalConfig: ReturnType<typeof configSnapshot>;
  projects: ReturnType<typeof configSnapshot>[];
  omittedProjects: number;
  resources: ReturnType<typeof resourceSnapshot>;
  startedAt: string | Unknown;
  end:
    | {
        reason: 'passed' | 'failed' | 'interrupted';
        moduleCount: number;
        unhandledCount: number;
        endedAt: string;
      }
    | Unknown;
  observation: 'ok' | 'observation-failed' | 'write-failed';
}
export const reporterRule = object({
  schema: oneOf(1),
  writer: oneOf('vitest-reporter'),
  pid: uint,
  identity: identityRule,
  node: maybe(version),
  vitest: maybe(version),
  phase: oneOf('initialized', 'started', 'ended'),
  specificationCount: maybe(uint),
  globalConfig: configRule,
  projects: array(configRule, MAX_PROJECTS),
  omittedProjects: uint,
  resources: resourcesRule,
  startedAt: maybe(time),
  end: (v) =>
    v === UNKNOWN ||
    object({
      reason: oneOf('passed', 'failed', 'interrupted'),
      moduleCount: uint,
      unhandledCount: uint,
      endedAt: time,
    })(v),
  observation: oneOf('ok', 'observation-failed', 'write-failed'),
});
export function safeVersion(v: unknown): string {
  return version(v) ? (v as string) : UNKNOWN;
}

export interface RunnerEvidence {
  schema: 1;
  writer: 'ci-vitest-wrapper';
  identity: ReturnType<typeof identity>;
  phase: 'starting' | 'exited' | 'cached-not-executed' | 'preparation-failed';
  selected: ReturnType<typeof digestList> | Unknown;
  invoked: ReturnType<typeof digestList> | Unknown;
  invocationSemantics: 'argv-file-selection-not-collected-or-passed';
  cache: {
    key: string;
    covered: ReturnType<typeof digestList> | Unknown;
    sourceRun: Unknown;
    sourceHead: Unknown;
  };
  childPid: number | Unknown;
  exitCode: number | Unknown;
  signal: 'received' | Unknown;
  startedAt: string;
  endedAt: string | Unknown;
}
export const runnerRule = object({
  schema: oneOf(1),
  writer: oneOf('ci-vitest-wrapper'),
  identity: identityRule,
  phase: oneOf('starting', 'exited', 'cached-not-executed', 'preparation-failed'),
  selected: (v) => v === UNKNOWN || countSummaryRule(v),
  invoked: (v) => v === UNKNOWN || countSummaryRule(v),
  invocationSemantics: oneOf('argv-file-selection-not-collected-or-passed'),
  cache: object({
    key: maybe(digest),
    covered: (v) => v === UNKNOWN || countSummaryRule(v),
    sourceRun: oneOf(UNKNOWN),
    sourceHead: oneOf(UNKNOWN),
  }),
  childPid: maybe(uint),
  exitCode: maybe(uint),
  signal: oneOf('received', UNKNOWN),
  startedAt: time,
  endedAt: maybe(time),
});
export const STEP_NAMES = [
  'checkout',
  'pnpm',
  'node',
  'install',
  'postgres-ready',
  'test-server-cache',
  'test-server-ready',
  'temporal-version',
  'temporal-cache',
  'temporal-download',
  'temporal-ready',
  'box',
  'cache-key',
  'cache-restore',
  'cache-plan',
  'vitest',
  'verify',
] as const;
export function stepOutcomes(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    STEP_NAMES.map((name) => {
      const v = env[`STEP_${name.replaceAll('-', '_').toUpperCase()}`];
      return [name, outcome(v) ? v : UNKNOWN];
    }),
  );
}
export const diagnosisRule = object({
  schema: oneOf(1),
  writer: oneOf('ci-final-step'),
  writtenAt: time,
  identity: identityRule,
  steps: object(Object.fromEntries(STEP_NAMES.map((k) => [k, outcome]))),
  status: oneOf('complete-receipts', 'cached-not-executed', 'incomplete', 'not-started', 'invalid-evidence'),
  issues: array(
    oneOf(
      'runner-missing',
      'runner-invalid',
      'reporter-missing',
      'reporter-invalid',
      'reporter-incomplete',
      'reporter-observation-failed',
      'receipt-mismatch',
      'step-outcome-unknown',
      'unexpected-artifact',
    ),
    8,
  ),
  semantics: oneOf('receipts-only-not-job-success-upload-not-guaranteed-after-runner-loss'),
});

export function writeEvidence(
  dir: string,
  file: (typeof ARTIFACT_FILES)[number],
  data: unknown,
  rule: Rule,
): boolean {
  try {
    if (!rule(data)) return false;
    const bytes = `${JSON.stringify(data, null, 2)}\n`;
    if (Buffer.byteLength(bytes) > MAX_JSON_BYTES) return false;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, file);
    writeFileSync(`${path}.tmp`, bytes, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    return true;
  } catch {
    return false;
  }
}

export function readEvidence(
  dir: string,
  file: (typeof ARTIFACT_FILES)[number],
  rule: Rule,
): { status: 'valid'; value: unknown } | { status: 'missing' | 'invalid' } {
  try {
    const value: unknown = JSON.parse(boundedRead(join(dir, file), MAX_JSON_BYTES));
    return rule(value) ? { status: 'valid', value } : { status: 'invalid' };
  } catch (e) {
    return { status: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid' };
  }
}
