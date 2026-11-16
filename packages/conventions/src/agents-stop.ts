// pnpm agents:stop <工作树|agentId>（单 #3911）：按本机归属找到会话并发停止。
// 记录缺失、会话已不在：退出码非 0，明说「停不了：原因」。不按启动时间猜、不杀进程。
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const ownership = (await import(pathToFileURL(join(root, 'agents/hooks/subagent-ownership.mjs')).href)) as {
  findOwnership(
    home: string,
    key: string,
  ): { agentId: string; sessionId: string; pid: number; worktree: string; at: string } | null;
  readOwnership(home: string): Array<{
    agentId: string;
    sessionId: string;
    pid: number;
    worktree: string;
    at: string;
  }>;
};

export type AgentsStopDeps = {
  home: string;
  out: (line: string) => void;
  err: (line: string) => void;
  sessions: () => Array<{ id: string; alive: boolean }>;
  deliver: (sessionId: string, text: string) => { ok: boolean; why?: string };
};

/** signal 0 只探进程还在不在，不杀。EPERM 表示进程在，只是没权限发信号。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = typeof e === 'object' && e !== null && 'code' in e ? e.code : undefined;
    return code === 'EPERM';
  }
}

/** 按归属发停止。找不到记录、会话不在、送不到，都是非 0。 */
export function agentsStop(args: string[], deps: AgentsStopDeps): number {
  const key = args[0];
  if (typeof key !== 'string' || key.trim() === '') {
    deps.err('停不了：没给工作树或 agentId');
    return 1;
  }
  const row = ownership.findOwnership(deps.home, key.trim());
  if (!row) {
    deps.err('停不了：记录缺失');
    return 1;
  }
  const alive = deps.sessions().some((s) => s.id === row.sessionId && s.alive);
  if (!alive) {
    deps.err('停不了：会话已不在');
    return 1;
  }
  const text = `停掉子代理 ${row.agentId}：对它调用 TaskStop。`;
  const sent = deps.deliver(row.sessionId, text);
  if (!sent.ok) {
    deps.err(`停不了：${sent.why ?? '停止送不到归属会话'}`);
    return 1;
  }
  deps.out(`已请会话 ${row.sessionId} 停掉 ${row.agentId}`);
  return 0;
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const a = resolve(argv1);
  const b = resolve(fileURLToPath(import.meta.url));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isMain()) {
  const home = process.env.FLEET_DAO_HOME || join(homedir(), '.fleet-dao');
  let code = 1;
  try {
    code = agentsStop(process.argv.slice(2), {
      home,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      sessions: () => ownership.readOwnership(home).map((r) => ({ id: r.sessionId, alive: isAlive(r.pid) })),
      deliver: (sessionId, text) => {
        if (!/^[\w-]{4,128}$/.test(sessionId)) return { ok: false, why: '会话号不能当作文件名' };
        try {
          const dir = join(home, 'subagent-stop-inbox');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${sessionId}.txt`), `${text}\n`);
          return { ok: true };
        } catch (e) {
          return { ok: false, why: e instanceof Error ? e.message : String(e) };
        }
      },
    });
  } catch (e) {
    console.error(`停不了：归属记录读不了（${e instanceof Error ? e.message : String(e)}）`);
    code = 1;
  }
  process.exitCode = code;
}
