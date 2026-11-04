// ProcessHost 一致性测试：起、按行读、叫停、收尸、接回，每个实现跑同一套（决定 0125 第 8 条）。
// local 在哪都跑；jobrun 只在 Windows 跑（要先 cargo build -p jobrun，或设 FLEET_JOBRUN）；hostd 要先 cargo build -p hostd（或设 FLEET_HOSTD）。
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { type HostProcess, type ProcessHost, readLines } from '../src/host.ts';
import { hostdBinary, makeHostdHost } from '../src/host-hostd.ts';
import { jobrunBinary, makeJobrunHost } from '../src/host-jobrun.ts';
import { localHost } from '../src/host-local.ts';
import { HAS_PROC } from '../src/procs.ts';

const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
let n = 0;

interface Impl {
  name: string;
  host: ProcessHost | undefined;
  /** 这个实现收完能数出实数吗（local 要 /proc，jobrun 要 Job，hostd 在 Linux 读 /proc、Windows 用 Job）。 */
  counts: boolean;
}

const hostd = hostdBinary()
  ? makeHostdHost({ stateDir: mkdtempSync(join(tmpdir(), 'conf-hostd-')) })
  : undefined;

const HOSTS: Impl[] = [
  { name: 'local', host: localHost, counts: HAS_PROC },
  {
    name: 'jobrun',
    host: process.platform === 'win32' && jobrunBinary() ? makeJobrunHost() : undefined,
    counts: true,
  },
  // 要先 cargo build -p hostd（或设 FLEET_HOSTD）；CI 的 linux 台和 windows 台都会建
  { name: 'hostd', host: hostd, counts: true },
];

afterAll(async () => {
  await hostd?.close();
});

function begin(host: ProcessHost, mode: string, extra: Record<string, string> = {}) {
  const runId = `conf-${process.pid}-${++n}`;
  const proc = host.start({
    command: [process.execPath, FAKE],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', FAKE_MODE: mode, ...extra },
    runId,
  });
  const lines: string[] = [];
  readLines(proc.stdout, (l) => lines.push(l));
  proc.stderr.resume();
  const exited = new Promise<number | null>((resolve) => proc.onExit((code) => resolve(code)));
  return { proc, runId, lines, exited };
}

function feed(proc: HostProcess, text: string) {
  proc.stdin.on('error', () => {});
  proc.stdin.end(text);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

function pidsOf(file: string): number[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number);
}

describe.each(HOSTS)('ProcessHost 一致性：$name', ({ host, counts }) => {
  it.skipIf(!host)('起：提示词走 stdin，按行读到全部输出，退出码原样回来', async () => {
    const r = begin(host as ProcessHost, 'work');
    feed(r.proc, '派的活');
    expect(await r.exited).toBe(0);
    await until(() => r.lines.length >= 5, 2_000);
    expect(r.lines).toHaveLength(5);
    expect(r.lines[1]).toContain('派的活');
    expect(r.proc.pid).toBeTypeOf('number');
  });

  it.skipIf(!host)(
    '叫停：连叫两下也行，执行体 2 秒内退出',
    async () => {
      const r = begin(host as ProcessHost, 'steady');
      feed(r.proc, 'x');
      expect(await until(() => r.lines.length > 0, 5_000)).toBe(true);
      r.proc.stop('term');
      r.proc.stop('kill');
      const code = await Promise.race([
        r.exited,
        new Promise<'late'>((res) => setTimeout(() => res('late'), 2_000)),
      ]);
      expect(code).not.toBe('late');
      await r.proc.reap(300);
    },
    15_000,
  );

  it.skipIf(!host)(
    '收尸：执行体退了、脱离的孙进程还在，收掉；能数的实现回实数，不能数的回 undefined',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'conf-'));
      const pidsFile = join(dir, 'pids');
      writeFileSync(pidsFile, '');
      const r = begin(host as ProcessHost, 'exit-leaving-orphan', { FAKE_PIDS_FILE: pidsFile });
      feed(r.proc, 'x');
      await r.exited;
      const reaped = await r.proc.reap(500);
      const orphans = pidsOf(pidsFile);
      expect(orphans.length).toBeGreaterThanOrEqual(1);
      if (counts) {
        expect(reaped.found).toBeGreaterThanOrEqual(1);
        expect(reaped.leftovers).toBe(0);
      } else {
        expect(reaped.leftovers).toBeUndefined();
      }
      await until(() => orphans.every((p) => !isAlive(p)), 2_000);
      if (counts) expect(orphans.filter(isAlive)).toEqual([]);
      for (const p of orphans) {
        try {
          process.kill(p, 'SIGKILL');
        } catch {
          // 已经没了
        }
      }
    },
    15_000,
  );

  it.skipIf(!host)('接回：会话收完以后问还有没有进程，答没有（数不了的实现答 undefined）', async () => {
    const r = begin(host as ProcessHost, 'work');
    feed(r.proc, 'x');
    await r.exited;
    await r.proc.reap(300);
    const answer = await (host as ProcessHost).attach(r.runId);
    if (counts) expect(answer).toBe(false);
    else expect(answer).toBeUndefined();
  });
});
