// 假执行体：照脚本回放一份真跑的过程记录，或者故意卡住、留下子进程，给插头的起停测试用。
// 用法：node fake-agent.ts <脚本.json> [执行体参数……]；脚本字段见 FakeScript。
import { spawn } from 'node:child_process';
import { fstatSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export interface FakeScript {
  /** 收到的 stdin 写到这里。能写出来就说明插头把 stdin 关了（不关的话这里会一直等）。 */
  stdinTo?: string;
  argvTo?: string;
  envTo?: string;
  /** 进程身份（uid、gid、附加组）写到这里：验会话用户降权用。 */
  idTo?: string;
  /** stdin 是什么（fifo / socket / file / other）写到这里：grok 要的是真管道。 */
  stdinKindTo?: string;
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
  /**
   * 子进程 setsid 自成一组、不接我们的输出流——Claude 的 Bash 工具就是这样起命令的（VPS 实测）：
   * 只杀执行体的进程组够不着它，执行体一退它还被过继给 init。
   */
  childDetached?: boolean;
  childIgnoresSigterm?: boolean;
  /** 子进程连环境也清空（会话标记跟着没了）：没有 scope 时谁也找不到它，只有 cgroup 兜得住。 */
  childCleanEnv?: boolean;
  exitCode?: number;
  ignoreSigterm?: boolean;
}

const script = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8')) as FakeScript;
if (script.ignoreSigterm) process.on('SIGTERM', () => {});
if (script.stdinKindTo) {
  const st = fstatSync(0);
  writeFileSync(
    script.stdinKindTo,
    st.isFIFO() ? 'fifo' : st.isSocket() ? 'socket' : st.isFile() ? 'file' : 'other',
  );
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
if (script.stdinTo) writeFileSync(script.stdinTo, Buffer.concat(chunks));
if (script.argvTo) writeFileSync(script.argvTo, JSON.stringify(process.argv.slice(3)));
if (script.envTo) writeFileSync(script.envTo, JSON.stringify(process.env));
if (script.idTo && process.getuid && process.getgid && process.getgroups) {
  writeFileSync(
    script.idTo,
    JSON.stringify({ uid: process.getuid(), gid: process.getgid(), groups: process.getgroups() }),
  );
}

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
  const code = `${script.childIgnoresSigterm ? "process.on('SIGTERM', () => {});" : ''}setInterval(() => {}, 1000);`;
  const child = script.childDetached
    ? spawn(process.execPath, ['-e', code], {
        detached: true,
        stdio: 'ignore',
        ...(script.childCleanEnv ? { env: {} } : {}),
      })
    : // 子进程继承 stdout：它不死，插头那边的输出流就关不上
      spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (script.childDetached) child.unref();
  if (script.childPidTo) writeFileSync(script.childPidTo, String(child.pid));
}
if (after === 'exit' || after === 'exit-leaving-child') {
  process.exitCode = script.exitCode ?? 0;
  if (after === 'exit-leaving-child') process.exit(script.exitCode ?? 0);
} else {
  setInterval(() => {}, 1000);
}
