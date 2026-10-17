import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type BatchSpec, issueBatchNew, recoverIssueBatch } from '../src/issue-batch.ts';
import type { Gh, GhResult } from '../src/issue-new.ts';
import { parentField } from '../src/parent-field.ts';

const ok = (value: unknown): GhResult => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: '',
});
const fail = (why: string): GhResult => ({ code: 1, stdout: '', stderr: why });
const body =
  '## 场景\n\n批量登记改进点。\n\n## 原话\n\n无（AI 发现）。\n\n## 已知的模块\n\n开单脚本。\n\n## 怎么算做完\n\n- 测试：批量创建成功时返回所有单号。\n';
const spec = (): BatchSpec => ({
  mother: { kind: '需求', title: '一批改进', body },
  subs: [
    { kind: '缺陷', title: '第一项', body },
    { kind: '杂项', title: '第二项', body },
  ],
});
interface Issue {
  number: number;
  id: number;
  html_url: string;
  state: 'open' | 'closed';
  title: string;
  body: string;
  labels: string[];
}
interface Journal {
  version: number;
  id: string;
  status: string;
  issues: { number: number; id: number; url: string }[];
  uncertain: boolean;
}
interface FakeOptions {
  failCreate?: number;
  ambiguousCreate?: number;
  malformedCreate?: number;
  failAttach?: number;
  failClose?: number;
  staleClose?: number;
  failRelease?: number;
  failList?: boolean;
  malformedList?: boolean;
}

/** GitHub 假端保存真实状态：断连也可能已经建单，关闭回包也可能没有关闭。 */
function setup(options: FakeOptions = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'fleet-issue-batch-'));
  const journal = join(cwd, 'batch.json');
  const issues: Issue[] = [];
  const calls: string[][] = [];
  const attached: { parent: number; child: number }[] = [];
  const closeAttempts: number[] = [];
  const readJournal = (): Journal => JSON.parse(readFileSync(journal, 'utf8')) as Journal;
  let creates = 0;
  const gh: Gh = async (args) => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === '-X' && args[2] === 'POST') {
      if (args[3] === 'repos/{owner}/{repo}/issues') {
        creates += 1;
        if (options.failCreate === creates) return fail('create-failed');
        const input = JSON.parse(readFileSync(args[args.indexOf('--input') + 1] ?? '', 'utf8')) as {
          title: string;
          body: string;
          labels: string[];
        };
        const number = 100 + creates;
        expect(input.labels).toContain('本机做');
        const issue: Issue = {
          ...input,
          number,
          id: 9000 + number,
          html_url: `https://github.com/o/r/issues/${number}`,
          state: 'open',
        };
        issues.push(issue);
        if (options.ambiguousCreate === creates) return fail('connection-lost-after-create');
        if (options.malformedCreate === creates) return ok({ unexpected: true });
        return ok(issue);
      }
      const parent = /issues\/(\d+)\/sub_issues$/.exec(args[3] ?? '');
      if (parent) {
        const childId = Number(args.find((arg) => arg.startsWith('sub_issue_id='))?.split('=')[1]);
        const child = issues.find((issue) => issue.id === childId);
        if (!child) throw new Error(`挂接的子单不存在：${childId}`);
        // 断在挂接处也得能补偿：这一步之前，子单号必须已经同步写进 journal。
        expect(readJournal().issues.some((issue) => issue.number === child.number)).toBe(true);
        if (options.failAttach === child.number) return fail('attach-failed');
        attached.push({ parent: Number(parent[1]), child: child.number });
        return ok(child);
      }
    }
    if (args[0] === 'api' && args[1] === '-X' && args[2] === 'PATCH') {
      const number = Number(/issues\/(\d+)$/.exec(args[3] ?? '')?.[1]);
      closeAttempts.push(number);
      if (options.failClose === number) return fail(`close-failed-${number}`);
      const issue = issues.find((entry) => entry.number === number);
      if (!issue) return fail('HTTP 404');
      expect(args).toContain('state=closed');
      expect(args).toContain('state_reason=not_planned');
      if (options.staleClose !== number) issue.state = 'closed';
      return ok(issue);
    }
    if (args[0] === 'api' && args[1]?.startsWith('repos/{owner}/{repo}/issues?')) {
      expect(args).toContain('--paginate');
      expect(args).toContain('--slurp');
      expect(args[1]).toContain('state=all');
      if (options.failList) return fail('list-failed');
      if (options.malformedList) return ok({ unexpected: true });
      // 故意两页，确保不会只收第一页。
      return ok([issues.slice(0, 1), issues.slice(1)]);
    }
    if (args[0] === 'issue' && args[1] === 'edit') {
      const number = Number(args[2]);
      if (options.failRelease === number) return fail('release-failed');
      const issue = issues.find((entry) => entry.number === number);
      if (!issue) return fail('HTTP 404');
      expect(args.slice(3)).toEqual(['--remove-label', '本机做']);
      issue.labels = issue.labels.filter((label) => label !== '本机做');
      return ok(issue);
    }
    throw new Error(`假 GitHub 不认识调用：${JSON.stringify(args)}`);
  };
  const run = (input = spec()) => issueBatchNew(input, { gh, cwd, journal });
  return { cwd, journal, issues, calls, attached, closeAttempts, gh, readJournal, run };
}

