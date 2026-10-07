// 每周刷新耗时表的 GitHub 接线：注入假的请求，不连 GitHub。
// 开 PR 的顺序（建分支、写文件、开 PR、挂自动合并）、碰到标准路径时什么都不写、日志认不出时记没查成。
import { readFileSync } from 'node:fs';
import { parseRunLog, STANDARD_PATHS_FILE, TIMINGS_FILE } from '@fleet-dao/conventions';
import type { GhRequest, GhResponse, GitHub } from '@fleet-dao/github';
import { describe, expect, it } from 'vitest';
import { type CiTimingsApi, ciTimingsGitHub } from '../../src/real/ci-timings.ts';

const PATHS = readFileSync(new URL('../../../conventions/standard-paths.json', import.meta.url), 'utf8');
const COMMIT = 'a'.repeat(40);
const AT = new Date('2026-10-07T01:00:00Z');

interface Call {
  method: string;
  path: string;
  body?: unknown;
  query?: unknown;
}

function world(handlers: {
  request?: (call: Call) => { status: number; data: unknown };
  all?: (call: Call) => unknown;
  read?: GitHub['readRepoFile'];
  merge?: () => Promise<void>;
}) {
  const calls: Call[] = [];
  const merged: { number: number; nodeId: string }[] = [];
  const api: CiTimingsApi = {
    client: {
      async request<T = unknown>(req: GhRequest): Promise<GhResponse<T>> {
        const call: Call = { method: req.method, path: req.path };
        if (req.body !== undefined) call.body = req.body;
        if (req.query !== undefined) call.query = req.query;
        calls.push(call);
        const res = handlers.request?.(call) ?? { status: 200, data: null };
        return { status: res.status, data: res.data as T, headers: new Headers() };
      },
      async all<T = unknown>(req: GhRequest, itemsOf: (data: unknown) => unknown = (d) => d): Promise<T[]> {
        const call: Call = { method: req.method, path: req.path };
        if (req.query !== undefined) call.query = req.query;
        calls.push(call);
        const data = handlers.all?.(call) ?? { jobs: [] };
        const items = itemsOf(data);
        if (!Array.isArray(items)) throw new Error('not array');
        return items as T[];
      },
    },
    readRepoFile:
      handlers.read ??
      (async () => ({
        defaultBranch: 'main',
        commit: COMMIT,
        file: { kind: 'text' as const, text: PATHS },
      })),
    enableAutoMerge: async (_repo, pull) => {
      merged.push(pull);
      await handlers.merge?.();
    },
  };
  return { github: ciTimingsGitHub(api), calls, merged };
}

