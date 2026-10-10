// 钉住主对话的两条（agents/hooks/main-thread.mjs，决定 0078；改标准：agents/test/rules/ 在 standard-paths.json 里）。
// 1. 引导先回：创始人在一轮中途打的字（Claude Code 的 transcript 里是 attachment.type=queued_command、commandMode=prompt），
//    附在下一次工具结果后面送进主对话。本机 178 条送到的引导里，AI 第一反应直接再调工具 107 条、先写话 45 条、本轮随即结束 26 条，
//    创始人觉得「石沉大海」。所以最后一条引导之后主对话还没写过一段非空文字，就拒这次工具调用，理由里带上引导的前 200 字。
// 2. 子代理一律后台跑：主对话前台等子代理时整段卡住，引导送不进来；Mirasim 一轮结束会杀掉还在跑的后台子代理，
//    界面也只在派它的那一轮显示每一步。所以主对话调 Agent/Task 写了 run_in_background: false 就拒；不写不拦（不写就是后台：
//    本机 transcript 里不写的 39 次全是后台起的）。
// 子代理里的调用（输入带 agent_id）两条都不管。transcript 读不了：放行，但用 systemMessage 明说没查成，不当成没有引导。
// 创始人 2026-10-10 13:02 选定（「都按你的推荐来。」）。
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runChild } from '../child.ts';

interface Verdict {
  deny?: string;
  notice?: string;
}
interface MainThreadLib {
  check(
    raw: string,
    opts?: { settleMs?: number; sleep?: (ms: number) => void; now?: number; mirasim?: string },
  ): Verdict;
  hookOutput(v: Verdict): string;
  DIRECTIVE_SHOWN_CHARS: number;
}
const HOOK = fileURLToPath(new URL('../../hooks/main-thread.mjs', import.meta.url));
const lib = (await import(pathToFileURL(HOOK).href)) as MainThreadLib;

const dir = mkdtempSync(join(tmpdir(), 'main-thread-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;

type Row = Record<string, unknown>;
/** 主对话一段 transcript 的几种行，照本机真 transcript 的形状造（键名、嵌套一致，无关的键省掉） */
const row = {
  prompt: (text: string): Row => ({
    type: 'user',
    isSidechain: false,
    message: { role: 'user', content: [{ type: 'text', text }] },
  }),
  thinking: (id: string): Row => ({
    type: 'assistant',
    isSidechain: false,
    message: { id, role: 'assistant', content: [{ type: 'thinking', thinking: '想一想' }] },
  }),
  text: (id: string, text: string, extra: Row = {}): Row => ({
    type: 'assistant',
    isSidechain: false,
    message: { id, role: 'assistant', content: [{ type: 'text', text }] },
    ...extra,
  }),
  toolUse: (id: string, toolId: string): Row => ({
    type: 'assistant',
    isSidechain: false,
    message: {
      id,
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'ls' } }],
    },
  }),
  result: (toolId: string, out = 'ok'): Row => ({
    type: 'user',
    isSidechain: false,
    message: { role: 'user', content: [{ tool_use_id: toolId, type: 'tool_result', content: out }] },
  }),
  /** 创始人中途打的字：Mirasim 里 prompt 是数组，origin 不带；命令行里 origin.kind 是 human、prompt 是字符串 */
  directive: (text: string, shape: 'array' | 'human' = 'array'): Row => ({
    type: 'attachment',
    isSidechain: false,
    attachment:
      shape === 'array'
        ? { type: 'queued_command', prompt: [{ type: 'text', text }], commandMode: 'prompt' }
        : { type: 'queued_command', prompt: text, commandMode: 'prompt', origin: { kind: 'human' } },
  }),
  /** 后台任务跑完的通知：也走 queued_command，但不是创始人的话 */
  notification: (): Row => ({
    type: 'attachment',
    isSidechain: false,
    attachment: {
      type: 'queued_command',
      prompt: '<task-notification>子代理跑完了</task-notification>',
      commandMode: 'task-notification',
      origin: { kind: 'task-notification', producer: 'session-task' },
    },
  }),
};

/** 主对话一轮：创始人开口、AI 回一句、调一次工具拿到结果 */
const turnStart = (): Row[] => [
  row.prompt('帮我修一下'),
  row.thinking('m1'),
  row.text('m1', '好，先看代码。'),
  row.toolUse('m1', 't1'),
  row.result('t1'),
];

