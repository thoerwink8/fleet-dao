import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

type Recovery = (input: unknown, opts?: Record<string, unknown>) => Promise<string | null>;
const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
const { backgroundRecoveryContext } = (await import(
  pathToFileURL(`${HOOKS}background-recovery.mjs`).href
)) as { backgroundRecoveryContext: Recovery };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T = (iso: string) => Date.parse(iso);
const NOW = T('2026-10-16T02:30:00Z'); // 北京 10:30
const STEER_AT = T('2026-10-16T02:25:10Z'); // 北京 10:25
const STEER_TEXT = '你没收到的问题：为什么门禁红了';

/** 一个 Mirasim 会话 dir-c（原生号 c-1）：10:00 一轮、10:20 一轮，10:25 这一轮中途发了一条引导，prompt-log 里只有两轮开头 */
function world(extraSteers: Array<{ text: string; at: number }> = []) {
  const home = mkdtempSync(join(tmpdir(), 'inbox-backgroundRecoveryContext-'));
  dirs.push(home);
  const d = join(home, '.mirasim', 'sessions', 'claude', 'dir-c');
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, 'record.json'),
    JSON.stringify({ workdir: 'D:\\frank\\fleet-dao', nativeSessionId: 'c-1' }),
  );
  const turns = [
    { sessionId: 'c-1', startedAt: T('2026-10-16T02:00:00Z'), prompt: '开始做 2382' },
    {
      sessionId: 'c-1',
      startedAt: T('2026-10-16T02:20:00Z'),
      prompt: '接着做',
      steers: [{ text: STEER_TEXT, at: STEER_AT }, ...extraSteers],
    },
  ];
  writeFileSync(join(d, 'turns.jsonl'), turns.map((t) => `${JSON.stringify(t)}\n`).join(''));
  const log = join(home, '.fleet-dao', 'prompt-log');
  mkdirSync(log, { recursive: true });
  writeFileSync(
    join(log, '2026-10-16.jsonl'),
    [
      { at: '2026-10-16T02:00:01Z', sessionId: 'c-1', prompt: '开始做 2382' },
      { at: '2026-10-16T02:20:01Z', sessionId: 'c-1', prompt: '接着做' },
    ]
      .map((r) => `${JSON.stringify(r)}\n`)
      .join(''),
  );
  const env = {};
  const input = (extra: Record<string, unknown> = {}) => ({ session_id: 'c-1', tool_name: 'Bash', ...extra });
  return { home, env, input, turnsFile: join(d, 'turns.jsonl'), logFile: join(log, '2026-10-16.jsonl') };
}

/** Claude Code 重启后写进 transcript 的那条通知（真样本：type user、origin.kind=task-notification、content 是字符串） */
function restartNote(taskId: string, what: string, uuid: string) {
  return {
    type: 'user',
    uuid,
    origin: { kind: 'task-notification' },
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>stopped</status>\n<summary>${what} didn't finish before the previous session ended</summary>\n<note>No completion record was found for it in the previous session.</note>\n</task-notification>`,
    },
  };
}

describe('后台恢复保留原任务与编号', () => {
  it('上一会话结束时停掉了后台代理：列代理编号和原任务，提示按编号用 SendMessage 续上', async () => {
    const w = world();
    const transcript = join(w.home, 'restart.jsonl');
    writeFileSync(
      transcript,
      [
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_agent',
                name: 'Agent',
                input: {
                  description: '查门禁根因',
                  prompt: '检查 CI 为什么红，并给出修复建议',
                  run_in_background: true,
                },
              },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', content: 'Async agent launched successfully.\nagentId: agent-42' },
            ],
          },
        },
        restartNote('agent-42', 'Background agent "查门禁根因"', 'n-1'),
      ]
        .map((r) => `${JSON.stringify(r)}\n`)
        .join(''),
    );
    const first = await backgroundRecoveryContext(w.input({ transcript_path: transcript }), {
      home: w.home,
      env: w.env,
      now: NOW,
    });
    expect(first).toContain('agent-42');
    expect(first).toContain('检查 CI 为什么红，并给出修复建议');
    expect(first).toContain('SendMessage');
    expect(
      await backgroundRecoveryContext(w.input({ transcript_path: transcript }), {
        home: w.home,
        env: w.env,
        now: NOW + 61_000,
      }),
    ).toBeNull();
  });

  it('上一会话结束时只有后台命令：列出命令，是否重跑留给会话判断', async () => {
    const w = world();
    const transcript = join(w.home, 'restart-command.jsonl');
    writeFileSync(
      transcript,
      [
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_bash',
                name: 'Bash',
                input: { command: 'pnpm check', description: '跑全套检查', run_in_background: true },
              },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', content: 'Background task started; taskId: cmd-7' }],
          },
        },
        restartNote('cmd-7', 'Background shell command', 'n-1'),
      ]
        .map((r) => `${JSON.stringify(r)}\n`)
        .join(''),
    );
    const out = await backgroundRecoveryContext(w.input({ transcript_path: transcript }), {
      home: w.home,
      env: w.env,
      now: NOW,
    });
    expect(out).toContain('后台命令 cmd-7');
    expect(out).toContain('pnpm check');
    expect(out).toContain('要不要重跑，由本会话判断');
    expect(out).not.toContain('SendMessage');
  });
});

