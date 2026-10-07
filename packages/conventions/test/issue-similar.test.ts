// 开单先查旧单（issue-similar.ts，#995 拍 3）：认「像」的几条、读候选的几条、给人看的几行。
// 故意造出的失败：读不到 GitHub、读回来认不出，都要写成「没查成」，不能是「没有重复」；不像的要真不列。
import { describe, expect, it } from 'vitest';
import type { GhResult } from '../src/issue-new.ts';
import {
  type Candidate,
  keywords,
  modulePaths,
  rankSimilar,
  renderSimilar,
  similarIssues,
} from '../src/issue-similar.ts';

const ok = (data: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
const issueRow = (number: number, title: string, body = '', extra: Record<string, unknown> = {}) => ({
  number,
  title,
  body,
  ...extra,
});
const pullRow = (
  number: number,
  title: string,
  body = '',
  mergedAt: string | null = '2026-10-05T00:00:00Z',
) => ({
  number,
  title,
  body,
  merged_at: mergedAt,
});

const cand = (number: number, title: string, body = '', kind: Candidate['kind'] = 'issue'): Candidate => ({
  number,
  title,
  body,
  kind,
});

describe('关键词和路径', () => {
  it('英文单词、中文两字词；含「的、了、没有」这类常见字的两字词不算', () => {
    const k = keywords('偶发超时：engine 的 worker 没有重试');
    expect(k).toContain('偶发');
    expect(k).toContain('超时');
    expect(k).toContain('engine');
    expect(k).toContain('worker');
    expect(k).toContain('重试');
    expect(k).not.toContain('没有');
    expect(k).not.toContain('的 ');
  });

  it('正文里的文件路径认得出，带目录的多记它所在的目录；别的仓的写法、普通文字不认', () => {
    const p = modulePaths(
      '- packages/engine/src/runner/segment-prompt.ts 要改\n- 另见 docs/design.md。\n- 一般的话 a/b',
    );
    expect(p).toContain('packages/engine/src/runner/segment-prompt.ts');
    expect(p).toContain('packages/engine/src/runner');
    expect(p).toContain('docs/design.md');
    expect(p.size).toBe(3);
  });
});

describe('rankSimilar：认出像的、不列不像的', () => {
  const query = { title: '引擎偶发超时要自动重试', body: '- packages/engine/src/jobs/retry.ts' };

  it('标题关键词重合多的列出来，写明为什么像', () => {
    const r = rankSimilar(query, [cand(353, '引擎偶发超时：自动重试一次')]);
    expect(r).toEqual([expect.objectContaining({ number: 353, kind: 'issue' })]);
    expect(r[0]?.why).toContain('标题里都有');
  });

  it('标题不像、可是都提到同一个文件：也列（模块重合），写明是哪个文件', () => {
    const r = rankSimilar(query, [
      cand(400, '飞书消息排版', '要改 packages/engine/src/jobs/retry.ts 的日志', 'issue'),
      cand(401, '飞书消息排版', '要改 packages/engine/src/jobs/other.ts', 'issue'),
    ]);
    // 只提到一个共同文件、标题又完全不像：不够，不列（0.3 < 0.45）
    expect(r).toEqual([]);
    const two = rankSimilar(
      {
        title: '飞书消息排版',
        body: '- packages/engine/src/jobs/retry.ts\n- packages/engine/src/jobs/send.ts',
      },
      [cand(402, '换个说法', 'packages/engine/src/jobs/retry.ts packages/engine/src/jobs/send.ts')],
    );
    expect(two.map((s) => s.number)).toEqual([402]);
    expect(two[0]?.why).toContain('都提到 packages/engine/src/jobs/retry.ts');
  });

  it('完全不像的不列；合并了的 PR 也认，标成 pull', () => {
    const r = rankSimilar(query, [
      cand(1, '登录页加验证码', '登录页'),
      cand(2, '引擎偶发超时已经自动重试', '', 'pull'),
    ]);
    expect(r.map((s) => [s.number, s.kind])).toEqual([[2, 'pull']]);
  });

  it('最多列 5 条，像得多的在前', () => {
    const many = Array.from({ length: 8 }, (_, i) => cand(10 + i, `引擎偶发超时自动重试${'补'.repeat(i)}`));
    const r = rankSimilar(query, many);
    expect(r).toHaveLength(5);
    expect(r[0]?.score).toBeGreaterThanOrEqual(r[4]?.score ?? 0);
  });
});

describe('similarIssues：读候选', () => {
  const route = (over: {
    issues?: unknown;
    pulls?: unknown;
    failIssues?: GhResult;
    failPulls?: GhResult;
  }) => {
    const calls: string[] = [];
    const gh = async (args: string[]): Promise<GhResult> => {
      calls.push(args[1] ?? '');
      if (args[1]?.includes('/issues?')) return over.failIssues ?? ok(over.issues ?? []);
      if (args[1]?.includes('/pulls?')) return over.failPulls ?? ok(over.pulls ?? []);
      return { code: 1, stdout: '', stderr: `假 gh 不认得：${args.join(' ')}` };
    };
    return { gh, calls };
  };
  const q = { title: '引擎偶发超时要自动重试', body: '' };

  it('开着的单和合并了的 PR 都读；issues 接口里混着的 PR 不当单；关了没合并的 PR 不算', async () => {
    const { gh } = route({
      issues: [
        issueRow(353, '引擎偶发超时：自动重试'),
        issueRow(9, '引擎偶发超时自动重试', '', { pull_request: {} }),
      ],
      pulls: [
        pullRow(720, '引擎偶发超时自动重试已做', '', '2026-10-01T00:00:00Z'),
        pullRow(721, '引擎偶发超时自动重试', '', null),
      ],
    });
    const r = await similarIssues(gh, q);
    expect(r.unchecked).toBeUndefined();
    expect(r.found.map((s) => [s.number, s.kind])).toEqual(
      expect.arrayContaining([
        [353, 'issue'],
        [720, 'pull'],
      ]),
    );
    expect(r.found.map((s) => s.number)).not.toContain(9);
    expect(r.found.map((s) => s.number)).not.toContain(721);
  });

  it('没有像的：found 空、没有 unchecked（真的查过、没有）', async () => {
    const { gh } = route({ issues: [issueRow(1, '登录页加验证码')] });
    expect(await similarIssues(gh, q)).toEqual({ found: [] });
  });

  it('【故意造出的失败】读不到开着的单：写成没查成和原因，不是「没有重复」，也不抛', async () => {
    const { gh } = route({ failIssues: { code: 1, stdout: '', stderr: 'HTTP 502' } });
    const r = await similarIssues(gh, q);
    expect(r.found).toEqual([]);
    expect(r.unchecked).toMatch(/读开着的单失败.*HTTP 502/);
  });

  it('【故意造出的失败】读不到 PR：同样没查成', async () => {
    const { gh } = route({ failPulls: { code: 1, stdout: '', stderr: 'HTTP 500' } });
    expect((await similarIssues(gh, q)).unchecked).toMatch(/读最近关掉的 PR失败/);
  });

  it('【故意造出的失败】读回来不是列表、缺 merged_at、缺标题：都是没查成', async () => {
    expect((await similarIssues(route({ issues: { message: 'x' } }).gh, q)).unchecked).toMatch(/不是列表/);
    expect(
      (await similarIssues(route({ pulls: [{ number: 1, title: 't', body: '' }] }).gh, q)).unchecked,
    ).toMatch(/没有 merged_at/);
    expect((await similarIssues(route({ issues: [{ number: 1, body: '' }] }).gh, q)).unchecked).toMatch(
      /认不出/,
    );
  });

  it('【故意造出的失败】开着的单一页读满又翻不完（超过 10 页）：没读全，不当成没有', async () => {
    const full = Array.from({ length: 100 }, (_, i) => issueRow(i + 1, `无关 ${i}`));
    const { gh } = route({ issues: full });
    expect((await similarIssues(gh, q)).unchecked).toMatch(/没读全/);
  });
});

describe('renderSimilar：给人看的几行', () => {
  it('有像的：逐条列、说明单已经开了、给「是重复就这么关」', () => {
    const lines = renderSimilar(
      { found: [{ number: 353, title: '偶发超时', kind: 'issue', score: 0.7, why: '标题里都有「超时」' }] },
      900,
    );
    expect(lines[0]).toContain('可能重复的');
    expect(lines[1]).toContain('#353（开着的单）偶发超时：标题里都有「超时」');
    expect(lines.join('\n')).toContain('pnpm issue:close 900 --reason duplicate');
  });

  it('没查成：写明原因，提醒自己去搜，不能是空', () => {
    const lines = renderSimilar({ found: [], unchecked: '读开着的单失败（退出码 1）：HTTP 502' }, 900);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('没查成');
    expect(lines[0]).toContain('HTTP 502');
  });

  it('查过、没有像的：什么也不说', () => {
    expect(renderSimilar({ found: [] }, 900)).toEqual([]);
  });
});