function transcript(rows: Row[], tail = ''): string {
  seq += 1;
  const file = join(dir, `t${seq}.jsonl`);
  writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n${tail}`);
  return file;
}

const input = (path: unknown, extra: Row = {}, tool = 'Bash', toolInput: Row = { command: 'ls' }) =>
  JSON.stringify({
    session_id: 's1',
    transcript_path: path,
    cwd: '/work',
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: toolInput,
    tool_use_id: 'toolu_now',
    ...extra,
  });

/** Mirasim 的引导那一条（#1743）在 mirasim-steer.rules.test.ts 钉；这里指到一个不在的家目录，不读跑测试这台机器上的真 diag */
const NO_MIRASIM = join(dir, 'no-mirasim');
const NO_MIRASIM_ENV = { ...process.env, FLEET_MIRASIM_DIR: NO_MIRASIM };
const check = (raw: string) => lib.check(raw, { settleMs: 0, mirasim: NO_MIRASIM });

describe('引导先回', () => {
  it('引导之后直接调工具：拒，理由带引导原文、说怎么回、涉及子代理用 SendMessage 转', () => {
    const t = transcript([...turnStart(), row.directive('先别动数据库，改成只读'), row.thinking('m2')]);
    const v = check(input(t));
    expect(v.deny).toContain('『先别动数据库，改成只读』');
    expect(v.deny).toContain('先用一句话回它');
    expect(v.deny).toContain('SendMessage');
    expect(v.notice).toBeUndefined();
  });

  it('命令行里的写法（prompt 是字符串、origin.kind 是 human）一样认', () => {
    const t = transcript([...turnStart(), row.directive('停一下', 'human')]);
    expect(check(input(t)).deny).toContain('『停一下』');
  });

  it('引导之后先写了话再调工具：放行', () => {
    const t = transcript([
      ...turnStart(),
      row.directive('先别动数据库'),
      row.thinking('m2'),
      row.text('m2', '收到，改成只读，不碰数据库。'),
      row.toolUse('m2', 't2'),
    ]);
    expect(check(input(t))).toEqual({});
  });

  it('文字和这次的工具调用在同一条回复里（同一个 message.id，文字那行先落盘）：算回了', () => {
    const t = transcript([
      ...turnStart(),
      row.directive('先别动数据库'),
      row.text('m2', '收到。'),
      row.toolUse('m2', 't2'),
    ]);
    expect(check(input(t))).toEqual({});
  });

  it('没有引导：放行；后台任务的完成通知不算引导', () => {
    expect(check(input(transcript(turnStart())))).toEqual({});
    expect(check(input(transcript([...turnStart(), row.notification(), row.thinking('m2')])))).toEqual({});
  });

  it('上一轮没回的引导，创始人又开了新的一轮：不再拿旧的拦', () => {
    const t = transcript([
      ...turnStart(),
      row.directive('旧的引导'),
      row.prompt('新的一轮'),
      row.thinking('m3'),
    ]);
    expect(check(input(t))).toEqual({});
  });

  it('引导很长：理由里只带前 200 字', () => {
    const long = `${'字'.repeat(lib.DIRECTIVE_SHOWN_CHARS)}超出的部分`;
    const v = check(input(transcript([...turnStart(), row.directive(long)])));
    expect(lib.DIRECTIVE_SHOWN_CHARS).toBe(200);
    expect(v.deny).toContain('字'.repeat(200));
    expect(v.deny).not.toContain('超出的部分');
  });

  it('只读尾部也找得到：引导前面压着一条比读块大得多的行（贴图的 base64），最后一行还没写完', () => {
    const big = row.result('t0', 'x'.repeat(3 * 1024 * 1024));
    const t = transcript([big, ...turnStart(), row.directive('看图')], '{"type":"assistant","mess');
    expect(check(input(t)).deny).toContain('『看图』');
    const t2 = transcript([...turnStart(), row.directive('看图'), big]);
    expect(check(input(t2)).deny).toContain('『看图』');
  });

  it('第一次读时文字还没落盘、等一下就有了：等过再读一遍，放行', () => {
    const t = transcript([...turnStart(), row.directive('先别动数据库')]);
    const v = lib.check(input(t), {
      settleMs: 1,
      mirasim: NO_MIRASIM,
      sleep: () => appendFileSync(t, `${JSON.stringify(row.text('m2', '收到。'))}\n`),
    });
    expect(v).toEqual({});
  });

  it('【故意造出的失败】只想不说、只写空白、子代理（isSidechain）写的话、接口报错的假回复：都不算回了，照拦', () => {
    const cases: Row[][] = [
      [row.thinking('m2')],
      [row.text('m2', '   \n ')],
      // 旧版 Claude Code 把子代理的行也写在主对话的文件里（isSidechain: true），后面接着主对话自己的行
      [row.text('m2', '收到。', { isSidechain: true }), row.thinking('m3')],
      [row.text('m2', 'API Error: 529', { isApiErrorMessage: true })],
    ];
    for (const after of cases) {
      const t = transcript([...turnStart(), row.directive('先别动数据库'), ...after]);
      expect(check(input(t)).deny, JSON.stringify(after)).toContain('先别动数据库');
    }
  });
});

describe('读不了 transcript：放行，但明说没查成', () => {
  it.each([
    ['transcript_path 没给', undefined],
    ['transcript_path 是空串', ''],
    ['transcript_path 不是字符串', 7],
    ['文件不存在', join(dir, 'no-such.jsonl')],
    ['是个目录', dir],
  ])('%s：不拦，systemMessage 写「引导检查没查成」和原因', (_name, path) => {
    const v = check(input(path));
    expect(v.deny).toBeUndefined();
    expect(v.notice).toMatch(/^引导检查没查成：.+/);
  });

  it('钩子输入不是 JSON：不拦，明说没查成', () => {
    const v = check('不是 JSON');
    expect(v.deny).toBeUndefined();
    expect(v.notice).toMatch(/^引导检查没查成：/);
  });

  it('transcript 读不了也照样管前台子代理', () => {
    const v = check(input(undefined, {}, 'Agent', { prompt: '干活', run_in_background: false }));
    expect(v.deny).toContain('子代理一律后台跑');
    expect(v.notice).toMatch(/^引导检查没查成：/);
  });
});

describe('子代理一律后台跑', () => {
  const clean = () => transcript(turnStart());

  it.each([
    ['Agent', { prompt: '干活', subagent_type: 'fleet-builder', run_in_background: false }],
    ['Task', { prompt: '干活', run_in_background: false }],
  ])('主对话里 %s %j 写明前台：拒，并说清为什么', (tool, toolInput) => {
    const v = check(input(clean(), {}, tool, toolInput));
    expect(v.deny).toContain('子代理一律后台跑');
    expect(v.deny).toContain('去掉 run_in_background: false');
    expect(v.deny).toContain('60 秒');
    expect(v.deny).toContain('Mirasim 一轮结束会杀掉后台子代理');
  });

  it('不写 run_in_background（默认就是后台）、写 true：放行', () => {
    expect(check(input(clean(), {}, 'Agent', { prompt: '干活' }))).toEqual({});
    expect(check(input(clean(), {}, 'Agent', { prompt: '干活', run_in_background: true }))).toEqual({});
  });

  it('引导没回、又前台派子代理：两条理由一起给，一次改对', () => {
    const t = transcript([...turnStart(), row.directive('换个做法')]);
    const v = check(input(t, {}, 'Agent', { prompt: '干活', run_in_background: false }));
    expect(v.deny).toContain('『换个做法』');
    expect(v.deny).toContain('子代理一律后台跑');
  });

  it('【故意造出的失败】把判法改成「不是 true 就拦」：不写的那次被误拦，上一条就会红', async () => {
    const src = readFileSync(HOOK, 'utf8');
    const want = "prop(toolInput, 'run_in_background') === false";
    expect(src).toContain(want);
    const mutant = join(dir, 'main-thread-mutant.mjs');
    writeFileSync(mutant, src.replace(want, "prop(toolInput, 'run_in_background') !== true"));
    const bad = (await import(pathToFileURL(mutant).href)) as MainThreadLib;
    expect(
      bad.check(input(clean(), {}, 'Agent', { prompt: '干活' }), { settleMs: 0, mirasim: NO_MIRASIM }).deny,
    ).toContain('子代理一律后台跑');
  });
});

describe('子代理里的调用两条都不管', () => {
  it('输入带 agent_id：引导没回也放行，前台派子代理也放行', () => {
    const t = transcript([...turnStart(), row.directive('先别动数据库')]);
    expect(check(input(t, { agent_id: 'a1b2' }))).toEqual({});
    expect(
      check(input(t, { agent_id: 'a1b2' }, 'Agent', { prompt: '再派一个', run_in_background: false })),
    ).toEqual({});
  });

  it('没有 agent_id 但 transcript 是子代理的（每行 isSidechain: true）：不查', () => {
    const side = [...turnStart(), row.directive('先别动数据库')].map((r) => ({ ...r, isSidechain: true }));
    expect(check(input(transcript(side)))).toEqual({});
    expect(
      check(input(transcript(side), {}, 'Agent', { prompt: '再派一个', run_in_background: false })),
    ).toEqual({});
  });

  it('【故意造出的失败】agent_id 空串、不是字符串：不算子代理，照拦', () => {
    const t = transcript([...turnStart(), row.directive('先别动数据库')]);
    for (const bad of ['', '  ', 7, null]) {
      expect(check(input(t, { agent_id: bad })).deny, JSON.stringify(bad)).toContain('先别动数据库');
    }
  });
});

describe('Grok 借道读同一份钩子登记（camelCase 输入、没有 transcript）', () => {
  it('不是 Claude Code 的输入：两条都不查、不说话', () => {
    const raw = JSON.stringify({
      hookEventName: 'pre_tool_use',
      toolName: 'run_terminal_command',
      toolInput: {},
    });
    expect(check(raw)).toEqual({});
  });
});

describe('登记和真跑', () => {
  // agents 是单独的 TypeScript 项目，引不进 packages/agents-sync 的源码：按文字读同步工具的目标清单
  const TARGETS = readFileSync(
    fileURLToPath(new URL('../../../packages/agents-sync/src/targets.ts', import.meta.url)),
    'utf8',
  );
  /** Claude 那份设置（~/.claude/settings.json）里登记 main-thread.mjs 的几行 */
  const registrations = (text: string): string[] => {
    const at = text.indexOf("format: 'claude'");
    const end = text.indexOf('format:', at + 1);
    if (at < 0 || end < 0) throw new Error('targets.ts 里认不出 Claude 那一家的登记');
    return text
      .slice(at, end)
      .split('\n')
      .filter((l) => l.includes("'main-thread.mjs'"))
      .map((l) => l.trim());
  };
  const WANT = "{ event: 'PreToolUse', script: 'main-thread.mjs', timeout: 10 },";

  it('Claude 那份设置里，这个钩子挂在 PreToolUse 上、不写 matcher（每次工具调用都过）', () => {
    expect(registrations(TARGETS)).toEqual([WANT]);
  });

  it('【故意造出的失败】登记里加了 matcher、或者整条删掉：上一条查得出来', () => {
    const narrowed = TARGETS.replace(
      WANT,
      "{ event: 'PreToolUse', matcher: 'Bash', script: 'main-thread.mjs', timeout: 10 },",
    );
    expect(narrowed).not.toBe(TARGETS);
    expect(registrations(narrowed)).not.toEqual([WANT]);
    expect(registrations(TARGETS.replace(WANT, ''))).toEqual([]);
  });

  // 同步起子进程：卡死由 runChild 给子进程的上限管（#264）
  it('从命令行进来：拒的时候 stdout 是 permissionDecision deny、退出码 0；没查成时是 systemMessage', {
    timeout: 0,
  }, () => {
    const t = transcript([...turnStart(), row.directive('先别动数据库')]);
    const r = runChild(process.execPath, [HOOK], { input: input(t), env: NO_MIRASIM_ENV });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput?: {
        hookEventName?: string;
        permissionDecision?: string;
        permissionDecisionReason?: string;
      };
    };
    expect(out.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('先别动数据库');

    const lost = runChild(process.execPath, [HOOK], {
      input: input(join(dir, 'gone.jsonl')),
      env: NO_MIRASIM_ENV,
    });
    expect(lost.status).toBe(0);
    expect((JSON.parse(lost.stdout) as { systemMessage?: string }).systemMessage).toMatch(
      /^引导检查没查成：/,
    );

    const ok = runChild(process.execPath, [HOOK], {
      input: input(transcript(turnStart())),
      env: NO_MIRASIM_ENV,
    });
    expect([ok.status, ok.stdout]).toEqual([0, '']);
  });
});