describe('耗时表的 GitHub 接线', () => {
  it('测试台日志补上 job 名前缀，parseRunLog 认得出；lint 的日志不下载', async () => {
    const { github, calls } = world({
      all: () => ({
        jobs: [
          { id: 7, name: 'test (1/6)', conclusion: 'success' },
          { id: 8, name: 'lint', conclusion: 'success' },
        ],
      }),
      request: () => ({
        status: 200,
        data: '2026-10-07T00:00:00.0000000Z ✓ packages/engine/test/a.test.ts (1 test) 500ms',
      }),
    });
    const text = await github.runLog('101');
    expect(parseRunLog(text).get('packages/engine/test/a.test.ts')).toBe(500);
    expect(calls.map((c) => c.path).join('\n')).toContain('/actions/jobs/7/logs');
    expect(calls.map((c) => c.path).join('\n')).not.toContain('/actions/jobs/8/logs');
  });

  it('【故意造出的失败】运行列表、job 列表认不出：没查成，不当成一轮都没有', async () => {
    const list = world({ request: () => ({ status: 200, data: { total_count: 0 } }) });
    await expect(list.github.listSuccessfulRuns(40)).rejects.toThrow(/没查成/);

    const jobs = world({
      all: () => ({ total_count: 1 }),
      request: () => {
        throw new Error('不该下日志');
      },
    });
    await expect(jobs.github.successfulTestBoxes('101')).rejects.toThrow(/没查成/);
    expect(jobs.calls.some((c) => c.path.includes('/logs'))).toBe(false);
  });

  it('运行列表只取 PR 触发的：请求带 event=pull_request，返回里混进主线运行就没查成', async () => {
    const ok = world({
      request: () => ({
        status: 200,
        data: {
          workflow_runs: [
            { id: 11, event: 'pull_request' },
            { id: 12, event: 'pull_request' },
          ],
        },
      }),
    });
    await expect(ok.github.listSuccessfulRuns(40)).resolves.toEqual([{ id: '11' }, { id: '12' }]);
    expect(ok.calls[0]?.path).toContain('/actions/workflows/ci.yml/runs');
    expect(ok.calls[0]?.query).toMatchObject({ status: 'success', event: 'pull_request' });

    // 【故意造出的失败】列表里混进主线（push）运行、或认不出 event：不悄悄用主线日志
    for (const event of ['push', undefined]) {
      const mixed = world({
        request: () => ({
          status: 200,
          data: {
            workflow_runs: [
              { id: 11, event: 'pull_request' },
              { id: 13, event },
            ],
          },
        }),
      });
      await expect(mixed.github.listSuccessfulRuns(40)).rejects.toThrow(/没查成.*13.*不是 PR/);
    }
  });

  it('文件树被截断：没查成，不拿列不全的清单当仓里的测试文件', async () => {
    const { github } = world({
      read: async () => ({
        defaultBranch: 'main',
        commit: COMMIT,
        file: { kind: 'missing' },
      }),
      request: () => ({ status: 200, data: { truncated: true, tree: [] } }),
    });
    await expect(github.readHead()).rejects.toThrow(/没查成/);
  });

  it('开 PR：从读到的提交拉分支、写入、开 PR、挂自动合并；正文不写 Closes', async () => {
    const content = '{ "files": {} }\n';
    const { github, calls, merged } = world({
      request: (call) => {
        if (call.method === 'POST' && call.path.endsWith('/git/refs')) {
          expect(call.body).toMatchObject({ ref: 'refs/heads/ci-timings/2026-10-07', sha: COMMIT });
          return { status: 201, data: {} };
        }
        if (call.method === 'GET' && call.path.includes('/contents/')) return { status: 404, data: null };
        if (call.method === 'PUT') {
          const body = call.body as { content: string; branch: string; sha?: string };
          expect(Buffer.from(body.content, 'base64').toString('utf8')).toBe(content);
          expect(body.branch).toBe('ci-timings/2026-10-07');
          expect(body.sha).toBeUndefined();
          return { status: 201, data: { commit: { sha: 'b'.repeat(40) } } };
        }
        if (call.method === 'GET' && call.path.endsWith('/pulls')) return { status: 200, data: [] };
        if (call.method === 'POST' && call.path.endsWith('/pulls')) {
          const body = call.body as { head: string; base: string; body: string };
          expect(body.head).toBe('ci-timings/2026-10-07');
          expect(body.base).toBe('main');
          expect(body.body).toContain('无：');
          expect(body.body).not.toMatch(/Closes\s+#/i);
          return {
            status: 201,
            data: {
              number: 321,
              node_id: 'PR_node',
              html_url: 'https://github.com/thoerwink8/fleet-dao/pull/321',
            },
          };
        }
        throw new Error(`没想到的请求 ${call.method} ${call.path}`);
      },
    });
    const pr = await github.openPr({
      title: '刷新 CI 测试耗时表',
      body: '**需求**：无：每周定时刷新 CI 测试耗时表，没有对应的单\n',
      content,
      baseCommit: COMMIT,
      at: AT,
    });
    expect(pr).toEqual({ number: 321, url: 'https://github.com/thoerwink8/fleet-dao/pull/321' });
    expect(merged).toEqual([{ number: 321, nodeId: 'PR_node' }]);
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    expect(calls.some((c) => c.path.includes(STANDARD_PATHS_FILE) || c.path.includes(TIMINGS_FILE))).toBe(
      true,
    );
  });

  it('标准路径清单读不到：没查成，分支都不建', async () => {
    const { github, calls } = world({
      read: async () => {
        throw new Error('GitHub 回了 500');
      },
      request: () => {
        throw new Error('不该请求 GitHub');
      },
    });
    await expect(
      github.openPr({
        title: '刷新 CI 测试耗时表',
        body: '**需求**：无：没有对应的单\n',
        content: '{}\n',
        baseCommit: COMMIT,
        at: AT,
      }),
    ).rejects.toThrow(/没查成/);
    expect(calls).toEqual([]);
  });

  it('碰到标准路径：分支都不建', async () => {
    const { github, calls, merged } = world({
      read: async () => ({
        defaultBranch: 'main',
        commit: COMMIT,
        file: {
          kind: 'text' as const,
          text: JSON.stringify({ paths: [{ path: TIMINGS_FILE, why: '测试用，让这次命中人闸' }] }),
        },
      }),
      request: () => {
        throw new Error('不该请求 GitHub');
      },
    });
    await expect(
      github.openPr({
        title: '刷新 CI 测试耗时表',
        body: '**需求**：无：没有对应的单\n',
        content: '{}\n',
        baseCommit: COMMIT,
        at: AT,
      }),
    ).rejects.toThrow(/人闸：改标准/);
    expect(calls).toEqual([]);
    expect(merged).toEqual([]);
  });

  it('同一天再跑：分支已在、文件已是新的，复用开着的 PR；自动合并挂过了不当失败', async () => {
    const content = '{ "files": {} }\n';
    const { github, calls, merged } = world({
      merge: async () => {
        throw new Error('auto merge is already enabled');
      },
      request: (call) => {
        if (call.method === 'POST' && call.path.endsWith('/git/refs')) {
          return { status: 422, data: { message: 'Reference already exists' } };
        }
        if (call.method === 'GET' && call.path.includes('/contents/')) {
          return {
            status: 200,
            data: {
              type: 'file',
              encoding: 'base64',
              sha: 'blob',
              content: Buffer.from(content, 'utf8').toString('base64'),
            },
          };
        }
        if (call.method === 'GET' && call.path.endsWith('/pulls')) {
          return {
            status: 200,
            data: [{ number: 9, node_id: 'N', html_url: 'https://github.com/thoerwink8/fleet-dao/pull/9' }],
          };
        }
        throw new Error(`不该再请求 ${call.method} ${call.path}`);
      },
    });
    const pr = await github.openPr({
      title: '刷新 CI 测试耗时表',
      body: '**需求**：无：没有对应的单\n',
      content,
      baseCommit: COMMIT,
      at: AT,
    });
    expect(pr.number).toBe(9);
    expect(calls.some((c) => c.method === 'PUT' || (c.method === 'POST' && c.path.endsWith('/pulls')))).toBe(
      false,
    );
    expect(merged).toEqual([{ number: 9, nodeId: 'N' }]);
  });
});
