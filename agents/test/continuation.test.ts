import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { main, sessionLines } from '../hooks/unattended.mjs';
import { runChild } from './child.ts';
import { codexSourceFixture } from './codex-source-fixture.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const hook = (name: string) => fileURLToPath(new URL(`../hooks/${name}.mjs`, import.meta.url));
function session(cli: 'claude' | 'codex') {
  const dir = mkdtempSync(join(tmpdir(), 'cli-continuation-'));
  dirs.push(dir);
  const sid = `${cli}-continuation-real`;
  const { home } = codexSourceFixture(dir, sid);
  const env = {
    ...process.env,
    FLEET_UNATTENDED_DIR: dir,
    FLEET_WORK_RUNS_DIR: join(dir, 'runs'),
    FLEET_WORKER: '',
    FLEET_HEADLESS: '',
    CLAUDE_CODE_SESSION_ID: cli === 'claude' ? sid : '',
    CODEX_THREAD_ID: cli === 'codex' ? sid : '',
    CODEX_SESSION_ID: '',
    CODEX_HOME: home,
  };
  const input = { session_id: sid, cwd: dir };
  const run = (name: string, more: object = {}) =>
    runChild(process.execPath, [hook(name)], {
      cwd: dir,
      env,
      input: JSON.stringify({ ...input, ...more }),
    });
  const cliCommand = (...argv: string[]) => main(argv, { env, out: () => {}, err: () => {} });
  expect(cliCommand('on')).toBe(0);
  return {
    dir,
    sid,
    env,
    run,
    cliCommand,
    state: () => JSON.parse(readFileSync(join(dir, `${sid}.json`), 'utf8')),
  };
}

