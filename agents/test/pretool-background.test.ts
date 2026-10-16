// 调工具前钩子（agents/hooks/pretool.mjs）：前台等太久的改成后台跑（决定 0093）。
// 以前前台等超过 60 秒的拦下让模型自己加 run_in_background 重试（两周 51 次，每次多一轮）；现在 Claude Code 的
// Bash、PowerShell 写了 timeout 超过 60 秒又没后台跑的，钩子用 updatedInput 加上 run_in_background: true 放行，
// 不带 permissionDecision（改写后的输入照常走权限确认）。别家的输入不改。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

interface Verdict {
  code: number;
  message?: string;
  updatedInput?: Record<string, unknown>;
  context?: string;
  approve?: boolean;
}
interface HookLib {
  decide(raw: string, fallbackCwd?: string): Verdict;
  longForeground(toolInput: unknown): boolean;
  FOREGROUND_MAX_MS: number;
}

const HOOK = fileURLToPath(new URL('../hooks/pretool.mjs', import.meta.url));
const lib = (await import(pathToFileURL(HOOK).href)) as HookLib;

const cc = (tool: string, toolInput: Record<string, unknown>) =>
  JSON.stringify({
    session_id: 's1',
    transcript_path: '/home/u/.claude/projects/x/s1.jsonl',
    cwd: '/work/other',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: 'toolu_01',
  });
const bare = (tool: string, toolInput: Record<string, unknown>) =>
  JSON.stringify({ tool_name: tool, tool_input: toolInput, cwd: '/work/other' });

describe('前台等太久：改成后台跑', () => {
  it('上限是 60 秒', () => {
    expect(lib.FOREGROUND_MAX_MS).toBe(60_000);
  });

  it.each([
    ['Bash', { command: 'pnpm test', timeout: 420_000, description: '跑测试' }],
    ['Bash', { command: 'gh pr checks 12 --watch', timeout: 600_000 }],
    ['PowerShell', { command: 'pnpm build', timeout: 61_000 }],
  ])('%s %j：放行，updatedInput 原样带上并加 run_in_background: true，不替它跳过权限', (tool, input) => {
    const v = lib.decide(cc(tool, input));
    expect(v.code).toBe(0);
    expect(v.updatedInput).toEqual({ ...input, run_in_background: true });
    expect(v.approve).toBeFalsy();
    expect(v.context).toContain('后台');
  });

  it.each([
    ['Bash', { command: 'pnpm test', timeout: 60_000 }],
    ['Bash', { command: 'pnpm test', timeout: 30_000 }],
    ['Bash', { command: 'pnpm test' }],
    ['Bash', { command: 'pnpm test', timeout: 420_000, run_in_background: true }],
    ['Bash', { command: 'pnpm test', timeout: '420000' }],
  ])('%s %j：不改写', (tool, input) => {
    expect(lib.decide(cc(tool, input))).toEqual({ code: 0 });
  });

  it('子代理的调用（输入带 agent_id）：timeout 超过 60 秒也原样放行，不改后台', () => {
    const raw = JSON.stringify({
      ...JSON.parse(cc('Bash', { command: 'gh pr checks 12 --watch', timeout: 600_000 })),
      agent_id: 'agent-abc123',
      agent_type: 'general-purpose',
    });
    expect(lib.decide(raw)).toEqual({ code: 0 });
  });

  it('主线程的调用（没有 agent_id）：照旧改成后台', () => {
    const v = lib.decide(cc('Bash', { command: 'gh pr checks 12 --watch', timeout: 600_000 }));
    expect(v.updatedInput).toEqual({
      command: 'gh pr checks 12 --watch',
      timeout: 600_000,
      run_in_background: true,
    });
  });

  it('别家的输入：不改写（不知道它认不认 updatedInput）', () => {
    expect(lib.decide(bare('Bash', { command: 'pnpm test', timeout: 420_000 }))).toEqual({ code: 0 });
  });

  it('真的钩子进程：stdout 只有 updatedInput 和说明，没有 permissionDecision，退出码 0', () => {
    const r = runChild(process.execPath, [HOOK], {
      input: cc('Bash', { command: 'pnpm test', timeout: 420_000, description: 'x' }),
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput?: Record<string, unknown> };
    const h = out.hookSpecificOutput ?? {};
    expect(h.hookEventName).toBe('PreToolUse');
    expect(h.permissionDecision).toBeUndefined();
    expect(h.updatedInput).toEqual({
      command: 'pnpm test',
      timeout: 420_000,
      description: 'x',
      run_in_background: true,
    });
    expect(String(h.additionalContext)).toContain('后台');
  });
});