// 单 #2802：重启提示只认 Claude Code 自己发的重启通知（type user、origin.kind=task-notification、summary 里带原话），
// 只列通知前派出且没收到完成通知的后台任务，同一次重启只提醒一次。
describe('重启补回后台任务的提示不误报（#2802）', () => {
  const launch = (id: string, desc: string) => ({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Agent',
          input: { description: desc, prompt: `${desc}的详细要求`, run_in_background: true },
        },
      ],
    },
  });
  const receipt = (toolUseId: string, agentId: string, isError = false) => ({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          ...(isError ? { is_error: true } : {}),
          content: isError ? 'blocked by hook' : `Async agent launched successfully.\nagentId: ${agentId}`,
        },
      ],
    },
  });
  const done = (taskId: string, uuid: string) => ({
    type: 'user',
    uuid,
    origin: { kind: 'task-notification' },
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n<summary>Agent done</summary>\n</task-notification>`,
    },
  });
  const run = async (rows: unknown[], at = NOW) => {
    const w = world();
    const transcript = join(w.home, 't.jsonl');
    const write = (r: unknown[]) =>
      writeFileSync(transcript, r.map((x) => `${JSON.stringify(x)}\n`).join(''));
    write(rows);
    const out = await backgroundRecoveryContext(w.input({ transcript_path: transcript }), {
      home: w.home,
      env: w.env,
      now: at,
    });
    return { w, transcript, write, out };
  };

  it('transcript 里只有钩子上次注入的上下文、助手引用了那句话：不触发', async () => {
    const { out } = await run([
      {
        type: 'attachment',
        attachment: {
          type: 'hook_additional_context',
          content: ["Claude Code 提示 “didn't finish before the previous session ended”"],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: "它说 didn't finish before the previous session ended" }],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'text', text: "引用：didn't finish before the previous session ended" }],
        },
      },
      launch('toolu_a', '正在跑的活'),
      receipt('toolu_a', 'agent-live'),
    ]);
    expect(out).toBeNull();
    expect(out ?? '').not.toContain('SendMessage');
    expect(out ?? '').not.toContain('agent-live');
  });

  it('通知前派了 A、通知后派了 B：只列 A，输出里不带英文原句', async () => {
    const { out } = await run([
      launch('toolu_a', '任务甲'),
      receipt('toolu_a', 'agent-a'),
      restartNote('agent-a', 'Background agent "任务甲"', 'n-1'),
      launch('toolu_b', '任务乙'),
      receipt('toolu_b', 'agent-b'),
    ]);
    expect(out).toContain('agent-a');
    expect(out).not.toContain('agent-b');
    expect(out).not.toContain('任务乙');
    expect(out).not.toMatch(/previous session ended/i);
  });

  it('同一次重启只提醒一次：之后再派任务、transcript 变长也不再触发；新的一次重启才再提醒', async () => {
    const base = [
      launch('toolu_a', '任务甲'),
      receipt('toolu_a', 'agent-a'),
      restartNote('agent-a', 'Agent', 'n-1'),
    ];
    const r = await run(base);
    expect(r.out).toContain('agent-a');
    r.write([...base, launch('toolu_b', '任务乙'), receipt('toolu_b', 'agent-b')]);
    const again = (at: number) =>
      backgroundRecoveryContext(r.w.input({ transcript_path: r.transcript }), {
        home: r.w.home,
        env: r.w.env,
        now: at,
      });
    expect(await again(NOW + 120_000)).toBeNull();
    r.write([
      ...base,
      launch('toolu_b', '任务乙'),
      receipt('toolu_b', 'agent-b'),
      restartNote('agent-b', 'Agent', 'n-2'),
    ]);
    expect(await again(NOW + 240_000)).toContain('agent-b');
  });

  it('用 SendMessage 续上、之后又收到完成通知的代理：不算没跑完', async () => {
    const { out } = await run([
      launch('toolu_a', '任务甲'),
      receipt('toolu_a', 'agent-a'),
      launch('toolu_c', '任务丙'),
      receipt('toolu_c', 'agent-c'),
      restartNote('agent-a', 'Agent a', 'n-1'),
      restartNote('agent-c', 'Agent c', 'n-2'),
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_s',
              name: 'SendMessage',
              input: { to: 'agent-a', message: '续上' },
            },
          ],
        },
      },
      done('agent-a', 'd-1'),
    ]);
    expect(out).toContain('agent-c');
    expect(out).not.toContain('agent-a');
  });

  it('被钩子挡掉、根本没起来的后台调用：不列', async () => {
    const { out } = await run([
      launch('toolu_ok', '起来了的'),
      receipt('toolu_ok', 'agent-ok'),
      launch('toolu_blocked', '被挡掉的'),
      receipt('toolu_blocked', '', true),
      restartNote('agent-ok', 'Agent ok', 'n-1'),
    ]);
    expect(out).toContain('agent-ok');
    expect(out).not.toContain('被挡掉的');
    expect(out).not.toContain('toolu_blocked');
  });
});

describe('恢复提示只依赖本 transcript，不产生投递账', () => {
  const rows = (id = 'n-1') => [restartNote('agent-x', 'Agent 恢复任务', id)];
  const setup = () => {
    const w = world();
    const path = join(w.home, 'own.jsonl');
    writeFileSync(
      path,
      rows()
        .map((x) => JSON.stringify(x))
        .join('\n'),
    );
    return { ...w, path };
  };
  it('没有/损坏/其他会话Mirasim都不影响恢复；未匹配原文不出现在提示里', async () => {
    for (const mode of ['none', 'broken', 'foreign']) {
      const w = setup();
      const base = join(w.home, '.mirasim');
      rmSync(base, { recursive: true, force: true });
      if (mode !== 'none') {
        mkdirSync(join(base, 'sessions', 'claude', 'foreign'), { recursive: true });
        writeFileSync(
          join(base, 'sessions', 'claude', 'foreign', 'record.json'),
          mode === 'broken' ? '{bad' : JSON.stringify({ nativeSessionId: 'other' }),
        );
      }
      const out = await backgroundRecoveryContext(w.input({ transcript_path: w.path }), {
        home: w.home,
        env: {},
      });
      expect(out).toContain('agent-x');
      expect(out).not.toContain(STEER_TEXT);
      expect(
        JSON.parse(readFileSync(join(w.home, '.fleet-dao', 'inbox-seen', 'tick-c-1.json'), 'utf8')),
      ).toEqual({ backgroundRestartKey: 'restart:n-1' });
    }
  });
  it('子代理/camelCase/非法sid无输出无状态；同通知键跨sid不互相压制', async () => {
    const w = setup();
    for (const input of [
      w.input({ agent_id: 'a', transcript_path: w.path }),
      { hookEventName: 'PreToolUse', session_id: 'c-1', transcript_path: w.path },
      w.input({ session_id: '../x', transcript_path: w.path }),
      { toolName: 'Bash', session_id: 'c-1', transcript_path: w.path },
    ])
      expect(await backgroundRecoveryContext(input, { home: w.home, env: {} })).toBeNull();
    expect(existsSync(join(w.home, '.fleet-dao', 'inbox-seen'))).toBe(false);
    for (const sid of ['a', 'b'])
      expect(
        await backgroundRecoveryContext(w.input({ session_id: sid, transcript_path: w.path }), {
          home: w.home,
          env: {},
        }),
      ).toContain('agent-x');
  });
  it('兼容旧backgroundRestartKey，增长不再提示，新uuid才提示；不读取seen文件', async () => {
    const w = setup();
    const dir = join(w.home, 'state');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'tick-c-1.json'),
      JSON.stringify({ backgroundRestartKey: 'restart:n-1', checkedAt: 3, lastNotice: STEER_TEXT }),
    );
    mkdirSync(join(dir, 'seen-dir-c.json'));
    const opts = { home: w.home, env: { FLEET_INBOX_SEEN_DIR: dir } };
    expect(await backgroundRecoveryContext(w.input({ transcript_path: w.path }), opts)).toBeNull();
    writeFileSync(
      w.path,
      rows('n-2')
        .map((x) => JSON.stringify(x))
        .join('\n'),
    );
    expect(await backgroundRecoveryContext(w.input({ transcript_path: w.path }), opts)).toContain('agent-x');
    expect(JSON.parse(readFileSync(join(dir, 'tick-c-1.json'), 'utf8'))).toEqual({
      backgroundRestartKey: 'restart:n-2',
    });
  });
  it('写状态失败仍给恢复提示和明确诊断，读取transcript失败明确报告', async () => {
    const w = setup();
    const state = join(w.home, 'blocked');
    writeFileSync(state, 'file');
    const out = await backgroundRecoveryContext(w.input({ transcript_path: w.path }), {
      home: w.home,
      env: { FLEET_INBOX_SEEN_DIR: state },
    });
    expect(out).toContain('agent-x');
    expect(out).toMatch(/没查成|未记住/);
    expect(
      await backgroundRecoveryContext(w.input({ transcript_path: join(w.home, 'missing') }), {
        home: w.home,
        env: {},
      }),
    ).toContain('没查成');
  });
  it('真进程仅输出原生恢复提示，重复无输出；无通知时不补Mirasim原文', () => {
    const w = setup();
    const env = {
      ...process.env,
      FLEET_HEADLESS: '',
      FLEET_INBOX_SEEN_DIR: join(w.home, 'state'),
      FLEET_MIRASIM_DIR: join(w.home, '.mirasim'),
      FLEET_PROMPT_LOG_DIR: join(w.home, '.fleet-dao', 'prompt-log'),
    };
    const run = () =>
      runChild(process.execPath, [join(HOOKS, 'main-thread.mjs')], {
        input: JSON.stringify(w.input({ transcript_path: w.path })),
        env,
      });
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toContain('agent-x');
    expect(first.stdout).not.toContain(STEER_TEXT);
    expect(run().stdout).toBe('');
    writeFileSync(w.path, '');
    expect(run().stdout).toBe('');
  });
});
