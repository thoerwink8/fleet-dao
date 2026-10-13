// N2：派子代理（Agent、Task）时 model 写 fable、claude-fable-*、或带 [1m] 后缀，调工具前钩子拦；别的型号、没写 model 放行。
// 拦的位置在入口 backgroundOnly 早退之前（decide 对 Agent 一进来就放行），所以要真起钩子进程测。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

const HOOK = fileURLToPath(new URL('../hooks/pretool.mjs', import.meta.url));
const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function hook(tool: string, toolInput: Record<string, unknown>) {
  const state = mkdtempSync(join(tmpdir(), 'pretool-n2-'));
  made.push(state);
  return runChild(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: toolInput, cwd: state, session_id: 's-n2' }),
    env: { ...process.env, FLEET_UNATTENDED_DIR: state, CLAUDE_CODE_SESSION_ID: '' },
  });
}

describe('N2 子代理不派 fable', { timeout: 0 }, () => {
  it.each(['fable', 'claude-fable-5', 'Claude-Fable-5-1', 'opus[1m]', 'claude-opus-5-5[1m]', 'sonnet[1m]'])(
    'Agent model=%s → 拦，退出码 2',
    (model) => {
      const r = hook('Agent', { prompt: 'x', subagent_type: 'general-purpose', model });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(model);
    },
  );

  it('Task 也一样拦', () => {
    expect(hook('Task', { prompt: 'x', model: 'fable' }).status).toBe(2);
  });

  it.each(['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'inherit'])('Agent model=%s → 放行', (model) => {
    expect(hook('Agent', { prompt: 'x', subagent_type: 'general-purpose', model }).status).toBe(0);
  });

  it('不写 model 放行；别的工具的 model 字段不管', () => {
    expect(hook('Agent', { prompt: 'x', subagent_type: 'general-purpose' }).status).toBe(0);
    expect(hook('Bash', { command: 'echo fable', model: 'fable' }).status).toBe(0);
  });
});
