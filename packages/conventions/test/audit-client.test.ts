import { describe, expect, it, vi } from 'vitest';
import { auditClient, auditGhFetch } from '../src/audit-client.ts';
import { auditGitHub } from '../src/github-audit.ts';
import type { GhReadResult, RunGhRead } from '../src/plan-reader.ts';
import { issue, order, V1 } from './fake-github.ts';

const API = 'https://api.github.com/repos/o/r';
const at = new Date('2026-10-18T00:00:00Z');
const http = (data: unknown, status = 200, headers = ''): GhReadResult => ({
  code: status >= 400 ? 1 : 0,
  stdout: `HTTP/2.0 ${status} status\r\n${headers ? `${headers}\r\n` : ''}\r\n${JSON.stringify(data)}`,
});
const row = (number: number) => ({
  number,
  title: `单${number}`,
  body: '',
  state: 'open',
  created_at: '2026-10-18T00:00:00Z',
  labels: [{ name: '缺陷' }, { name: '域:engine' }, { name: '性质:bug' }],
  milestone: { title: V1 },
  sub_issues_summary: { total: 0, completed: 0 },
});

function runner(routes: Record<string, GhReadResult>) {
  return vi.fn<RunGhRead>(async (args) =>
    args[0] === 'config'
      ? { code: 0, stdout: 'test-socket' }
      : (routes[args.at(-1) ?? ''] ?? http({ message: 'not found' }, 404)),
  );
}

describe('audit 显式 gh socket 读取，沿用完整对账判据', () => {
  it('分页全读且缺类别真实报 finding，不直连、不读 token', async () => {
    const first = `${API}/issues?state=open&per_page=100`;
    const next = `${first}&page=2`;
    const missing = { ...row(2), labels: [] };
    const run = runner({
      [first]: http([row(1)], 200, `Link: <${next}>; rel="next"`),
      [next]: http([missing]),
      [`${API}/milestones?state=all&per_page=100`]: http([
        {
          number: 8,
          title: V1,
          state: 'open',
          description: order(1, 2),
          closed_at: null,
          due_on: '2099-12-31T00:00:00Z',
        },
      ]),
      [`${API}/issues?milestone=8&state=all&per_page=100`]: http([row(1), missing]),
      [`${API}/issues?state=all&per_page=100`]: http([row(1), missing]),
      [`${API}/pulls?state=open&per_page=100`]: http([]),
      [`${API}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1`]: http([]),
    });
    const direct = vi.fn<typeof fetch>();
    const token = vi.fn(() => {
      throw new Error('不可读取 token');
    });
    const gh = await auditClient('o/r', {}, { runGh: run, fetchImpl: direct, token });
    const result = await auditGitHub(gh, at, gh, { reader: gh, writer: gh });
    expect(result.checked.issues).toBe(2);
    expect(result.notQueried).toEqual([]);
    expect(result.findings.some((f) => f.issue === 2)).toBe(true);
    expect(direct).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
    expect(run.mock.calls.some(([args]) => args.at(-1) === next)).toBe(true);
  });

  it.each([
    http({}, 401),
    { code: null, stdout: '', failure: 'transport' as const },
    http({ invalid: true }),
  ])('401/超时/非法列表不得当空绿：%j', async (failure) => {
    const run = runner({ [`${API}/issues?state=open&per_page=100`]: failure });
    const gh = await auditClient('o/r', {}, { runGh: run });
    const result = await auditGitHub(gh, at);
    expect(result.open).toBeUndefined();
    expect(result.notQueried.some((line) => line.includes('开着的单'))).toBe(true);
  });

  it('Actions 不探 gh、不在 HTTP 401 后换身份重试', async () => {
    const run = vi.fn<RunGhRead>();
    const direct = vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 }));
    const gh = await auditClient(
      'o/r',
      { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 'test' },
      { runGh: run, fetchImpl: direct },
    );
    await expect(gh.openIssues()).rejects.toThrow('401');
    expect(run).not.toHaveBeenCalled();
    expect(direct).toHaveBeenCalledTimes(1);
  });

  it('无 socket 用原 HTTP，显式配置读取失败报错不fallback', async () => {
    const direct = vi.fn<typeof fetch>(async () => new Response('[]'));
    const gh = await auditClient(
      'o/r',
      { GITHUB_TOKEN: 'test' },
      { runGh: async () => ({ code: 0, stdout: '' }), fetchImpl: direct },
    );
    expect(await gh.openIssues()).toEqual([]);
    await expect(
      auditClient('o/r', {}, { runGh: async () => ({ code: 1, stdout: '' }), fetchImpl: direct }),
    ).rejects.toThrow('传输配置');
    expect(direct).toHaveBeenCalledTimes(1);
  });
});

describe('gh 写入是真实 gh 写请求且核回执（开单、改正文、关单）', () => {
  it.each(['opened', 'updated', 'closed'] as const)(
    '%s 经 stdin 写 JSON，成功回执才报告成功',
    async (action) => {
      const calls: { args: string[]; input?: string }[] = [];
      const run: RunGhRead = async (args, _env, input) => {
        if (args[0] === 'config') return { code: 0, stdout: 'socket' };
        calls.push({ args, ...(input === undefined ? {} : { input }) });
        const payload = JSON.parse(input ?? '{}');
        return http(
          {
            ...payload,
            number: 900,
            labels: payload.labels?.map((name: string) => ({ name })),
            milestone: payload.milestone ? { number: payload.milestone } : null,
          },
          args.includes('POST') ? 201 : 200,
        );
      };
      const gh = await auditClient('o/r', {}, { runGh: run });
      const result =
        action === 'opened'
          ? await gh.createIssue('题', '真实问题', ['缺陷'])
          : action === 'updated'
            ? await gh.updateIssueBody(900, '真实问题')
            : await gh.closeIssueCompleted(900, '真实问题');
      expect(result).toBe(action === 'opened' ? 900 : undefined);
      expect(
        calls.every(
          ({ args, input }) =>
            args.includes('--input') &&
            args.includes('-') &&
            input &&
            !args.some((arg) => arg.includes('真实问题')),
        ),
      ).toBe(true);
    },
  );

  it.each(['opened', 'updated', 'closed'] as const)(
    '%s 的权限失败/超时/错误回执不能报告完成',
    async (action) => {
      for (const failure of [
        http({}, 403),
        { code: null, stdout: '', failure: 'transport' as const },
        http({ number: 901, body: '不同正文' }, action === 'opened' ? 201 : 200),
        http({}, 204),
      ]) {
        const run = runner({ [action === 'opened' ? `${API}/issues` : `${API}/issues/900`]: failure });
        const gh = await auditClient('o/r', {}, { runGh: run });
        const write =
          action === 'opened'
            ? gh.createIssue('题', '真实问题', ['缺陷'])
            : action === 'updated'
              ? gh.updateIssueBody(900, '真实问题')
              : gh.closeIssueCompleted(900, '真实问题');
        await expect(write).rejects.toThrow();
      }
    },
  );

  it('拒绝跨仓、token/分支写与未验证留言回执', async () => {
    const run = vi.fn<RunGhRead>(async () => http({ body: 'x' }, 201));
    const send = auditGhFetch('o/r', {}, run);
    for (const url of ['https://api.github.com/repos/other/r/issues', `${API}/git/refs`, `${API}/issues?x=y`])
      await expect(send(url, { method: 'POST', body: '{}' })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    await expect(send(`${API}/issues/1/comments`, { method: 'POST', body: '{"body":"x"}' })).rejects.toThrow(
      'id',
    );
  });
});
