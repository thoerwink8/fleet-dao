// 指挥官等结果的脚本（agents/skills/commander/scripts/wait.mjs，单 #2730）：到终态才写一行并退出；
// gh 出错、输出认不出当场退出码 2，不吞错、不空跑（旧会话 jq 写错进了 /dev/null，循环空跑 90 分钟）。
// gh 换成假的（按调用次数给输出）；sleep 换成记次数的空函数。真起子进程的只有两条：用法错、gh 找不到。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

type Gh = (args: string[]) => string;
interface Io {
  gh: Gh;
  sleep(ms: number): Promise<void>;
  out(line: string): void;
  err(line: string): void;
}
interface WaitLib {
  run(argv: string[], io: Io): Promise<number>;
  stepPr(
    gh: Gh,
    n: number,
    repo: string[],
    now?: number,
  ): { done: false } | { done: true; ok: boolean; line: string };
  MAIN_CI_WORKFLOW: string;
}

const SCRIPT = fileURLToPath(new URL('../skills/commander/scripts/wait.mjs', import.meta.url));
const lib = (await import(pathToFileURL(SCRIPT).href)) as WaitLib;

const SHA = 'a'.repeat(40);

/** 按顺序给出的回答：字符串是 stdout，Error 是 gh 出错 */
function fake(answers: (string | Error)[]) {
  const calls: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  let sleeps = 0;
  const sleepMs: number[] = [];
  const io: Io = {
    gh: (args) => {
      calls.push(args);
      const a = answers.shift();
      if (a === undefined) throw new Error(`假 gh 没有更多回答了：${args.join(' ')}`);
      if (a instanceof Error) throw a;
      return a;
    },
    sleep: async (ms) => {
      sleeps++;
      sleepMs.push(ms);
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { io, calls, out, err, sleeps: () => sleeps, sleepMs };
}

const pr = (state: string, checks: unknown[] = []) =>
  JSON.stringify({ state, url: 'https://x/pull/7', statusCheckRollup: checks });

describe('wait.mjs pr-head', () => {
  const NEXT = 'b'.repeat(40);
  const head = (state: string, headRefOid = SHA, extra = {}) =>
    JSON.stringify({ state, headRefOid, url: 'https://x/pull/7', ...extra });
  const argv = ['pr-head', '7', '--after', SHA];

  it('旧头检查红或绿都继续等，新头到达只写一行完整旧新 head，沿用原循环和仓参数', async () => {
    const f = fake([
      head('OPEN', SHA, { statusCheckRollup: [{ conclusion: 'FAILURE' }] }),
      head('OPEN', SHA, { statusCheckRollup: [{ conclusion: 'SUCCESS' }] }),
      head('OPEN', NEXT),
    ]);
    expect(await lib.run([...argv, '-R', 'acme/demo'], f.io)).toBe(0);
    expect(f.sleeps()).toBe(2);
    expect(f.sleepMs).toEqual([60_000, 60_000]);
    expect(f.out).toEqual([`PR #7 头已变化：${SHA} → ${NEXT} https://x/pull/7`]);
    expect(f.calls).toEqual(
      Array.from({ length: 3 }, () => [
        'pr',
        'view',
        '7',
        '-R',
        'acme/demo',
        '--json',
        'state,url,headRefOid',
      ]),
    );
    expect(f.err).toEqual([]);
  });

  it.each([SHA, NEXT])('合并优先于头变化（%s），明确已经合并', async (oid) => {
    const f = fake([head('MERGED', oid)]);
    expect(await lib.run(argv, f.io)).toBe(0);
    expect(f.sleeps()).toBe(0);
    expect(f.out).toEqual([`PR #7 已经合并，当前头 ${oid} https://x/pull/7`]);
  });

  it('关闭未合即使换头也先退出1，不冒充新头可复审', async () => {
    const f = fake([head('CLOSED', NEXT)]);
    expect(await lib.run(argv, f.io)).toBe(1);
    expect(f.sleeps()).toBe(0);
    expect(f.out).toEqual(['PR #7 被关掉、没合并 https://x/pull/7']);
  });

  it.each([
    ['gh 失败', new Error('HTTP 502')],
    ['坏 JSON', '{'],
    ['不是对象', '[]'],
    ['缺 head', JSON.stringify({ state: 'OPEN', url: 'https://x/pull/7' })],
    ['非法 head', head('OPEN', 'b'.repeat(39))],
    ['未知 state 即使换头', head('WEIRD', NEXT)],
    ['缺 state', JSON.stringify({ headRefOid: SHA, url: 'https://x/pull/7' })],
    ['缺 url', JSON.stringify({ state: 'OPEN', headRefOid: SHA })],
    ['非法 url', head('OPEN', NEXT, { url: '' })],
    ['url 非字符串', head('OPEN', NEXT, { url: 7 })],
    ['url 换行', head('OPEN', NEXT, { url: 'https://x/pull/7\n伪造结果' })],
    ['合并但 head 坏', head('MERGED', 'not-a-sha')],
  ])('%s：明确未知退出2，不输出结论', async (_name, answer) => {
    const f = fake([answer]);
    expect(await lib.run(argv, f.io)).toBe(2);
    expect(f.out).toEqual([]);
    expect(f.err.join('\n')).toContain('出错，当场退出');
  });

  it('同头等待后读取失败，不当成仍无变化', async () => {
    const f = fake([head('OPEN'), new Error('permission denied')]);
    expect(await lib.run(argv, f.io)).toBe(2);
    expect(f.sleeps()).toBe(1);
    expect(f.out).toEqual([]);
    expect(f.err.join('\n')).toContain('permission denied');
  });

  it.each([
    ['pr-head', '7'],
    ['pr-head', '7', '--after'],
    ['pr-head', '7', '--after', 'abc'],
    ['pr-head', '7', '--after', 'g'.repeat(40)],
    ['pr-head', '7', '--after', SHA, '--after', NEXT],
    ['pr-head', '0', '--after', SHA],
    ['pr-head', '9007199254740993', '--after', SHA],
    ['pr-head', '7', '--after', SHA, 'extra'],
    ['pr', '7', '--after', SHA],
    ['issue', '7', '--after', SHA],
    ['main-ci', '--after', SHA],
  ])('参数拒绝 %j，不调用 gh', async (...args) => {
    const f = fake([]);
    expect(await lib.run(args, f.io)).toBe(2);
    expect(f.calls).toEqual([]);
  });
});

describe('wait.mjs pr', () => {
  it('还在跑就接着等，合并了写一行、退出码 0', async () => {
    const f = fake([
      pr('OPEN', [{ __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: '' }]),
      pr('OPEN', [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }]),
      pr('MERGED'),
    ]);
    expect(await lib.run(['pr', '7', '--interval', '1'], f.io)).toBe(0);
    expect(f.out).toEqual(['PR #7 合并了 https://x/pull/7']);
    expect(f.sleeps()).toBe(2);
    expect(f.err).toEqual([]);
  });

  it('有检查红了：写一行带上红的名字，退出码 1，不再等', async () => {
    const f = fake([
      pr('OPEN', [
        { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'StatusContext', context: 'merge-gate', state: 'ERROR' },
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ]),
    ]);
    expect(await lib.run(['pr', '7'], f.io)).toBe(1);
    expect(f.out).toHaveLength(1);
    expect(f.out[0]).toContain('ci、merge-gate');
    expect(f.out[0]).not.toContain('lint');
  });

  it('被关掉没合：退出码 1', async () => {
    const f = fake([pr('CLOSED')]);
    expect(await lib.run(['pr', '7'], f.io)).toBe(1);
  });
});

describe('wait.mjs pr 同名检查只看最新那条（#2818）', () => {
  const NOW = Date.parse('2026-10-16T12:00:00Z');
  /** 距现在 minAgo 分钟的时刻（ISO） */
  const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
  const ask = (checks: unknown[]) => lib.stepPr(() => pr('OPEN', checks), 7, [], NOW);

  it('改正文后 merge-gate 重跑：旧的 CANCELLED、新的 SUCCESS 同在，不判红，接着等', () => {
    expect(
      ask([
        {
          __typename: 'CheckRun',
          name: 'merge-gate',
          status: 'COMPLETED',
          conclusion: 'CANCELLED',
          startedAt: at(20),
          completedAt: at(19),
        },
        {
          __typename: 'CheckRun',
          name: 'merge-gate',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          startedAt: at(2),
          completedAt: at(1),
        },
        {
          __typename: 'CheckRun',
          name: 'ci',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          startedAt: at(20),
          completedAt: at(18),
        },
      ]),
    ).toEqual({ done: false });
  });

  it('最新那条是 CANCELLED 且刚结束（不到 3 分钟）：先不判红，接着等', () => {
    expect(
      ask([
        {
          __typename: 'CheckRun',
          name: 'merge-gate',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          startedAt: at(20),
          completedAt: at(19),
        },
        {
          __typename: 'CheckRun',
          name: 'merge-gate',
          status: 'COMPLETED',
          conclusion: 'CANCELLED',
          startedAt: at(3),
          completedAt: at(1),
        },
      ]),
    ).toEqual({ done: false });
  });

  it('只有一条 CANCELLED 且结束已超过 3 分钟：判红，line 里有 merge-gate', () => {
    const s = ask([
      {
        __typename: 'CheckRun',
        name: 'merge-gate',
        status: 'COMPLETED',
        conclusion: 'CANCELLED',
        startedAt: at(6),
        completedAt: at(5),
      },
    ]);
    expect(s.done).toBe(true);
    expect(s).toMatchObject({ ok: false });
    if (s.done) expect(s.line).toContain('merge-gate');
  });

  it('同名两条，最新那条是 FAILURE（数组里放在前面也照样按时间看）：判红', () => {
    const s = ask([
      {
        __typename: 'CheckRun',
        name: 'merge-gate',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        startedAt: at(2),
        completedAt: at(1),
      },
      {
        __typename: 'CheckRun',
        name: 'merge-gate',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        startedAt: at(20),
        completedAt: at(19),
      },
    ]);
    expect(s.done).toBe(true);
    expect(s).toMatchObject({ ok: false });
    if (s.done) expect(s.line).toContain('merge-gate');
  });
});

describe('wait.mjs main-ci', () => {
  it('先取 main 头上的提交，等它的 ci.yml：还没起跑、在跑都接着等，成功退出码 0', async () => {
    const f = fake([
      JSON.stringify({ sha: SHA }),
      '[]',
      JSON.stringify([{ databaseId: 1, status: 'in_progress', conclusion: '', url: 'u' }]),
      JSON.stringify([{ databaseId: 1, status: 'completed', conclusion: 'success', url: 'u' }]),
    ]);
    expect(await lib.run(['main-ci'], f.io)).toBe(0);
    expect(f.out).toEqual(['main aaaaaaa 的 CI 绿了 u']);
    const list = f.calls[1] ?? [];
    expect(list).toContain(SHA);
    expect(list).toContain(lib.MAIN_CI_WORKFLOW);
  });

  it('跑完不是成功：退出码 1，结论写进那一行', async () => {
    const f = fake([
      JSON.stringify({ sha: SHA }),
      JSON.stringify([{ databaseId: 1, status: 'completed', conclusion: 'failure', url: 'u' }]),
    ]);
    expect(await lib.run(['main-ci'], f.io)).toBe(1);
    expect(f.out[0]).toContain('failure');
  });
});

describe('wait.mjs issue', () => {
  it('开着接着等，关了写一行、退出码 0', async () => {
    const f = fake([
      JSON.stringify({ state: 'OPEN', stateReason: '', url: 'i' }),
      JSON.stringify({ state: 'CLOSED', stateReason: 'COMPLETED', url: 'i' }),
    ]);
    expect(await lib.run(['issue', '9'], f.io)).toBe(0);
    expect(f.out).toEqual(['单 #9 关了（COMPLETED） i']);
  });
});

describe('wait.mjs 出错当场退出，不空跑', () => {
  it.each([
    [
      'gh 出错（网络、没登录、号不存在）',
      ['pr', '7'],
      [new Error('gh pr view 7 退出码 1：could not resolve host')],
    ],
    ['输出不是 JSON', ['pr', '7'], ['jq: error: syntax error']],
    ['输出缺字段', ['issue', '9'], [JSON.stringify({ url: 'i' })]],
    ['state 认不出', ['pr', '7'], [JSON.stringify({ state: 'WEIRD', url: 'u' })]],
    ['main 的 sha 认不出', ['main-ci'], [JSON.stringify({ sha: 'nope' })]],
    [
      '等到一半 gh 出错',
      ['issue', '9'],
      [JSON.stringify({ state: 'OPEN', url: 'i' }), new Error('HTTP 502')],
    ],
  ] as const)('%s：退出码 2，stdout 不写结论，stderr 写明原因', async (_name, argv, answers) => {
    const f = fake([...answers]);
    expect(await lib.run([...argv], f.io)).toBe(2);
    expect(f.out).toEqual([]);
    expect(f.err.join('\n')).toContain('出错，当场退出');
  });

  it.each([
    [[]],
    [['pr']],
    [['pr', 'x']],
    [['what', '1']],
    [['main-ci', '3']],
    [['issue', '9', '--interval', '0']],
  ])('用法错 %j：退出码 2，不调 gh', async (argv) => {
    const f = fake([]);
    expect(await lib.run(argv, f.io)).toBe(2);
    expect(f.calls).toEqual([]);
  });
});

describe('wait.mjs 命令行', { timeout: 0 }, () => {
  it('用法错：退出码 2', () => {
    const r = runChild(process.execPath, [SCRIPT, 'pr']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('用法');
  });

  it('找不到 gh：退出码 2，stderr 写明没跑起来', () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
    const r = runChild(process.execPath, [SCRIPT, 'issue', '1'], { env: { ...env, PATH: '' } });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('没跑起来');
  });
});
