// 子代理归属写在本机（FLEET_DAO_HOME），不进仓。
// 覆盖：写入与读回；pnpm agents:stop 找到并停、记录缺失、会话已不在。不按启动时间猜，不杀进程。
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

interface Owner {
  agentId: string;
  sessionId: string;
  pid: number;
  worktree: string;
  at: string;
}
interface OwnerLib {
  ownersPath(home: string): string;
  stopPath(home: string, sessionId: string): string;
  readOwners(home: string): Owner[] | { error: string };
  appendOwner(home: string, row: Owner): void;
  recordDispatch(
    input: unknown,
    deps: { home: string; pid: number; now: () => Date },
  ): { recorded: boolean; why?: string };
  agentsStop(
    argv: string[],
    deps: {
      home: string;
      alive?: (row: Owner) => boolean;
      send?: (row: Owner) => void;
      now?: () => Date;
    },
  ): { code: number; message: string };
  takeStopNotice(sessionId: string, home: string): string | null;
}

const HOOK = fileURLToPath(new URL('../hooks/subagent-owner.mjs', import.meta.url));
const PROGRESS = fileURLToPath(new URL('../hooks/continuation-progress.mjs', import.meta.url));
const lib = (await import(pathToFileURL(HOOK).href)) as OwnerLib;

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'subagent-owner-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const at = '2026-11-06T08:00:00.000Z';
const row = (over: Partial<Owner> = {}): Owner => ({
  agentId: 'agent-1',
  sessionId: 'sess-old',
  pid: 4242,
  worktree: '/work/fleet-dao/.claude/worktrees/3911-stop',
  at,
  ...over,
});

describe('归属写入与读取', () => {
  it('派工回执落一行，读回 agentId、会话、进程号、工作树、派出时间', () => {
    const home = tmp();
    const now = () => new Date(at);
    const recorded = lib.recordDispatch(
      {
        session_id: 'sess-old',
        cwd: '/work/fleet-dao/.claude/worktrees/3911-stop',
        tool_name: 'Agent',
        tool_response: { agentId: 'agent-1' },
      },
      { home, pid: 4242, now },
    );
    expect(recorded).toEqual({ recorded: true });
    const rows = lib.readOwners(home);
    expect(rows).toEqual([row()]);
  });

  it('没有文件是空；坏行跳过', () => {
    const home = tmp();
    expect(lib.readOwners(home)).toEqual([]);
    lib.appendOwner(home, row());
    appendFileSync(lib.ownersPath(home), 'not-json\n{"agentId":1}\n');
    expect(lib.readOwners(home)).toEqual([row()]);
  });

  it('子代理自己的工具调用、没有 agentId 的派工不记', () => {
    const home = tmp();
    const now = () => new Date(at);
    expect(
      lib.recordDispatch(
        { session_id: 's', cwd: '/w', tool_name: 'Agent', agent_id: 'child', tool_response: { agentId: 'x' } },
        { home, pid: 1, now },
      ).recorded,
    ).toBe(false);
    expect(
      lib.recordDispatch({ session_id: 's', cwd: '/w', tool_name: 'Bash', tool_response: { agentId: 'x' } }, { home, pid: 1, now })
        .recorded,
    ).toBe(false);
    expect(lib.readOwners(home)).toEqual([]);
  });
});

describe('agents:stop', () => {
  it('找到归属会话并停：发给记下的会话，不杀进程', () => {
    const home = tmp();
    lib.appendOwner(home, row());
    const sent: Owner[] = [];
    const result = lib.agentsStop(['agent-1'], {
      home,
      alive: () => true,
      send: (r) => sent.push(r),
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain('已向会话 sess-old 发出停止（agent-1）');
    expect(sent).toEqual([row()]);
    const byTree = lib.agentsStop(['/work/fleet-dao/.claude/worktrees/3911-stop'], {
      home,
      alive: () => true,
      send: () => {},
    });
    expect(byTree.code).toBe(0);
    const src = readFileSync(HOOK, 'utf8');
    expect(src).toContain('process.kill(row.pid, 0)');
    expect(src).not.toMatch(/process\.kill\([^)]*,\s*['"]SIG/);
  });

  it('记录缺失：退出码非 0，写明停不了', () => {
    const result = lib.agentsStop(['missing-agent'], { home: tmp(), alive: () => true, send: () => {} });
    expect(result.code).not.toBe(0);
    expect(result.message).toBe('停不了：没有这条归属记录');
  });

  it('会话已不在：退出码非 0，不发停止', () => {
    const home = tmp();
    lib.appendOwner(home, row());
    let sent = 0;
    const result = lib.agentsStop(['agent-1'], {
      home,
      alive: () => false,
      send: () => {
        sent += 1;
      },
    });
    expect(result.code).not.toBe(0);
    expect(result.message).toBe('停不了：会话已不在');
    expect(sent).toBe(0);
  });
});

describe('命令与钩子', () => {
  const cli = (home: string, arg: string) =>
    runChild(process.execPath, [HOOK, arg], { env: { ...process.env, FLEET_DAO_HOME: home } });

  it('命令找到并停：退出码 0，停止写给那个会话', () => {
    const home = tmp();
    lib.appendOwner(home, row({ pid: process.pid }));
    const r = cli(home, 'agent-1');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('已向会话 sess-old 发出停止（agent-1）');
    expect(lib.takeStopNotice('sess-old', home)).toContain('TaskStop 停掉 agent-1');
    expect(lib.takeStopNotice('sess-old', home)).toBeNull();
  });

  it('命令在记录缺失、会话已不在时退出码非 0', () => {
    const home = tmp();
    const missing = cli(home, 'nope');
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('停不了：没有这条归属记录');
    lib.appendOwner(home, row({ pid: 2_147_483_646 }));
    const stopped = cli(home, '/work/fleet-dao/.claude/worktrees/3911-stop');
    expect(stopped.status).not.toBe(0);
    expect(stopped.stderr).toContain('停不了：会话已不在');
  });

  it('PostToolUse 派出成功时把归属写入本机', () => {
    const home = tmp();
    const r = runChild(process.execPath, [PROGRESS], {
      env: { ...process.env, FLEET_DAO_HOME: home, FLEET_HEADLESS: '1' },
      input: JSON.stringify({
        session_id: 'sess-hook',
        cwd: '/work/tree',
        tool_name: 'Task',
        tool_response: 'agentId: agent-hook',
      }),
    });
    expect(r.status).toBe(0);
    const rows = lib.readOwners(home);
    expect(Array.isArray(rows)).toBe(true);
    if (!Array.isArray(rows)) return;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: 'agent-hook', sessionId: 'sess-hook', worktree: '/work/tree' });
    expect(rows[0]?.pid).toBeGreaterThan(0);
    expect(rows[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
