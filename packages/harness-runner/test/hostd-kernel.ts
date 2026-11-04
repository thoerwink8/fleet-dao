// 故障用例里的「内核」：一个单独的进程，用 HostdProcessHost 起（或接回）一个会慢慢吐编号行的执行体，
// 每收到一行先写进日记（带行号），再让游标前进。测试在它中途把它强杀，再起第二个按日记里的行号接回。
// 环境：HOSTD_BIN、STATE_DIR、JOURNAL、RUN_ID、FAKE（假执行体路径）、MODE=start|resume、FAKE_TICKS、FAKE_TICK_MS。
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { makeHostdHost } from '../src/host-hostd.ts';

const env = process.env as Record<string, string>;
const journal = env.JOURNAL as string;
const runId = env.RUN_ID as string;
const host = makeHostdHost({ bin: env.HOSTD_BIN, stateDir: env.STATE_DIR });

/** 日记里每路已经落下的最后一行的行号 = 重启后的游标。 */
function cursorFromJournal() {
  const cursor = { stdout: 0, stderr: 0 };
  if (!existsSync(journal)) return cursor;
  for (const row of readFileSync(journal, 'utf8').split('\n')) {
    const [stream, n] = row.split('\t');
    if (stream === 'stdout' || stream === 'stderr') cursor[stream] = Math.max(cursor[stream], Number(n));
  }
  return cursor;
}

const proc =
  env.MODE === 'resume'
    ? host.resume(runId, cursorFromJournal())
    : host.start({
        command: [process.execPath, env.FAKE as string],
        cwd: process.cwd(),
        env: {
          PATH: env.PATH ?? '',
          FAKE_MODE: 'ticks',
          FAKE_TICKS: env.FAKE_TICKS ?? '40',
          FAKE_TICK_MS: env.FAKE_TICK_MS ?? '50',
        },
        runId,
      });

// 先落日记，游标才算前进（HostdProcess 在回调之后才交出下一行）
proc.onLine((stream, line, text) => appendFileSync(journal, `${stream}\t${line}\t${text}\n`));
proc.onError((err) => appendFileSync(journal, `ERROR\t${err.message}\n`));
proc.onExit((code, signal) => {
  appendFileSync(journal, `EXIT\t${code}\t${signal}\n`);
  void host.close().then(() => process.exit(0));
});
if (env.MODE !== 'resume') proc.stdin.end('go');
appendFileSync(journal, '');
console.log('ready');
setInterval(() => {}, 1 << 30);
