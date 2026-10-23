// 仅包装 ci.yml 当前 vitest run；不改测试参数、调度或缓存判据。
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_FILES,
  boundedRead,
  diagnosisRule,
  digestList,
  identity,
  modeRule,
  type ReporterEvidence,
  type RunnerEvidence,
  readEvidence,
  reporterRule,
  runnerRule,
  stepOutcomes,
  UNKNOWN,
  writeEvidence,
} from './ci-runtime-evidence.ts';

const require = createRequire(import.meta.url);
const reporterPath = fileURLToPath(new URL('./ci-runtime-reporter.ts', import.meta.url));
const LIST_LIMIT = 1024 * 1024;

function files(path: string | undefined): string[] {
  if (!path) throw new Error('invalid-list');
  const list = boundedRead(path, LIST_LIMIT)
    .trimEnd()
    .split('\n')
    .map((s) => s.replace(/\r$/, ''));
  if (!list.length || list.length > 10000 || list.some((s) => !s || s.length > 2048 || /[\r\n\0]/.test(s)))
    throw new Error('invalid-list');
  return list;
}

/** 只提取旧缓存实际具有的计数/摘要和key，来源run/head始终未知。 */
export function cacheSummary(path: string | undefined): RunnerEvidence['cache'] {
  const unknown: RunnerEvidence['cache'] = {
    key: UNKNOWN,
    covered: UNKNOWN,
    sourceRun: UNKNOWN,
    sourceHead: UNKNOWN,
  };
  try {
    if (!path) return unknown;
    const state: unknown = JSON.parse(boundedRead(path, LIST_LIMIT));
    if (!state || typeof state !== 'object') return unknown;
    const s = state as Record<string, unknown>;
    if (
      !Number.isSafeInteger(s.schema) ||
      !['all', 'files', 'none'].includes(s.mode as string) ||
      typeof s.key !== 'string' ||
      !/^[0-9a-f]{64}$/.test(s.key) ||
      !Array.isArray(s.covered) ||
      s.covered.length > 10000 ||
      s.covered.some((v) => typeof v !== 'string' || v.length > 2048)
    )
      return unknown;
    return { key: s.key, covered: digestList(s.covered), sourceRun: UNKNOWN, sourceHead: UNKNOWN };
  } catch {
    return unknown;
  }
}

function checkoutHead(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd, timeout: 10000, maxBuffer: 1024, windowsHide: true },
      (error, stdout) => {
        const head = stdout.trim();
        resolve(!error && /^[0-9a-f]{40}$/.test(head) ? head : UNKNOWN);
      },
    );
  });
}

export async function runCiVitest(
  options: { env?: NodeJS.ProcessEnv; cwd?: string; args?: string[] } = {},
): Promise<number> {
  const env = { ...(options.env ?? process.env) };
  const cwd = options.cwd ?? process.cwd();
  const mode = env.CACHE_MODE || 'uncached';
  env.FLEET_CI_CACHE_MODE = modeRule(mode) ? mode : UNKNOWN;
  env.FLEET_CI_CHECKOUT_HEAD = await checkoutHead(cwd);
  const dir = env.FLEET_CI_EVIDENCE_DIR;
  const state: RunnerEvidence = {
    schema: 1,
    writer: 'ci-vitest-wrapper',
    identity: identity(env),
    phase: 'starting',
    selected: UNKNOWN,
    invoked: UNKNOWN,
    invocationSemantics: 'argv-file-selection-not-collected-or-passed',
    cache: cacheSummary(env.STATE),
    childPid: UNKNOWN,
    exitCode: UNKNOWN,
    signal: UNKNOWN,
    startedAt: new Date().toISOString(),
    endedAt: UNKNOWN,
  };
  const save = () => {
    if (!dir || !writeEvidence(dir, 'runner.json', state, runnerRule))
      console.error('CI_RUNTIME_EVIDENCE runner-write-failed');
  };
  try {
    // 只清掉本机制上轮的两个固定回执，绝不递归清理传入目录。
    if (dir) {
      mkdirSync(dir, { recursive: true });
      for (const file of ['runner.json', 'reporter.json']) {
        try {
          unlinkSync(join(dir, file));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
    }
  } catch {
    console.error('CI_RUNTIME_EVIDENCE runner-write-failed');
  }
  save();
  try {
    if (!modeRule(mode) || mode === UNKNOWN) throw new Error('invalid-mode');
    const selected = files(env.BOX_FILE);
    const run = mode === 'none' ? [] : mode === 'files' ? files(env.RUN_FILES) : selected;
    state.selected = digestList(selected);
    if (mode === 'none') {
      state.invoked = digestList([]);
      state.phase = 'cached-not-executed';
      state.endedAt = new Date().toISOString();
      save();
      console.log('CI_RUNTIME_EVIDENCE cached-not-executed');
      return 0;
    }
    const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
    const args = ['run', ...run, ...(options.args ?? []), `--reporter=${reporterPath}`];
    return await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd,
        env,
        stdio: 'inherit',
        windowsHide: true,
      });
      state.childPid = child.pid ?? UNKNOWN;
      if (child.pid !== undefined) state.invoked = digestList(run);
      save();
      child.once('error', () => {
        console.error('CI_RUNTIME_EVIDENCE spawn-failed');
      });
      child.once('close', (code, signal) => {
        state.phase = 'exited';
        state.exitCode = code !== null && code >= 0 ? code : UNKNOWN;
        state.signal = signal ? 'received' : UNKNOWN;
        state.endedAt = new Date().toISOString();
        save();
        // null 是没拿到退出码，不能冒充0；诊断写入的结果也不能覆盖真实非零。
        resolve(code === null || code < 0 ? 1 : code);
      });
    });
  } catch {
    state.phase = 'preparation-failed';
    state.endedAt = new Date().toISOString();
    save();
    console.error('CI_RUNTIME_EVIDENCE preparation-failed');
    return 1;
  }
}