describe('母单与子单原子批量创建', () => {
  it('一次返回整批，子单创建时就有 parent 独立行，原生挂接完成才解除暂存标签', async () => {
    const fake = setup();
    const result = await fake.run();
    expect(result).toMatchObject({
      mother: { number: 101, url: 'https://github.com/o/r/issues/101' },
      subs: [{ number: 102 }, { number: 103 }],
      journal: fake.journal,
    });
    expect(fake.issues[0]?.labels).toEqual(expect.arrayContaining(['需求', '母单']));
    expect(fake.issues[1]?.labels).toContain('缺陷');
    expect(fake.issues[2]?.labels).toContain('杂项');
    for (const issue of fake.issues.slice(1)) {
      expect(issue.body).toMatch(/^parent: #101$/m);
      expect(issue.body).toContain(`<!-- fleet:issue-batch:${fake.readJournal().id}:sub -->`);
    }
    expect(fake.issues[0]?.body).toContain(`<!-- fleet:issue-batch:${fake.readJournal().id}:mother -->`);
    expect(fake.attached).toEqual([
      { parent: 101, child: 102 },
      { parent: 101, child: 103 },
    ]);
    expect(fake.issues.every((issue) => !issue.labels.includes('本机做'))).toBe(true);
    const lastAttach = fake.calls.findLastIndex((args) => args[3]?.endsWith('/sub_issues'));
    const firstRelease = fake.calls.findIndex((args) => args[0] === 'issue' && args[1] === 'edit');
    expect(firstRelease).toBeGreaterThan(lastAttach);
    expect(fake.readJournal()).toMatchObject({ status: 'complete', uncertain: false });
  });

  it('本机批次全程保留本机做，不能意外释放给引擎', async () => {
    const fake = setup();
    await fake.run({ ...spec(), local: true });
    expect(fake.issues.every((issue) => issue.labels.includes('本机做'))).toBe(true);
    expect(fake.calls.some((args) => args[0] === 'issue' && args[1] === 'edit')).toBe(false);
  });

  it.each(['<!-- 未闭合注释', '```md\n未闭合围栏'])(
    '用户正文以 %s 结尾时，生成关系仍可读，创建响应模糊也能恢复整批',
    async (suffix) => {
      const input = spec();
      for (const issue of [input.mother, ...input.subs]) issue.body += `\n${suffix}`;
      const successful = setup();
      await successful.run(input);
      for (const issue of successful.issues.slice(1)) {
        expect(parentField(issue.body)).toEqual({ kind: 'parent', number: 101 });
        expect(issue.body).toMatch(/^<!-- fleet:issue-batch:[^\n]+:sub -->\nparent: #101\n/);
      }
      expect(successful.issues[0]?.body).toMatch(/^<!-- fleet:issue-batch:[^\n]+:mother -->\n/);
      const ambiguous = setup({ ambiguousCreate: 3 });
      await expect(ambiguous.run(input)).rejects.toThrow();
      expect(ambiguous.issues).toHaveLength(3);
      expect(ambiguous.issues.every((issue) => issue.state === 'closed')).toBe(true);
      expect(ambiguous.readJournal().status).toBe('rolled_back');
    },
  );

  it.each([
    [
      '空子单列表',
      (input: BatchSpec) => {
        input.subs = [];
      },
    ],
    [
      '末张子单正文不合格',
      (input: BatchSpec) => {
        if (input.subs[1]) input.subs[1].body = '没有必填节';
      },
    ],
    [
      '末张子单类别不合格',
      (input: BatchSpec) => {
        if (input.subs[1]) input.subs[1].kind = 'unknown';
      },
    ],
    [
      '母单标题空白',
      (input: BatchSpec) => {
        input.mother.title = '  ';
      },
    ],
    [
      '子单正文超长',
      (input: BatchSpec) => {
        if (input.subs[1]) input.subs[1].body += '字'.repeat(65_001);
      },
    ],
  ])('全批预检：%s 时一张都不开', async (_name, change) => {
    const fake = setup();
    const input = spec();
    change(input);
    await expect(fake.run(input)).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });

  it('挂接失败时 journal 已有新子单号，关闭它和母单，不留半截', async () => {
    const fake = setup({ failAttach: 102 });
    await expect(fake.run()).rejects.toThrow(/attach-failed/);
    expect(fake.issues.map((issue) => issue.state)).toEqual(['closed', 'closed']);
    expect(new Set(fake.closeAttempts)).toEqual(new Set([101, 102]));
    expect(fake.readJournal().status).toBe('rolled_back');
  });

  it('末张创建失败时，关闭母单和前面已经创建的子单', async () => {
    const fake = setup({ failCreate: 3 });
    await expect(fake.run()).rejects.toThrow(/create-failed/);
    expect(fake.issues.map((issue) => issue.state)).toEqual(['closed', 'closed']);
    expect(fake.readJournal().status).toBe('rolled_back');
  });

  it.each([
    ['ambiguousCreate', 1],
    ['ambiguousCreate', 3],
    ['malformedCreate', 1],
    ['malformedCreate', 3],
  ] as const)(
    '%s 第 %s 张：已经建单却没拿到可靠回包时，按 marker 找回并关闭分页中的整批',
    async (mode, index) => {
      const fake = setup({ [mode]: index });
      await expect(fake.run()).rejects.toThrow();
      expect(fake.issues).toHaveLength(index);
      expect(fake.issues.every((issue) => issue.state === 'closed')).toBe(true);
      expect(fake.readJournal().status).toBe('rolled_back');
    },
  );

  it('释放暂存标签失败也算整批失败，关闭所有子母单', async () => {
    const fake = setup({ failRelease: 102 });
    await expect(fake.run()).rejects.toThrow(/release-failed/);
    expect(fake.issues.every((issue) => issue.state === 'closed')).toBe(true);
    expect(fake.readJournal().status).toBe('rolled_back');
  });

  it.each(['failClose', 'staleClose'] as const)(
    '%s：关闭失败或回包仍为 open 时继续关闭其余单，但不能记录已回滚',
    async (mode) => {
      const fake = setup({ failAttach: 103, [mode]: 102 });
      await expect(fake.run()).rejects.toThrow();
      expect(new Set(fake.closeAttempts)).toEqual(new Set([101, 102, 103]));
      expect(fake.issues.find((issue) => issue.number === 102)?.state).toBe('open');
      expect(
        fake.issues.filter((issue) => issue.number !== 102).every((issue) => issue.state === 'closed'),
      ).toBe(true);
      expect(fake.readJournal().status).not.toBe('rolled_back');
    },
  );
});

describe('批量创建崩溃恢复', () => {
  function crashed(options: FakeOptions = {}) {
    const fake = setup(options);
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const issue = (number: number, marker: string): Issue => ({
      number,
      id: 9000 + number,
      html_url: `https://github.com/o/r/issues/${number}`,
      title: '相同标题',
      body: `${body}\n${marker}`,
      state: 'open',
      labels: ['需求', '本机做'],
    });
    fake.issues.push(
      issue(101, `<!-- fleet:issue-batch:${id}:mother -->`),
      issue(102, `<!-- fleet:issue-batch:${id}:sub -->`),
      issue(103, `<!-- fleet:issue-batch:${id}-other:sub -->`),
      issue(104, `<!-- fleet:issue-batch:${id}:invalid -->`),
      issue(105, `引用文字 <!-- fleet:issue-batch:${id}:sub --> 不是恢复标记`),
    );
    writeFileSync(
      fake.journal,
      JSON.stringify({
        version: 1,
        id,
        status: 'building',
        issues: [{ number: 101, id: 9101, url: 'https://github.com/o/r/issues/101' }],
        uncertain: true,
      }),
    );
    const recover = () => recoverIssueBatch(fake.journal, { gh: fake.gh, cwd: fake.cwd });
    return { ...fake, recover };
  }

  it('恢复 journal 并找回未落盘子单，只关闭精确 marker 所属的这一批，不重复创建', async () => {
    const fake = crashed();
    await fake.recover();
    expect(fake.issues.map((issue) => issue.state)).toEqual(['closed', 'closed', 'open', 'open', 'open']);
    expect(fake.readJournal().status).toBe('rolled_back');
    expect(fake.calls.some((args) => args[2] === 'POST')).toBe(false);
    const callsAfterRecovery = fake.calls.length;
    await fake.recover();
    expect(fake.calls).toHaveLength(callsAfterRecovery);
  });

  it.each([{ failList: true }, { malformedList: true }])(
    'marker 查找失败 %j：不能把读不到当没有遗漏，不能记录回滚完成',
    async (options) => {
      const fake = crashed(options);
      await expect(fake.recover()).rejects.toThrow();
      expect(fake.readJournal().status).not.toBe('rolled_back');
      expect(fake.calls.some((args) => args[1]?.includes('issues?state=all'))).toBe(true);
      expect(fake.issues.find((issue) => issue.number === 101)?.state).toBe('closed');
      expect(fake.issues.find((issue) => issue.number === 102)?.state).toBe('open');
    },
  );

  it('恢复时仍有关不成的单，保留可重试 journal，不能报完成', async () => {
    const fake = crashed({ failClose: 102 });
    await expect(fake.recover()).rejects.toThrow();
    expect(fake.issues.find((issue) => issue.number === 101)?.state).toBe('closed');
    expect(fake.readJournal().status).not.toBe('rolled_back');
  });

  it('成功的整批不能被恢复命令误撤销', async () => {
    const fake = setup();
    await fake.run();
    const callsBeforeRecovery = fake.calls.length;
    await expect(recoverIssueBatch(fake.journal, { gh: fake.gh, cwd: fake.cwd })).rejects.toThrow();
    expect(fake.calls).toHaveLength(callsBeforeRecovery);
    expect(fake.issues.every((issue) => issue.state === 'open')).toBe(true);
  });

  it('已有恢复记录时拒绝覆盖，不建任何新单', async () => {
    const fake = crashed();
    const before = readFileSync(fake.journal, 'utf8');
    await expect(fake.run()).rejects.toThrow();
    expect(readFileSync(fake.journal, 'utf8')).toBe(before);
    expect(fake.calls).toEqual([]);
  });

  it('恢复记录缺失或损坏时明确失败，不访问 GitHub', async () => {
    const fake = setup();
    await expect(recoverIssueBatch(fake.journal, { gh: fake.gh, cwd: fake.cwd })).rejects.toThrow();
    writeFileSync(fake.journal, '{bad-json');
    await expect(recoverIssueBatch(fake.journal, { gh: fake.gh, cwd: fake.cwd })).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });
});
