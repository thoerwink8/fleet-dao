// 关单对账（#241）读的仓现状：主线上 specs/ 下两层的文件、开着的单连同子单、最近关掉的单、开着的 PR，按游标翻完。
// 读不到、形状认不出、翻不完一律抛错（调用方记没查成），不拿「一张都没有」顶；仓里没有 specs/ 是 null，和没读到分开。
import { describe, expect, it } from 'vitest';
import {
  CLOSE_CLOSED_ISSUES_QUERY,
  CLOSE_FACTS_MAX_PAGES,
  CLOSE_MERGED_PULLS_QUERY,
  CLOSE_OPEN_ISSUES_QUERY,
  CLOSE_OPEN_PULLS_QUERY,
  CLOSE_SPECS_QUERY,
  readCloseFacts,
} from '../src/close-facts.ts';
import { isGitHubError } from '../src/errors.ts';

const repo = { owner: 'o', name: 'r' };
const SINCE = new Date('2026-08-29T01:00:00Z');

const tree = (dirs: Record<string, string[]>) => ({
  repository: {
    object: {
      __typename: 'Tree',
      entries: [
        { name: 'README.md', type: 'blob', object: { __typename: 'Blob' } },
        ...Object.entries(dirs).map(([name, files]) => ({
          name,
          type: 'tree',
          object: { __typename: 'Tree', entries: files.map((f) => ({ name: f, type: 'blob' })) },
        })),
      ],
    },
  },
});
const conn = (field: 'issues' | 'pullRequests', nodes: unknown[], next: string | null = null) => ({
  repository: { [field]: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } },
});

type Answer = (vars: Record<string, unknown>) => unknown;

/** 假的 graphql：按查的是哪一条回话；calls 记下每次的变量。 */
function client(answers: Partial<Record<'specs' | 'open' | 'closed' | 'pulls' | 'merged', Answer>>) {
  const calls: { which: string; vars: Record<string, unknown> }[] = [];
  const which = (q: string) =>
    q === CLOSE_SPECS_QUERY
      ? 'specs'
      : q === CLOSE_OPEN_ISSUES_QUERY
        ? 'open'
        : q === CLOSE_CLOSED_ISSUES_QUERY
          ? 'closed'
          : q === CLOSE_OPEN_PULLS_QUERY
            ? 'pulls'
            : q === CLOSE_MERGED_PULLS_QUERY
              ? 'merged'
              : 'unknown';
  return {
    calls,
    c: {
      async graphql<T>(auth: unknown, query: string, vars: Record<string, unknown>): Promise<T> {
        expect(auth).toEqual({ as: 'engine', repo });
        const w = which(query) as keyof typeof answers;
        calls.push({ which: w, vars });
        const a = answers[w];
        if (!a) throw new Error(`假 graphql 没准备 ${w}`);
        return a(vars) as T;
      },
    },
  };
}

const defaults = {
  specs: () => tree({ '12-登录': ['需求.md', '结果.md'], '13-x': ['需求.md'] }),
  open: () =>
    conn('issues', [
      { number: 12, title: '登录', subIssues: { totalCount: 0, nodes: [] } },
      {
        number: 20,
        title: '母单',
        subIssues: {
          totalCount: 2,
          nodes: [
            { number: 21, state: 'CLOSED' },
            { number: 22, state: 'OPEN' },
          ],
        },
      },
    ]),
  closed: () =>
    conn('issues', [
      { number: 50, title: '关了', stateReason: 'COMPLETED', closedAt: '2026-09-27T10:00:00Z' },
      { number: 51, title: '不做了', stateReason: 'NOT_PLANNED', closedAt: '2026-09-27T10:00:00Z' },
    ]),
  pulls: () => conn('pullRequests', [{ number: 90, title: 't', body: '**需求**：#12' }]),
  merged: () =>
    conn('pullRequests', [
      { number: 91, title: 't2', body: '**需求**：#13', updatedAt: '2026-09-27T10:00:00Z' },
    ]),
};