/** 最终附件是核过schema的副本；原始report.json及坏回执永不进入上传目录。 */
export function diagnoseCiRuntime(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FLEET_CI_EVIDENCE_DIR;
  const out = env.FLEET_CI_ARTIFACT_DIR;
  if (!raw || !out || raw === out) {
    console.error('CI_RUNTIME_EVIDENCE diagnosis-output-failed');
    return 1;
  }
  const steps = stepOutcomes(env);
  const issues: string[] = [];
  let status = 'not-started';
  const runner = readEvidence(raw, 'runner.json', runnerRule);
  const reporter = readEvidence(raw, 'reporter.json', reporterRule);
  let s: RunnerEvidence | undefined;
  let r: ReporterEvidence | undefined;
  if (runner.status === 'valid') s = runner.value as RunnerEvidence;
  if (reporter.status === 'valid') r = reporter.value as ReporterEvidence;
  if (steps.vitest !== 'skipped' && steps.vitest !== UNKNOWN) {
    if (!s) issues.push(`runner-${runner.status}`);
    else if (s.phase === 'cached-not-executed') {
      status = 'cached-not-executed';
      if (
        r ||
        s.identity.cacheMode !== 'none' ||
        s.invoked === UNKNOWN ||
        s.invoked.count !== 0 ||
        s.childPid !== UNKNOWN ||
        s.exitCode !== UNKNOWN
      )
        issues.push('receipt-mismatch');
    } else {
      status = 'incomplete';
      if (!r) issues.push(`reporter-${reporter.status}`);
      else {
        if (r.observation !== 'ok') issues.push('reporter-observation-failed');
        if (r.phase !== 'ended' || r.end === UNKNOWN || r.startedAt === UNKNOWN)
          issues.push('reporter-incomplete');
        else if (s.phase === 'exited' && s.exitCode !== UNKNOWN) status = 'complete-receipts';
        if (
          r.pid !== s.childPid ||
          JSON.stringify(r.identity) !== JSON.stringify(s.identity) ||
          (r.startedAt !== UNKNOWN && r.startedAt < s.startedAt)
        )
          issues.push('receipt-mismatch');
      }
      if (s.phase !== 'exited' || s.exitCode === UNKNOWN || (steps.vitest === 'success' && s.exitCode !== 0))
        issues.push('receipt-mismatch');
    }
  } else {
    if (steps.vitest === UNKNOWN) {
      status = 'incomplete';
      issues.push('step-outcome-unknown');
    }
    if (s || r) issues.push('receipt-mismatch');
  }
  try {
    mkdirSync(out, { recursive: true });
    // 上传路径只有三个固定文件；上轮副本也不能混进本次上传。
    for (const name of readdirSync(out)) {
      if (!(ARTIFACT_FILES as readonly string[]).includes(name)) issues.push('unexpected-artifact');
      else unlinkSync(join(out, name));
    }
  } catch {
    console.error('CI_RUNTIME_EVIDENCE diagnosis-output-failed');
    return 1;
  }
  if (s && !writeEvidence(out, 'runner.json', s, runnerRule)) {
    console.error('CI_RUNTIME_EVIDENCE diagnosis-output-failed');
    return 1;
  }
  if (r && !writeEvidence(out, 'reporter.json', r, reporterRule)) {
    console.error('CI_RUNTIME_EVIDENCE diagnosis-output-failed');
    return 1;
  }
  const summary = {
    schema: 1,
    writer: 'ci-final-step',
    writtenAt: new Date().toISOString(),
    identity: s?.identity ?? identity(env),
    steps,
    status: issues.length ? 'invalid-evidence' : status,
    issues: [...new Set(issues)].slice(0, 8),
    semantics: 'receipts-only-not-job-success-upload-not-guaranteed-after-runner-loss',
  };
  if (!writeEvidence(out, 'diagnosis.json', summary, diagnosisRule)) {
    console.error('CI_RUNTIME_EVIDENCE diagnosis-output-failed');
    return 1;
  }
  console.log(`CI_RUNTIME_EVIDENCE ${summary.status}`);
  // 单文件64KiB、3文件，最多192KiB，小于总上限256KiB。
  return issues.length ? 1 : 0;
}
