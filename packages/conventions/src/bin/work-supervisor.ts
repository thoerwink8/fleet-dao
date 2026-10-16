// pnpm work run 派出的看护进程（单 #2761）：node packages/conventions/src/bin/work-supervisor.ts <运行目录>。
// 由 agents/local-sessions/detach.mjs 起（Windows 走 WMI，不在聊天进程的进程树里），看护一张单的无头工人到终态。判法见 ../work-run.ts。
// WMI 起的进程拿不到派的人的环境变量：PATH、代理从 spec.json 的 env 补上。日志写 <运行目录>/supervisor.log。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghRunner } from '../issue-new.ts';
import { liveClaimsPost, readClaimsEndpoint, work } from '../work.ts';
import { removeLease, writeLease } from '../work-queue.ts';
import { type AttemptOutput, type RunSpec, readJson, runFiles, superviseRun } from '../work-run.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('用法：node work-supervisor.ts <运行目录>');
  process.exit(1);
}
const logFile = join(dir, 'supervisor.log');
const log = (line: string) => {
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // 日志写不成不影响看护
  }
};

const spec = readJson<RunSpec>(runFiles(dir).spec);
if (!spec) {
  log('spec.json 不在，退出');
  process.exit(1);
}
Object.assign(process.env, spec.env);

function runWorker(o: {
  args: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string>;
  outFile: string;
  errFile: string;
}): Promise<AttemptOutput> {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    // 不带聊天会话的痕迹（非 Windows 上看护进程继承了派的人的环境）：工人是自己一个会话，不是谁的子会话
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...o.env })) {
      if (v !== undefined && !/^(?:CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|MIRASIM_)/.test(k)) env[k] = v;
    }
    const child = spawn(spec?.reclaude ?? 'reclaude', o.args, {
      cwd: o.cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.on('error', () => {});
    child.stdin.end(o.stdin);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b;
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b;
    });
    child.on('error', (e) => {
      stderr += `\n起不来：${e.message}`;
    });
    child.on('close', (code) => {
      try {
        writeFileSync(o.outFile, stdout);
        writeFileSync(o.errFile, stderr);
      } catch {
        // 落不了盘照样按内存里的判
      }
      done({ code, stdout, stderr });
    });
  });
}

async function renew(): Promise<{ ok: boolean; text: string }> {
  const lines: string[] = [];
  const code = await work(['renew', String(spec?.issue)], {
    // 在工人的工作树里问 gh（派的那份检出可能是会被删掉的工作树）
    gh: ghRunner(spec?.worktree ?? process.cwd()),
    post: liveClaimsPost(() => readClaimsEndpoint()),
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    leases: { write: (rec) => writeLease(rec), remove: (repo, issue) => removeLease(repo, issue) },
  });
  return { ok: code === 0, text: lines.join('；') };
}

try {
  const r = await superviseRun(dir, {
    now: () => new Date(),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    pid: process.pid,
    newSessionId: () => randomUUID(),
    runWorker,
    renew,
    repeat: (fn, ms) => {
      const t = setInterval(fn, ms);
      return () => clearInterval(t);
    },
    log,
  });
  log(r ? `终了：${r.state}` : '别的看护进程在管，退出');
  process.exitCode = 0;
} catch (e) {
  log(`看护进程自己出错了：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
}