describe('关单对账读的仓现状', () => {
  it('一次读全：specs/ 两层的文件、开着的单连同子单、最近关掉的单（原因小写）、开着的 PR、最近合并的 PR', async () => {
    const { c, calls } = client(defaults);
    expect(await readCloseFacts(c, { repo, since: SINCE })).toEqual({
      specsFiles: ['specs/12-登录/需求.md', 'specs/12-登录/结果.md', 'specs/13-x/需求.md'],
      openIssues: [
        { number: 12, title: '登录', subIssues: { total: 0, open: [], closed: [] } },
        { number: 20, title: '母单', subIssues: { total: 2, open: [22], closed: [21] } },
      ],
      closedIssues: [
        { number: 50, title: '关了', stateReason: 'completed', closedAt: '2026-09-27T10:00:00Z' },
        { number: 51, title: '不做了', stateReason: 'not_planned', closedAt: '2026-09-27T10:00:00Z' },
      ],
      openPulls: [{ number: 90, title: 't', body: '**需求**：#12' }],
      mergedPulls: [{ number: 91, title: 't2', body: '**需求**：#13' }],
    });
    expect(calls.find((x) => x.which === 'closed')?.vars.since).toBe(SINCE.toISOString());
  });

  it('合并的 PR 按 updatedAt 翻到早于 since 就停：停之前的都要，游标不再往下翻', async () => {
    const { c, calls } = client({
      ...defaults,
      merged: (v) =>
        v.after === null
          ? conn(
              'pullRequests',
              [
                { number: 3, title: '新', body: '', updatedAt: '2026-09-27T10:00:00Z' },
                { number: 2, title: '旧', body: '', updatedAt: '2026-08-01T10:00:00Z' },
              ],
              'C1',
            )
          : conn('pullRequests', [{ number: 1, title: '更旧', body: '', updatedAt: '2026-07-01T10:00:00Z' }]),
    });
    const got = await readCloseFacts(c, { repo, since: SINCE });
    expect(got.mergedPulls.map((p) => p.number)).toEqual([3]);
    expect(calls.filter((x) => x.which === 'merged')).toHaveLength(1);
  });

  it('按游标翻完：有下一页就接着读，游标照传', async () => {
    const { c, calls } = client({
      ...defaults,
      open: (v) =>
        v.after === null
          ? conn('issues', [{ number: 1, title: 'a', subIssues: { totalCount: 0, nodes: [] } }], 'C1')
          : conn('issues', [{ number: 2, title: 'b', subIssues: { totalCount: 0, nodes: [] } }]),
    });
    const got = await readCloseFacts(c, { repo, since: SINCE });
    expect(got.openIssues.map((i) => i.number)).toEqual([1, 2]);
    expect(calls.filter((x) => x.which === 'open').map((x) => x.vars.after)).toEqual([null, 'C1']);
  });

  it('仓里没有 specs/：specsFiles 是 null（这个仓不按「关单要有结果」查），不是没读到', async () => {
    const { c } = client({ ...defaults, specs: () => ({ repository: { object: null } }) });
    expect((await readCloseFacts(c, { repo, since: SINCE })).specsFiles).toBeNull();
  });

  const failures: [
    string,
    Partial<Record<'specs' | 'open' | 'closed' | 'pulls' | 'merged', Answer>>,
    string,
  ][] = [
    ['仓读不到（没装到这个仓）', { specs: () => ({ repository: null }) }, 'NOT_FOUND'],
    [
      'specs 不是目录',
      { specs: () => ({ repository: { object: { __typename: 'Blob' } } }) },
      'UNEXPECTED_RESPONSE',
    ],
    ['开着的单形状不对', { open: () => ({ repository: { issues: { nodes: 'x' } } }) }, 'UNEXPECTED_RESPONSE'],
    ['开着的单里有一条认不出', { open: () => conn('issues', [{ number: 'x' }]) }, 'UNEXPECTED_RESPONSE'],
    [
      '关着的单没有关单时刻',
      {
        closed: () => conn('issues', [{ number: 50, title: 'x', stateReason: 'COMPLETED', closedAt: null }]),
      },
      'UNEXPECTED_RESPONSE',
    ],
    ['说有下一页却没给游标', { pulls: () => conn('pullRequests', [], '') }, 'UNEXPECTED_RESPONSE'],
    [
      `翻了 ${CLOSE_FACTS_MAX_PAGES} 页还没完`,
      { pulls: () => conn('pullRequests', [{ number: 1, title: 't', body: '' }], 'next') },
      'TOO_MANY_PAGES',
    ],
    [
      '合并的 PR 形状不对（少了 updatedAt）',
      { merged: () => conn('pullRequests', [{ number: 1, title: 't', body: '' }]) },
      'UNEXPECTED_RESPONSE',
    ],
    [
      '合并的 PR 更新时刻认不出：判不了该不该停，没查成',
      { merged: () => conn('pullRequests', [{ number: 1, title: 't', body: '', updatedAt: '昨天' }]) },
      'UNEXPECTED_RESPONSE',
    ],
    [
      `合并的 PR 每一条都比 since 新：翻了 ${CLOSE_FACTS_MAX_PAGES} 页还没到停的地方，没查全`,
      {
        merged: () =>
          conn(
            'pullRequests',
            [{ number: 1, title: 't', body: '', updatedAt: '2026-09-27T10:00:00Z' }],
            'next',
          ),
      },
      'TOO_MANY_PAGES',
    ],
  ];

  it.each(failures)(
    '【故意造出的失败】%s：抛错（调用方记没查成），不拿一张都没有顶',
    async (_name, over, code) => {
      const { c } = client({ ...defaults, ...over });
      const err = await readCloseFacts(c, { repo, since: SINCE }).catch((e: unknown) => e);
      expect(isGitHubError(err) && err.code).toBe(code);
    },
  );
});
