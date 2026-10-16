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
  const io: Io = {
    gh: (args) => {
      calls.push(args);
      const a = answers.shift();
      if (a === undefined) throw new Error(`假 gh 没有更多回答了：${args.join(' ')}`);
      if (a instanceof Error) throw a;
      return a;
    },
    sleep: async () => {
      sleeps++;
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { io, calls, out, err, sleeps: () => sleeps };
}

const pr = (state: string, checks: unknown[] = []) =>
  JSON.stringify({ state, url: 'https://x/pull/7', statusCheckRollup: checks });

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
