// Windows 专属（CI 的 windows-latest 台跑；先 cargo build -p jobrun）：叫停后整棵进程树都不在、reapSession 回实数、进程号复用不误杀。
// 对应 #3869 的验收条；执行体是 fake-cli.mjs 的 detached-tree、exit-leaving-orphan 两个模式。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Budget, deriveDeadline } from '../src/budget.ts';
import { jobrunBinary, makeJobrunHost, reportPath } from '../src/host-jobrun.ts';
import { type RunSpec, runProcess } from '../src/process.ts';
import { reapSession } from '../src/procs.ts';
import { makeRedactor } from '../src/redact.ts';

const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
const WIN = process.platform === 'win32';
const BUDGET: Budget = { startupMs: 5_000, totalMs: 30_000, killGraceMs: 500 };
let n = 0;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidsOf(file: string): number[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number);
}

function spec(mode: string, pidsFile: string, over: Partial<RunSpec> = {}): RunSpec {
  return {
    command: [process.execPath, FAKE],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', FAKE_MODE: mode, FAKE_PIDS_FILE: pidsFile },
    stdin: 'x',
    runId: `w-${process.pid}-${++n}`,
    budget: BUDGET,
    deadline: deriveDeadline(new Date(), BUDGET),
    redact: makeRedactor([]),
    host: makeJobrunHost(),
    ...over,
  };
}

function freshPidsFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'jr-')), 'pids');
  writeFileSync(file, '');
  return file;
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

describe.skipIf(!WIN || !jobrunBinary())('Windows：jobrun 看守整棵进程树', () => {
  it('叫停后 2 秒内，执行体派生的（脱离的）整棵树的进程号都不在，leftovers 是实数 0', async () => {
    const pidsFile = freshPidsFile();
    const ac = new AbortController();
    const run = runProcess(spec('detached-tree', pidsFile, { signal: ac.signal }));
    // 三代都起来了：执行体自己、两个脱离的子进程、其中一个的脱离孙进程
    expect(await until(() => pidsOf(pidsFile).length >= 4, 10_000)).toBe(true);
    const recorded = pidsOf(pidsFile);
    expect(new Set(recorded).size).toBe(recorded.length);
    expect(recorded.every(isAlive)).toBe(true);

    const stopAt = Date.now();
    ac.abort();
    const r = await run;
    expect(r.killed?.reason).toBe('aborted');
    expect(await until(() => recorded.every((p) => !isAlive(p)), 2_000)).toBe(true);
    expect(Date.now() - stopAt).toBeLessThan(2_000 + 500);
    expect(recorded.filter(isAlive)).toEqual([]);
    expect(r.leftovers).toBe(0);
  }, 30_000);

  it('执行体自己退了、脱离的孙进程还在：runProcess 报数并收掉，不剩', async () => {
    const pidsFile = freshPidsFile();
    const r = await runProcess(spec('exit-leaving-orphan', pidsFile));
    expect(r.exitCode).toBe(0);
    expect(r.stragglers).toBeGreaterThanOrEqual(1);
    expect(r.leftovers).toBe(0);
    const orphans = pidsOf(pidsFile);
    expect(await until(() => orphans.every((p) => !isAlive(p)), 2_000)).toBe(true);
  }, 30_000);

  it('reapSession 在 Windows 回实数 leftovers：Job 还在时整个收掉', async () => {
    const pidsFile = freshPidsFile();
    const s = spec('detached-tree', pidsFile);
    const proc = makeJobrunHost().start({ command: s.command, cwd: s.cwd, env: s.env, runId: s.runId });
    proc.stdout.resume();
    proc.stderr.resume();
    proc.stdin.end('x');
    expect(await until(() => pidsOf(pidsFile).length >= 4, 10_000)).toBe(true);
    const recorded = pidsOf(pidsFile);
    const r = await reapSession(s.runId, 1_000);
    expect(r.found).toBeGreaterThanOrEqual(4);
    expect(r.leftovers).toBe(0);
    expect(typeof r.leftovers).toBe('number');
    expect(await until(() => recorded.every((p) => !isAlive(p)), 2_000)).toBe(true);
    await proc.reap(300);
  }, 30_000);

  it('reapSession 在 Windows 回实数 leftovers：执行体已退，按看守进程留下的报告核对', async () => {
    const pidsFile = freshPidsFile();
    const s = spec('exit-leaving-orphan', pidsFile);
    const proc = makeJobrunHost().start({ command: s.command, cwd: s.cwd, env: s.env, runId: s.runId });
    proc.stdout.resume();
    proc.stderr.resume();
    proc.stdin.end('x');
    await new Promise((res) => proc.onExit(() => res(undefined)));
    const r = await reapSession(s.runId, 1_000);
    expect(r.found).toBeGreaterThanOrEqual(1);
    expect(r.leftovers).toBe(0);
    await proc.reap(300);
  }, 30_000);

  it('没有这个会话的任何痕迹：查不了就回 undefined，不冒充 0', async () => {
    const r = await reapSession(`never-ran-${process.pid}-${++n}`, 200);
    expect(r).toEqual({ found: 0, leftovers: undefined });
  });

  it('进程号复用不误杀：报告里记着的进程号现在属于另一个无关进程（创建时刻对不上），收尸不动它', async () => {
    const stranger = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1<<30)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      const pid = stranger.pid as number;
      expect(isAlive(pid)).toBe(true);
      const runId = `reuse-${process.pid}-${++n}`;
      const report = reportPath(runId);
      mkdirSync(dirname(report), { recursive: true });
      writeFileSync(
        report,
        JSON.stringify({
          exit_code: 0,
          spawn_error: null,
          stragglers: 1,
          leftovers: 0,
          descendants: [{ pid, start: 1 }],
        }),
      );
      const r = await reapSession(runId, 300);
      expect(r.leftovers).toBe(0);
      await new Promise((res) => setTimeout(res, 300));
      expect(isAlive(pid)).toBe(true);
    } finally {
      stranger.kill();
    }
  }, 15_000);
});
