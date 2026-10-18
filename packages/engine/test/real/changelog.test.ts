import { CHANGELOG_FILE, STANDARD_PATHS_FILE } from '@fleet-dao/conventions';
import type { GhRequest, GhResponse } from '@fleet-dao/github';
import { describe, expect, it } from 'vitest';
import { changelogGitHub } from '../../src/real/changelog.ts';
import type { CiTimingsApi } from '../../src/real/ci-timings.ts';

const HEAD = 'a'.repeat(40);
const SHA = 'b'.repeat(40);
const PATHS = JSON.stringify({ paths: [{ path: 'agents/', why: '规矩' }] });
const INPUT = {
  version: 5,
  versions: [4, 5],
  baseCommit: HEAD,
  content: '# Changelog\n\nnew\n',
  title: '补齐 v4、v5 的更新日志',
  body: '**做了什么**：补齐版本\n\n**需求**：无：每天维护\n',
};

function world(
  o: {
    existing?: boolean;
    unsafe?: boolean;
    standard?: boolean;
    readFailure?: boolean;
    compareFailure?: boolean;
  } = {},
) {
  const calls: GhRequest[] = [];
  const merged: number[] = [];
  let content = o.existing ? INPUT.content : 'old';
  let labels: string[] = [];
  const api: CiTimingsApi = {
    readRepoFile: async ({ path }) => {
      if (o.readFailure) throw new Error('403');
      return {
        defaultBranch: 'main',
        commit: HEAD,
        file: {
          kind: 'text',
          text:
            path === STANDARD_PATHS_FILE
              ? o.standard
                ? JSON.stringify({ paths: [{ path: CHANGELOG_FILE, why: '测试故意当标准' }] })
                : PATHS
              : content,
        },
      };
    },
    enableAutoMerge: async (_repo, pr) => {
      merged.push(pr.number);
    },
    client: {
      async request<T = unknown>(req: GhRequest): Promise<GhResponse<T>> {
        calls.push(req);
        let status = 200;
        let data: unknown = null;
        if (req.path.endsWith('/git/refs')) {
          status = o.existing ? 422 : 201;
          data = o.existing ? { message: 'Reference already exists' } : { object: { sha: HEAD } };
        } else if (req.path.includes('/compare/')) {
          if (o.compareFailure) throw new Error('compare 503');
          data = {
            merge_base_commit: { sha: HEAD },
            files: o.unsafe
              ? [
                  { filename: CHANGELOG_FILE, status: 'modified' },
                  { filename: 'packages/engine/src/main.ts', status: 'modified' },
                ]
              : [{ filename: CHANGELOG_FILE, status: 'modified' }],
          };
        } else if (req.path.includes('/contents/')) {
          if (req.method === 'GET')
            data = {
              type: 'file',
              encoding: 'base64',
              content: Buffer.from(content).toString('base64'),
              sha: SHA,
            };
          else {
            content = INPUT.content;
            data = { commit: { sha: SHA } };
          }
        } else if (req.path.endsWith('/pulls')) {
          const pull = {
            number: 50,
            node_id: 'PR_50',
            html_url: 'https://github.com/thoerwink8/fleet-dao/pull/50',
          };
          data = req.method === 'GET' ? (o.existing ? [pull] : []) : pull;
        } else if (req.path.endsWith('/labels')) {
          if (req.method === 'POST') labels = (req.body as { labels: string[] }).labels;
          data = labels.map((name) => ({ name }));
        } else throw new Error(`测试没有处理 ${req.method} ${req.path}`);
        return { status, data: data as T, headers: new Headers() };
      },
      async all<T = unknown>(req: GhRequest): Promise<T[]> {
        calls.push(req);
        if (req.path.endsWith('/milestones'))
          return [
            {
              number: 4,
              title: 'v4',
              state: 'closed',
              description: 'cut',
              closed_at: '2026-10-19T00:00:00Z',
              due_on: '2026-10-18T00:00:00Z',
            },
          ] as T[];
        if (req.path.endsWith('/issues'))
          return [
            {
              number: 7,
              title: '能导出任务',
              state: 'closed',
              state_reason: 'completed',
              labels: [{ name: '需求' }],
              created_at: '2026-10-12T00:00:00Z',
              milestone: { title: 'v4' },
            },
          ] as T[];
        throw new Error(`测试没有处理 all ${req.path}`);
      },
    },
  };
  return { github: changelogGitHub(api), calls, merged };
}

describe('更新日志的真实GitHub装配：假请求', () => {
  it('主线文件、里程碑和单按引擎身份分页读取，不用搜索索引', async () => {
    const w = world();
    expect(await w.github.readHead()).toEqual({ commit: HEAD, text: 'old' });
    expect((await w.github.milestones())[0]).toMatchObject({ number: 4, state: 'closed' });
    expect((await w.github.milestoneIssues(4))[0]).toMatchObject({ number: 7, stateReason: 'completed' });
    expect(w.calls).toHaveLength(2);
    for (const call of w.calls) expect(call.auth).toMatchObject({ as: 'engine' });
    expect(w.calls[0]?.query).toMatchObject({ state: 'closed', per_page: 100 });
    expect(w.calls[1]?.query).toMatchObject({ state: 'all', milestone: 4, per_page: 100 });
  });
  it('从精确提交建changelog/v5，只写CHANGELOG；复用受管标准/卫生/标签/自动squash合并模板', async () => {
    const w = world();
    expect(await w.github.openPr(INPUT)).toMatchObject({ number: 50 });
    expect(w.calls.find((c) => c.path.endsWith('/git/refs'))?.body).toEqual({
      ref: 'refs/heads/changelog/v5',
      sha: HEAD,
    });
    const write = w.calls.find((c) => c.method === 'PUT');
    expect(write?.path).toBe('/repos/thoerwink8/fleet-dao/contents/CHANGELOG.md');
    expect(write?.body).toMatchObject({
      branch: 'changelog/v5',
      sha: SHA,
      content: Buffer.from(INPUT.content).toString('base64'),
    });
    expect(w.calls.find((c) => c.method === 'POST' && c.path.endsWith('/pulls'))?.body).toMatchObject({
      base: 'main',
      head: 'changelog/v5',
    });
    expect(w.merged).toEqual([50]);
  });
  it('同一分支/相同内容重跑复用PR，不重写文件或再创建PR', async () => {
    const w = world({ existing: true });
    await w.github.openPr(INPUT);
    expect(
      w.calls.some((c) => c.method === 'PUT' || (c.method === 'POST' && c.path.endsWith('/pulls'))),
    ).toBe(false);
    expect(w.merged).toEqual([50]);
  });
  it.each([
    { standard: true },
    { readFailure: true },
    { existing: true, unsafe: true },
    { existing: true, compareFailure: true },
  ])('【故意失败】标准/读失败/分支混入其他文件都不开PR：%j', async (o) => {
    const w = world(o);
    await expect(w.github.openPr(INPUT)).rejects.toThrow();
    expect(
      w.calls.some((c) => c.method === 'PUT' || (c.method === 'POST' && c.path.endsWith('/pulls'))),
    ).toBe(false);
    expect(w.merged).toEqual([]);
  });
});