describe('各 CLI 真实 Stop → PostToolUse → 下一轮协议接续', { timeout: 0 }, () => {
  it.each(['claude', 'codex'] as const)('%s 仓库规定的直接验证命令连续工作六轮，不误报无进展', (cli) => {
    const s = session(cli);
    const commands = [
      'npx vitest run agents/test/continuation.test.ts',
      'node --test _tmp/verification.test.mjs',
      'node --test _tmp/root-round205-evidence-verify.mjs',
      'node --test _tmp/root-round205-list-verify.mjs',
      'node --test "_tmp/verification-check.mjs"',
      'node --test _tmp/verification.validate.ts',
    ];
    for (const command of commands) {
      expect(JSON.parse(s.run('stop').stdout).decision).toBe('block');
      s.run('continuation-progress', {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        tool_response: { exit_code: 0 },
      });
    }
    expect(readdirSync(join(s.dir, `${s.sid}.progress`))).toHaveLength(commands.length);
    expect(JSON.parse(s.run('stop').stdout).decision).toBe('block');
    expect(s.state()).toMatchObject({ state: 'on', streak: 1 });
  });

  it('直接验证失败、未结束、重复、查询状态和普通脚本不能续命', () => {
    const s = session('codex');
    const event = (command: string, response: object = { exit_code: 0 }) =>
      s.run('continuation-progress', {
        tool_name: 'Bash',
        tool_input: { command },
        tool_response: response,
      });
    for (const command of ['npx vitest run failed.test.ts', 'node --test _tmp/evidence-verify.mjs']) {
      event(command, { exit_code: 1 });
      event(command, { session_id: 123, status: 'running' });
      event(command, { interrupted: true });
    }
    event('npx vitest run verified.test.ts');
    event('npx vitest run verified.test.ts');
    expect(readdirSync(join(s.dir, `${s.sid}.progress`))).toHaveLength(1);
    expect(JSON.parse(s.run('stop').stdout).decision).toBe('block');
    for (const command of ['node _tmp/queue-read.mjs', 'node _tmp/pr-check.mjs', 'gh pr checks 1']) {
      event(command);
      event('npx vitest run verified.test.ts');
      s.run('stop');
    }
    expect(readdirSync(join(s.dir, `${s.sid}.progress`))).toHaveLength(1);
    expect(s.state().state).toBe('paused');
  });

  it('故障暂停只停自动接续，开场仍要求执行新用户任务，且不重置旧窗口', () => {
    const s = session('codex');
    for (let i = 0; i < 4; i++) s.run('stop');
    const before = s.state();
    expect(before.state).toBe('paused');
    const lines = sessionLines({ dir: s.dir, sessionId: s.sid }).join('\n');
    expect(lines).toContain('新请求照常执行、检查和验证');
    expect(lines).not.toContain('这一轮可以结束');
    expect(s.state()).toEqual(before);
    expect(s.run('stop').stdout.trim()).toBe('');
  });

  it.each(['claude', 'codex'] as const)(
    '%s 连续六轮有效工作不被三次上限误停，完成结果一次性可消费，done正常收尾',
    (cli) => {
      const s = session(cli);
      for (let turn = 0; turn < 6; turn++) {
        const stop = s.run('stop', {
          hook_event_name: 'Stop',
          stop_hook_active: turn > 0,
          background_tasks: [{ id: 'worker', type: 'subagent', status: 'running' }],
        });
        expect(stop.status).toBe(0);
        const nextPrompt = JSON.parse(stop.stdout);
        expect(nextPrompt.decision).toBe('block');
        expect(nextPrompt.reason).toContain('先收结果');
        // 消费续轮指令后完成真实文件写入，再以成功工具事件登记（不是调工具前的意图）。
        writeFileSync(join(s.dir, 'work.txt'), `finished step ${turn}`);
        expect(
          s.run('continuation-progress', {
            hook_event_name: 'PostToolUse',
            tool_name: 'Write',
            tool_input: { file_path: join(s.dir, 'work.txt'), content: `finished step ${turn}` },
            tool_response: { success: true },
          }).status,
        ).toBe(0);
      }
      expect(s.state().state).toBe('on');
      const runDir = join(s.env.FLEET_WORK_RUNS_DIR, 'job-1');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'spec.json'), JSON.stringify({ dispatcher: s.sid, issue: 2941 }));
      writeFileSync(
        join(runDir, 'result.json'),
        JSON.stringify({ state: 'done', issue: 2941, summary: 'verified background result', attempts: 1 }),
      );
      // 旧 async watcher 即使已写 reported，同步接续仍必须有可消费的结果。
      writeFileSync(join(runDir, 'reported'), 'old wake sent');
      const resultPrompt = JSON.parse(s.run('stop').stdout);
      expect(resultPrompt.decision).toBe('block');
      expect(resultPrompt.reason).toContain('verified background result');
      expect(JSON.parse(s.run('stop').stdout).reason).not.toContain('verified background result');
      expect(s.cliCommand('done', '结果已消费且验收')).toBe(0);
      expect(s.run('stop').stdout.trim()).toBe('');
    },
  );

  it.each(['claude', 'codex'] as const)(
    '%s sleep/查PR/重复验证不能续命；明确paused，off和needs-you放行，机器工人不被困',
    (cli) => {
      const s = session(cli);
      for (let i = 0; i < 3; i++) {
        s.run('continuation-progress', {
          tool_name: 'Bash',
          tool_input: { command: 'sleep 1; gh pr view 1' },
          tool_response: {},
        });
        expect(JSON.parse(s.run('stop').stdout).decision).toBe('block');
      }
      expect(JSON.parse(s.run('stop').stdout).systemMessage).toContain('接续失败');
      expect(s.state().state).toBe('paused');
      expect(s.cliCommand('on')).toBe(0);
      expect(s.cliCommand('needs-you', '需要新花钱')).toBe(0);
      expect(s.run('stop').stdout.trim()).toBe('');
      expect(s.cliCommand('on')).toBe(0);
      expect(s.run('stop', { agent_id: 'machine-child' }).stdout.trim()).toBe('');
      expect(s.cliCommand('off')).toBe(0);
      expect(s.run('stop').stdout.trim()).toBe('');
    },
  );

  it('相同成功验证只登记一次，失败或状态查询不算进展', () => {
    const s = session('codex');
    const event = {
      tool_name: 'Bash',
      tool_input: { command: 'pnpm typecheck' },
      tool_response: { exit_code: 0 },
    };
    s.run('continuation-progress', event);
    s.run('continuation-progress', event);
    expect(readdirSync(join(s.dir, `${s.sid}.progress`))).toHaveLength(1);
    s.run('continuation-progress', {
      ...event,
      tool_input: { command: 'pnpm test failed' },
      tool_response: { exit_code: 1 },
    });
    expect(readdirSync(join(s.dir, `${s.sid}.progress`))).toHaveLength(1);
    s.run('continuation-progress', {
      ...event,
      tool_input: { command: 'pnpm test background', run_in_background: true },
      tool_response: { task_id: 'running' },
    });
    s.run('continuation-progress', {
      tool_name: 'wait',
      tool_input: { ids: ['worker'] },
      tool_response: { timed_out: true, status: {} },
    });
    expect(readdirSync(join(s.dir, `${s.sid}.progress`))).toHaveLength(1);
    s.run('continuation-progress', {
      tool_name: 'wait',
      tool_input: { ids: ['worker'] },
      tool_response: { timed_out: false, status: { worker: { completed: 'verified result' } } },
    });
    s.run('continuation-progress', {
      tool_name: 'TaskOutput',
      tool_input: { task_id: 'claude-worker', block: true },
      tool_response: { task_id: 'claude-worker', status: 'completed', output: 'verified result' },
    });
    expect(readdirSync(join(s.dir, `${s.sid}.progress`))).toHaveLength(3);
  });

  it('开场读回只给本会话；坏的工人记录明确没查成，不伪造成队列已空', () => {
    const s = session('codex');
    const start = JSON.parse(s.run('continuation-start').stdout);
    expect(start.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(start.hookSpecificOutput.additionalContext).toContain('无人值守开着');
    expect(s.run('continuation-start', { session_id: 'another-session' }).stdout).toBe('');
    const dir = join(s.env.FLEET_WORK_RUNS_DIR, 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'spec.json'), '{invalid JSON');
    const next = JSON.parse(s.run('stop').stdout);
    expect(next.decision).toBe('block');
    expect(next.reason).toContain('后台完成结果没查成');
    expect(s.state().state).toBe('on');
  });
});
