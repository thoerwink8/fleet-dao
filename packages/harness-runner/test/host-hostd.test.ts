// hostd 专属用例（#3871）：版本不对拒用；起了执行体后强杀内核，重启后按 runId 加行号接回，输出不漏不重。
// 要先 cargo build -p hostd（或设 FLEET_HOSTD）；没有可执行文件时这些用例跳过（CI 的 linux 台和 windows 台都会建）。
// 通用的起、读、叫停、收尸、接回在 host-conformance.test.ts 里和别的实现跑同一套。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HostdVersionError, hostdBinary, makeHostdHost } from '../src/host-hostd.ts';

const BIN = hostdBinary();
const FAKE = fileURLToPath(new URL('./fake-cli.mjs', import.meta.url));
const KERNEL = fileURLToPath(new URL('./hostd-kernel.ts', import.meta.url));
const FAKE_HOSTD_V2 = fileURLToPath(new URL('./fake-hostd-v2.mjs', import.meta.url));

function startKernel(mode: 'start' | 'resume', extra: Record<string, string>): ChildProcess {
  return spawn(process.execPath, [KERNEL], {
    env: { ...process.env, MODE: mode, HOSTD_BIN: BIN as string, FAKE, ...extra },
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

const rows = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((r) => r.split('\t'))
    : [];

describe('hostd：版本握手', () => {
  it('hostd 报的协议版本和这边的不一样：拒用，起不来、不降级', async () => {
    const host = makeHostdHost({ launch: [process.execPath, FAKE_HOSTD_V2] });
    const proc = host.start({ command: ['x'], cwd: process.cwd(), env: {}, runId: 'ver-1' });
    // 和开会话一样：握手还没完就把提示词写进 stdin。版本不对只能让这一轮失败，不能打垮进程。
    proc.stdin.write('hi');
    proc.stdin.end();
    const err = await new Promise<Error>((resolve) => proc.onError(resolve));
    expect(err).toBeInstanceOf(HostdVersionError);
    expect(err.message).toContain('拒用');
    expect(proc.pid).toBeUndefined();
    await host.close();
  });

  it.skipIf(!BIN)(
    '真 hostd 拒绝说别的协议版本的客户端',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hostd-ver-'));
      const child = spawn(BIN as string, ['--stdio', '--state-dir', dir], {
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      const first = new Promise<string>((resolve) =>
        child.stdout?.once('data', (c: Buffer) => resolve(String(c))),
      );
      child.stdin?.write(`${JSON.stringify({ type: 'hello', id: 1, protocol: 99, client: 't' })}\n`);
      const reply = JSON.parse(await first);
      expect(reply).toMatchObject({ type: 'error', code: 'version_mismatch', id: 1 });
      const code = await new Promise((r) => child.on('close', r));
      expect(code).toBe(3);
    },
    15_000,
  );
}, 30_000);

describe.skipIf(!BIN)(
  'hostd：强杀内核后按 runId 加行号接回',
  () => {
    it('执行体在写的时候把内核杀了，重启接回：每一行恰好出现一次、顺序对、结局拿得到', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hostd-fault-'));
      const journal = join(dir, 'journal.tsv');
      const runId = `fault-${process.pid}`;
      const common = {
        STATE_DIR: join(dir, 'state'),
        JOURNAL: journal,
        RUN_ID: runId,
        FAKE_TICKS: '60',
        FAKE_TICK_MS: '40',
      };

      const first = startKernel('start', common);
      expect(await until(() => rows(journal).filter((r) => r[0] === 'stdout').length >= 8, 20_000)).toBe(
        true,
      );
      first.kill('SIGKILL');
      await new Promise((r) => first.on('exit', r));
      const before = rows(journal).filter((r) => r[0] === 'stdout').length;
      expect(before).toBeGreaterThanOrEqual(8);
      expect(before).toBeLessThan(62); // 杀的时候执行体还远没写完

      // 内核没了，执行体还在：另一个 hostd 连上去问得到它还活着
      const probe = makeHostdHost({ bin: BIN, stateDir: join(dir, 'state') });
      expect(await probe.attach(runId)).toBe(true);
      await probe.close();

      const second = startKernel('resume', common);
      const secondExited = new Promise((r) => second.on('exit', r));
      expect(await until(() => rows(journal).some((r) => r[0] === 'EXIT'), 30_000)).toBe(true);
      await secondExited;

      const all = rows(journal);
      expect(all.filter((r) => r[0] === 'ERROR')).toEqual([]);
      const out = all.filter((r) => r[0] === 'stdout');
      // 总共 62 行（init、tick 1..60、result），行号 1..62 各一次、顺序对：不漏不重
      expect(out.map((r) => Number(r[1]))).toEqual(Array.from({ length: 62 }, (_, i) => i + 1));
      expect(out[1]?.[2]).toBe('tick 1');
      expect(out[60]?.[2]).toBe('tick 60');
      // 第二个内核接的正好是第一个落下的最后一行之后
      expect(Number(out[before]?.[1])).toBe(before + 1);
      expect(all.at(-1)).toEqual(['EXIT', '0', 'null']);
    }, 60_000);
  },
  90_000,
);
