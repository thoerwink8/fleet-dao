// 假执行体：照脚本回放一份真跑的过程记录，或者故意卡住、留下子进程，给插头的起停测试用。
// 用法：node fake-agent.ts <脚本.json> [执行体参数……]；脚本字段见 FakeScript。
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export interface FakeScript {
  /** 收到的 stdin 写到这里。能写出来就说明插头把 stdin 关了（不关的话这里会一直等）。 */
  stdinTo?: string;
  argvTo?: string;
  envTo?: string;
  /** 先往 stderr 打一句（模拟 reclaude 的「Syncing config…」）。 */
  stderr?: string;
  firstLineDelayMs?: number;
  /** 要回放的过程记录文件。 */
  replay?: string;
  /** 只回放前 N 行。 */
  replayLines?: number;
  lineDelayMs?: number;
  /** 回放完之后：退出（默认）、卡住、带着子进程卡住、自己退出但留下子进程。 */
  after?: 'exit' | 'hang' | 'hang-with-child' | 'exit-leaving-child';
  childPidTo?: string;
  exitCode?: number;
  ignoreSigterm?: boolean;
}

const script = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as FakeScript;
if (script.ignoreSigterm) process.on('SIGTERM', () => {});

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
if (script.stdinTo) writeFileSync(script.stdinTo, Buffer.concat(chunks));
if (script.argvTo) writeFileSync(script.argvTo, JSON.stringify(process.argv.slice(3)));
if (script.envTo) writeFileSync(script.envTo, JSON.stringify(process.env));

if (script.stderr) process.stderr.write(`${script.stderr}\n`);
if (script.firstLineDelayMs) await sleep(script.firstLineDelayMs);
if (script.replay) {
  const lines = readFileSync(script.replay, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  for (const line of lines.slice(0, script.replayLines ?? lines.length)) {
    process.stdout.write(`${line}\n`);
    if (script.lineDelayMs) await sleep(script.lineDelayMs);
  }
}

const after = script.after ?? 'exit';
if (after === 'hang-with-child' || after === 'exit-leaving-child') {
  // 子进程继承 stdout：它不死，插头那边的输出流就关不上
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (script.childPidTo) writeFileSync(script.childPidTo, String(child.pid));
}
if (after === 'exit' || after === 'exit-leaving-child') {
  process.exitCode = script.exitCode ?? 0;
  if (after === 'exit-leaving-child') process.exit(script.exitCode ?? 0);
} else {
  setInterval(() => {}, 1000);
}
