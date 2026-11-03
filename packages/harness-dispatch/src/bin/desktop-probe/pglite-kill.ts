// 桌面第 0 片实测 ②（#3868）：PGlite 落文件，写入中途 taskkill /F，重开后事件行数和最大 seq 要对得上，连续 N 次（默认 50）。
// 用法：node packages/harness-dispatch/src/bin/desktop-probe/pglite-kill.ts [次数，默认 50]
// 每次：起 pglite-writer（开库自检 → 狂写）→ 等它写起来再随机等 0–800ms → taskkill /F /T → 下一次开库自检。
// 判"损坏"（任一条成立就计一次）：开库失败或超时；count != maxSeq（seq 从 1 连续，不连续就是丢了中间的行）；
// maxSeq < 确认文件里的下限（已 commit 的丢了）；批不原子（事务里 5 行只落了一部分）。
// 末尾再开一次只检查。输出最后一行 `corrupt=N runs=R`，corrupt=0 退出码 0。数据放系统临时目录，跑完删。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runs = Number(process.argv[2] ?? 50);
const writer = fileURLToPath(new URL('./pglite-writer.ts', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'fleet2-kill-'));
const dir = join(work, 'db');
const ack = join(work, 'ack.txt');
writeFileSync(ack, '');

interface Opened {
  count: number;
  maxSeq: number;
  badBatches: number;
  acked: number;
}

function runOnce(
  rounds: number,
  kill: boolean,
): Promise<{ opened: Opened | undefined; openMs: number; err: string; code: number | null }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [writer, dir, ack, String(rounds)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let opened: Opened | undefined;
    let openMs = 0;
    let killed = false;
    const hardStop = setTimeout(
      () => spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }),
      60_000,
    );
    child.stderr.on('data', (b) => {
      err += b;
    });
    child.stdout.on('data', (b) => {
      out += b;
      if (!opened) {
        const m = /\{"opened":.*\}/.exec(out);
        if (m) {
          opened = (JSON.parse(m[0]) as { opened: Opened }).opened;
          openMs = Date.now() - t0;
        }
      }
      if (kill && !killed && out.includes('writing')) {
        killed = true;
        setTimeout(
          () => spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }),
          Math.random() * 800,
        );
      }
    });
    child.on('exit', (code) => {
      clearTimeout(hardStop);
      resolve({ opened, openMs, err, code });
    });
  });
}

let corrupt = 0;
const lines: string[] = [];
let lastMax = 0;
for (let i = 1; i <= runs + 1; i++) {
  const final = i === runs + 1;
  const r = await runOnce(final ? 0 : 100000, !final);
  const o = r.opened;
  const problems: string[] = [];
  if (!o) problems.push(`开库失败 code=${r.code} ${r.err.slice(-300).replace(/\s+/g, ' ')}`);
  else {
    if (o.count !== o.maxSeq) problems.push(`count(${o.count}) != maxSeq(${o.maxSeq})`);
    if (o.maxSeq < o.acked) problems.push(`maxSeq(${o.maxSeq}) < 已确认下限(${o.acked})`);
    if (o.maxSeq < lastMax) problems.push(`maxSeq 回退 ${lastMax} -> ${o.maxSeq}`);
    if (o.badBatches > 0) problems.push(`${o.badBatches} 个批不原子`);
    lastMax = o.maxSeq;
  }
  if (problems.length) corrupt++;
  lines.push(
    `run ${String(i).padStart(2)}${final ? ' (final check)' : ''}: ${
      o
        ? `reopen ${r.openMs}ms count=${o.count} maxSeq=${o.maxSeq} acked>=${o.acked} badBatches=${o.badBatches}`
        : 'NO-OPEN'
    }${problems.length ? ` CORRUPT: ${problems.join('; ')}` : ''}`,
  );
}
console.log(lines.join('\n'));
rmSync(work, { recursive: true, force: true });
console.log(`corrupt=${corrupt} runs=${runs}`);
process.exit(corrupt === 0 ? 0 : 1);
