// 单 #2382：创始人轮中发的引导，在下一次工具调用后就进会话（agents/hooks/inbox-tick.mjs，由 main-thread.mjs 每次主线程工具调用时调）。
// 钉住：轮中发的一条在下一次工具调用后出现、只出现一次；60 秒内连调不重复读账；开会话那段不再把已塞过的列为丢失；
// 读账失败明说「对账没查成」；子代理的调用不触发。
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

type Tick = (input: unknown, opts?: Record<string, unknown>) => Promise<string | null>;
const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
const { tick } = (await import(pathToFileURL(`${HOOKS}inbox-tick.mjs`).href)) as { tick: Tick };
const { recentPrompts } = (await import(pathToFileURL(`${HOOKS}session-start.mjs`).href)) as {
  recentPrompts(o: unknown): string[];
};
const { hookOutput } = (await import(pathToFileURL(`${HOOKS}main-thread.mjs`).href)) as {
  hookOutput(v: { deny?: string; notice?: string; context?: string }): string;
};

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
  const home = mkdtempSync(join(tmpdir(), 'inbox-tick-'));
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

describe('轮中发的引导在下一次工具调用后进会话（#2382）', () => {
  it('发了、没收到的一条：下一次工具调用就塞，原文照贴、写明发出时间；再调不重复塞', async () => {
    const w = world();
    const first = await tick(w.input(), { home: w.home, env: w.env, now: NOW });
    expect(first).toContain(STEER_TEXT);
    expect(first).toContain('10-16 10:25');
    expect(first).not.toContain('开始做 2382'); // 已经收到的两轮开头不是丢的
    expect(first).not.toContain('对账没查成');
    // 过了节流再调：同一条不再塞
    expect(await tick(w.input(), { home: w.home, env: w.env, now: NOW + 61_000 })).toBeNull();
    expect(await tick(w.input(), { home: w.home, env: w.env, now: NOW + 10 * 60_000 })).toBeNull();
  });

  it('后面又发的新一条：只塞新的，旧的不重复', async () => {
    const w = world();
    await tick(w.input(), { home: w.home, env: w.env, now: NOW });
    const later = { text: '另外再看下覆盖率', at: NOW + 20_000 };
    const turns = [
      { sessionId: 'c-1', startedAt: T('2026-10-16T02:00:00Z'), prompt: '开始做 2382' },
      {
        sessionId: 'c-1',
        startedAt: T('2026-10-16T02:20:00Z'),
        prompt: '接着做',
        steers: [{ text: STEER_TEXT, at: STEER_AT }, later],
      },
    ];
    writeFileSync(w.turnsFile, turns.map((t) => `${JSON.stringify(t)}\n`).join(''));
    const next = await tick(w.input(), { home: w.home, env: w.env, now: NOW + 61_000 });
    expect(next).toContain('另外再看下覆盖率');
    expect(next).not.toContain(STEER_TEXT);
  });

  it('60 秒内连调：只读一次账；到点才再读', async () => {
    const w = world();
    let loads = 0;
    const load = () => {
      loads++;
      return import(pathToFileURL(`${HOOKS}founder-inbox.mjs`).href);
    };
    const run = (now: number) => tick(w.input(), { home: w.home, env: w.env, now, load });
    await run(NOW);
    await run(NOW + 1_000);
    await run(NOW + 30_000);
    await run(NOW + 59_999);
    expect(loads).toBe(1);
    await run(NOW + 60_000);
    expect(loads).toBe(2);
  });

  it('节流按会话号各算各的', async () => {
    const w = world();
    let loads = 0;
    const load = () => {
      loads++;
      return import(pathToFileURL(`${HOOKS}founder-inbox.mjs`).href);
    };
    await tick(w.input(), { home: w.home, env: w.env, now: NOW, load });
    await tick(w.input({ session_id: 'other-1' }), { home: w.home, env: w.env, now: NOW + 1_000, load });
    expect(loads).toBe(2);
  });

  it('开会话那段读同一份已见名单：塞过的不再列成「没收到」；没塞过的照列', async () => {
    const w = world();
    const start = () => recentPrompts({ home: w.home, now: NOW + 120_000, sessionId: 'c-1', env: w.env });
    expect(start().join('\n')).toContain(STEER_TEXT); // 没塞过：开场列成没收到
    await tick(w.input(), { home: w.home, env: w.env, now: NOW });
    const after = start().join('\n');
    expect(after).not.toContain(STEER_TEXT);
    expect(after).not.toContain('没收到的话');
  });

  it('开场列出来的也记进已见名单：轮中的工具调用不再塞第二遍', async () => {
    const w = world();
    const listed = recentPrompts({
      home: w.home,
      now: NOW,
      sessionId: 'c-1',
      env: w.env,
      markSeen: true,
    }).join('\n');
    expect(listed).toContain(STEER_TEXT);
    expect(await tick(w.input(), { home: w.home, env: w.env, now: NOW + 5_000 })).toBeNull();
  });

  it('这个会话的记录里已有这条的 queued_command（Mirasim 正常送到了）：不塞，也记已见', async () => {
    const w = world();
    const transcript = join(w.home, 't.jsonl');
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: STEER_TEXT } })}\n`,
    );
    expect(
      await tick(w.input({ transcript_path: transcript }), { home: w.home, env: w.env, now: NOW }),
    ).toBeNull();
    // 记了已见：之后记录里没有也不会补塞
    expect(await tick(w.input(), { home: w.home, env: w.env, now: NOW + 61_000 })).toBeNull();
  });

  it('读账失败：塞一行「对账没查成：原因」，不当成没有新话；同样的失败 10 分钟内不重复说', async () => {
    const w = world();
    const load = () => Promise.reject(new Error('boom'));
    const first = await tick(w.input(), { home: w.home, env: w.env, now: NOW, load });
    expect(first).toBe('对账没查成：boom');
    expect(await tick(w.input(), { home: w.home, env: w.env, now: NOW + 61_000, load })).toBeNull();
    expect(await tick(w.input(), { home: w.home, env: w.env, now: NOW + 11 * 60_000, load })).toBe(
      '对账没查成：boom',
    );
  });

  it('收到的账读不了（prompt-log 那天的文件是个目录）：明说对账没查成，不静默', async () => {
    const w = world();
    rmSync(w.logFile);
    mkdirSync(w.logFile);
    const out = await tick(w.input(), { home: w.home, env: w.env, now: NOW });
    expect(out).toMatch(/^对账没查成：创始人落盘的话没读成/);
    expect(out).not.toContain(STEER_TEXT);
  });

  it('子代理里的调用（带 agent_id）不触发，也不碰账和状态', async () => {
    const w = world();
    let loads = 0;
    const load = () => {
      loads++;
      return import(pathToFileURL(`${HOOKS}founder-inbox.mjs`).href);
    };
    expect(
      await tick(w.input({ agent_id: 'sub-1' }), { home: w.home, env: w.env, now: NOW, load }),
    ).toBeNull();
    expect(loads).toBe(0);
    expect(() => readdirSync(join(w.home, '.fleet-dao', 'inbox-seen'))).toThrow();
  });

  it('不是 Mirasim 起的会话（没有血缘）、没有会话号的输入：不出声', async () => {
    const w = world();
    expect(
      await tick(w.input({ session_id: 'not-in-mirasim' }), { home: w.home, env: w.env, now: NOW }),
    ).toBeNull();
    expect(await tick({ tool_name: 'Bash' }, { home: w.home, env: w.env, now: NOW })).toBeNull();
    expect(await tick('不是对象', { home: w.home, env: w.env, now: NOW })).toBeNull();
  });

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
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'text',
                text: "Some background tasks didn't finish before the previous session ended.",
              },
            ],
          },
        },
      ]
        .map((r) => `${JSON.stringify(r)}\n`)
        .join(''),
    );
    const first = await tick(w.input({ transcript_path: transcript }), {
      home: w.home,
      env: w.env,
      now: NOW,
    });
    expect(first).toContain('agent-42');
    expect(first).toContain('检查 CI 为什么红，并给出修复建议');
    expect(first).toContain('SendMessage');
    expect(
      await tick(w.input({ transcript_path: transcript }), { home: w.home, env: w.env, now: NOW + 61_000 }),
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
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'text',
                text: "Some background tasks didn't finish before the previous session ended.",
              },
            ],
          },
        },
      ]
        .map((r) => `${JSON.stringify(r)}\n`)
        .join(''),
    );
    const out = await tick(w.input({ transcript_path: transcript }), { home: w.home, env: w.env, now: NOW });
    expect(out).toContain('后台命令 cmd-7');
    expect(out).toContain('pnpm check');
    expect(out).toContain('要不要重跑，由本会话判断');
    expect(out).not.toContain('SendMessage');
  });
});

describe('main-thread.mjs 的输出带 additionalContext', () => {
  it('只有塞的话：hookSpecificOutput 里只有 additionalContext，不带拒', () => {
    const out = JSON.parse(hookOutput({ context: '你好' }));
    expect(out.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', additionalContext: '你好' });
  });

  it('拒和塞的话同时有：两样都在', () => {
    const out = JSON.parse(hookOutput({ deny: '先回', context: '你好' }));
    expect(out.hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: '先回',
      additionalContext: '你好',
    });
  });

  it('真起钩子进程：丢的引导出现在 stdout 的 additionalContext 里；60 秒内第二次调用什么都不写', () => {
    const w = world();
    const seen = join(w.home, 'seen');
    const env = {
      ...process.env,
      FLEET_MIRASIM_DIR: join(w.home, '.mirasim'),
      FLEET_PROMPT_LOG_DIR: join(w.home, '.fleet-dao', 'prompt-log'),
      FLEET_INBOX_SEEN_DIR: seen,
      FLEET_STEER_SHOWN_DIR: join(w.home, 'steer-shown'),
      FLEET_HEADLESS: '',
    };
    const transcript = join(w.home, 'transcript.jsonl');
    writeFileSync(transcript, '');
    const input = JSON.stringify({
      session_id: 'c-1',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      transcript_path: transcript,
    });
    // 钩子用真实时钟：把记录里的时刻挪到「刚刚」
    const base = Date.now() - 5 * 60_000;
    const d = join(w.home, '.mirasim', 'sessions', 'claude', 'dir-c');
    const turns = [
      { sessionId: 'c-1', startedAt: base - 20 * 60_000, prompt: '开始做 2382' },
      {
        sessionId: 'c-1',
        startedAt: base - 10 * 60_000,
        prompt: '接着做',
        steers: [{ text: STEER_TEXT, at: base }],
      },
    ];
    writeFileSync(join(d, 'turns.jsonl'), turns.map((t) => `${JSON.stringify(t)}\n`).join(''));
    const day = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
    const rows = [
      { at: new Date(base - 20 * 60_000 + 1000).toISOString(), sessionId: 'c-1', prompt: '开始做 2382' },
      { at: new Date(base - 10 * 60_000 + 1000).toISOString(), sessionId: 'c-1', prompt: '接着做' },
    ];
    const log = join(w.home, '.fleet-dao', 'prompt-log');
    for (const dd of new Set([day(base), day(base - 20 * 60_000)]))
      writeFileSync(join(log, `${dd}.jsonl`), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));

    const first = runChild(process.execPath, [`${HOOKS}main-thread.mjs`], { input, env });
    expect(first.status).toBe(0);
    const out = JSON.parse(first.stdout.trim());
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain(STEER_TEXT);
    const second = runChild(process.execPath, [`${HOOKS}main-thread.mjs`], { input, env });
    expect(second.status).toBe(0);
    expect(second.stdout).not.toContain(STEER_TEXT);
    expect(second.stdout.trim()).toBe('');
  });
});
