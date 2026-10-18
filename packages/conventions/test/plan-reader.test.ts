import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type GhReadResult, ghReadFetch, planReader, type RunGhRead, runGh } from '../src/plan-reader.ts';
import { planCommand } from '../src/plan-view.ts';
import { order, V1 } from './fake-github.ts';

const child = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: child.execFile,
}));

const API = 'https://api.github.com/repos/o/r';
const NOW = new Date('2026-10-18T00:00:00Z');
const http = (data: unknown, status = 200, headers = ''): GhReadResult => ({
  code: status >= 400 ? 1 : 0,
  stdout: `HTTP/2.0 ${status} status\r\n${headers ? `${headers}\r\n` : ''}\r\n${JSON.stringify(data)}`,
});
const row = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `单 ${number}`,
  state: 'open',
  created_at: '2026-10-18T00:00:00Z',
  labels: [],
  milestone: { title: V1 },
  sub_issues_summary: { total: 0, completed: 0 },
  ...extra,
});

function bridge(routes: Record<string, GhReadResult>) {
  const calls: string[][] = [];
  const run: RunGhRead = async (args) => {
    calls.push(args);
    if (args[0] === 'config') return { stdout: 'test-socket', code: 0 };
    const result = routes[args.at(-1) ?? ''];
    if (!result) throw new Error('测试没设这条请求');
    return result;
  };
  return { run, calls };
}

function routes() {
  const mother = row(1, { labels: [{ name: '母单' }], sub_issues_summary: { total: 1, completed: 1 } });
  const childIssue = row(2, {
    state: 'closed',
    state_reason: 'completed',
    parent_issue_url: `${API}/issues/1`,
  });
  return {
    [`${API}/milestones?state=all&per_page=100`]: http([
      { number: 8, title: V1, state: 'open', description: order(1), closed_at: null },
    ]),
    [`${API}/issues?state=open&per_page=100`]: http([mother]),
    [`${API}/issues?milestone=8&state=all&per_page=100`]: http([mother, childIssue]),
    [`${API}/issues/1/sub_issues?per_page=100`]: http([childIssue]),
  };
}

async function plan(runGh: RunGhRead, fetchImpl?: typeof fetch) {
  const token = vi.fn(() => {
    throw new Error('桥接不应读取令牌');
  });
  const reader = await planReader('o/r', {}, { runGh, token, ...(fetchImpl ? { fetchImpl } : {}) });
  const result = await planCommand([], { reader, repo: 'o/r', now: () => NOW });
  expect(token).not.toHaveBeenCalled();
  return result;
}

describe('plan 明确配置 gh 桥接时走只读传输', () => {
  it('直连同一路径 401，gh 200：完整版本、母子单和已关闭子单读通，不读取令牌或调用 fetch', async () => {
    const direct = vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 }));
    const url = `${API}/milestones?state=all&per_page=100`;
    expect((await direct(url)).status).toBe(401);
    direct.mockClear();
    const { run, calls } = bridge(routes());
    const result = await plan(run, direct);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toContain(V1);
    expect(result.lines[0]).toContain('#1 单 1（母单，子单关了 1/1）');
    expect(result.lines[0]).toContain('#2 单 2（已做完）');
    expect(direct).not.toHaveBeenCalled();
    expect(calls).toHaveLength(5);
    expect(calls[1]).toEqual([
      'api',
      '--include',
      '--method',
      'GET',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
      url,
    ]);
    const reader = await planReader('o/r', { GH_TOKEN: 'private-test-value' }, { runGh: run });
    expect(reader).not.toHaveProperty('updateIssueBody');
  });

  it('Link 下一页照读，所有页成功才打印计划', async () => {
    const first = `${API}/issues?state=open&per_page=100`;
    const next = `${first}&page=2`;
    const { run, calls } = bridge({
      ...routes(),
      [first]: http([], 200, `Link: <${next}>; rel="next"`),
      [next]: routes()[first] as GhReadResult,
    });
    expect((await plan(run)).code).toBe(0);
    expect(calls.at(3)?.at(-1)).toBe(next);
  });

  it.each([401, 403, 429, 500])('真实 HTTP %s 保留状态，不换身份或转直连', async (status) => {
    const { run, calls } = bridge({
      ...routes(),
      [`${API}/milestones?state=all&per_page=100`]: http({}, status),
    });
    const result = await plan(run);
    expect(result.code).toBe(2);
    expect(result.lines.join('\n')).toContain(String(status));
    expect(result.lines.join('\n')).not.toContain('现在的目标');
    expect(calls).toHaveLength(2);
  });

  it('后续页失败不输出已经读到的部分计划', async () => {
    const first = `${API}/issues?state=open&per_page=100`;
    const next = `${first}&page=2`;
    const { run } = bridge({
      ...routes(),
      [first]: http([], 200, `Link: <${next}>; rel="next"`),
      [next]: http({}, 403),
    });
    const result = await plan(run);
    expect(result.code).toBe(2);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain('403');
    expect(result.lines[0]).not.toContain('现在的目标');
  });

  it('真实 GitHub 数字仓号 Link：核对当前仓 id 和 full_name 后读全，各页复用同次身份核对', async () => {
    const first = `${API}/issues?state=open&per_page=100`;
    const second = 'https://api.github.com/repositories/42/issues?page=2';
    const third = 'https://api.github.com/repositories/42/issues?page=3';
    const { run, calls } = bridge({
      ...routes(),
      [first]: http([], 200, `Link: <${second}>; rel="next"`),
      [API]: http({ id: 42, full_name: 'o/r' }),
      [second]: http([], 200, `Link: <${third}>; rel="next"`),
      [third]: routes()[first] as GhReadResult,
    });
    expect((await plan(run)).code).toBe(0);
    expect(calls.filter((args) => args.at(-1) === API)).toHaveLength(1);
    expect(calls.some((args) => args.at(-1) === second)).toBe(true);
    expect(calls.some((args) => args.at(-1) === third)).toBe(true);
  });

  it.each([
    http({ id: 42, full_name: 'other/r' }),
    http({ id: 7, full_name: 'o/r' }),
    http({ id: '42', full_name: 'o/r' }),
    http({}, 403),
    { code: 0, stdout: 'HTTP/2.0 200 OK\n\nnot-json' },
  ])('数字 Link 仓身份没核对成，不能读别仓或返回部分计划：%j', async (identity) => {
    const next = 'https://api.github.com/repositories/42/issues?page=2';
    const { run, calls } = bridge({
      ...routes(),
      [`${API}/milestones?state=all&per_page=100`]: http([], 200, `Link: <${next}>; rel="next"`),
      [API]: identity,
    });
    const result = await plan(run);
    expect(result.code).toBe(2);
    expect(result.lines[0]).not.toContain('现在的目标');
    expect(calls.some((args) => args.at(-1) === next)).toBe(false);
  });

  it('非 JSON 不是空计划', async () => {
    const { run } = bridge({
      ...routes(),
      [`${API}/milestones?state=all&per_page=100`]: { code: 0, stdout: 'HTTP/2.0 200 OK\n\nnot-json' },
    });
    const result = await plan(run);
    expect(result.code).toBe(2);
    expect(result.lines[0]).toContain('JSON');
  });

  it.each([
    'https://evil.invalid/repos/o/r/issues',
    'https://api.github.com/repos/other/r/issues',
    'https://api.github.com/repos/o/r-other/issues',
  ])('恶意 Link 不越仓或越 API：%s', async (next) => {
    const { run, calls } = bridge({
      ...routes(),
      [`${API}/milestones?state=all&per_page=100`]: http([], 200, `Link: <${next}>; rel="next"`),
    });
    expect((await plan(run)).code).toBe(2);
    expect(calls).toHaveLength(2);
  });
});

describe('无桥接时保持原生 HTTP 和未登录行为', () => {
  it.each([
    { stdout: '', code: 0 },
    { stdout: '', code: null, failure: 'unavailable' as const },
  ])('配置为空或没装 gh 时，原生令牌仍可读：%j', async (config) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('[]'));
    const runGh = vi.fn<RunGhRead>(async () => config);
    const reader = await planReader('o/r', { GITHUB_TOKEN: 'native-test-token' }, { runGh, fetchImpl });
    expect(await reader?.milestones()).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toHaveProperty('authorization', 'Bearer native-test-token');
    expect(runGh).toHaveBeenCalledOnce();
  });

  it('无配置、无令牌仍未登录；不以匿名请求探测', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(
      await planReader(
        'o/r',
        {},
        { runGh: async () => ({ stdout: '', code: 0 }), token: () => undefined, fetchImpl },
      ),
    ).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('原生 HTTP 401 保留失败，不转 gh、匿名或另一个身份', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 }));
    const runGh = vi.fn<RunGhRead>(async () => ({ stdout: '', code: 0 }));
    const reader = await planReader('o/r', { GH_TOKEN: 'native-test-token' }, { runGh, fetchImpl });
    const result = await planCommand([], { reader, repo: 'o/r', now: () => NOW });
    expect(result.code).toBe(2);
    expect(result.lines[0]).toContain('401');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(runGh).toHaveBeenCalledOnce();
  });

  it.each([
    { stdout: '', code: 1 },
    { stdout: '', code: null, failure: 'transport' as const },
  ])('配置真失败不能当没配置：%j', async (config) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      planReader('o/r', { GH_TOKEN: 'native-test-token' }, { runGh: async () => config, fetchImpl }),
    ).rejects.toThrow('无法读取 gh');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('显式 GH_CONFIG_DIR 下 gh 不可用，不能静默直连', async () => {
    await expect(
      planReader(
        'o/r',
        { GH_CONFIG_DIR: 'private-test-dir', GH_TOKEN: 'native-test-token' },
        { runGh: async () => ({ stdout: '', code: null, failure: 'unavailable' }) },
      ),
    ).rejects.toThrow('无法读取 gh');
  });
});

describe('gh HTTP 封装失败边界', () => {
  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])('运行时拒绝 %s', async (method) => {
    const run = vi.fn<RunGhRead>();
    await expect(ghReadFetch('o/r', {}, run)(`${API}/issues`, { method })).rejects.toThrow('只允许');
    expect(run).not.toHaveBeenCalled();
  });

  it('运行时拒绝 GET 正文和 Request 对象中的写入', async () => {
    const run = vi.fn<RunGhRead>();
    const fetchImpl = ghReadFetch('o/r', {}, run);
    await expect(fetchImpl(`${API}/issues`, { body: 'x' })).rejects.toThrow('只允许');
    await expect(fetchImpl(new Request(`${API}/issues`, { method: 'POST', body: 'x' }))).rejects.toThrow(
      '只允许',
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('204 保留状态和头，不把空正文硬转 JSON', async () => {
    const response = await ghReadFetch('o/r', {}, async () => http(null, 204, 'X-Test: yes'))(
      `${API}/issues`,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('x-test')).toBe('yes');
    expect(await response.text()).toBe('');
  });

  it.each([
    { code: 1, stdout: http([]).stdout },
    { code: 2, stdout: http({}, 403).stdout },
    { code: 0, stdout: '[]' },
    { code: 0, stdout: 'HTTP/2.0 200 OK\ninvalid-header\n\n[]' },
    { code: null, failure: 'transport' as const, stdout: http([]).stdout },
    { code: null, failure: 'unavailable' as const, stdout: '' },
  ])('非零/进程失败/畸形响应不当成功：%j', async (result) => {
    await expect(ghReadFetch('o/r', {}, async () => result)(`${API}/issues`)).rejects.toThrow();
  });
});

describe('真实 execFile 封装保持有界并隐藏私人错误', () => {
  beforeEach(() => {
    child.execFile.mockReset();
  });

  it.each([
    { code: 'ENOENT' },
    { code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM' },
    { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
    { code: 1 },
    { code: 1, signal: 'SIGTERM' },
  ])('配置进程失败不输出 stderr：%j', async (properties) => {
    child.execFile.mockImplementation((_file, _args, _opts, callback) =>
      callback(Object.assign(new Error('private-socket-and-token'), properties), '', 'private-stderr'),
    );
    const result = planReader('o/r', { GH_CONFIG_DIR: 'test-dir' });
    await expect(result).rejects.toThrow('无法读取 gh');
    await expect(result).rejects.not.toThrow('private');
    expect(child.execFile.mock.calls[0]?.[2]).toMatchObject({
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  });

  it('请求进程超时，即使已有 200 stdout 也不能绿', async () => {
    child.execFile.mockImplementation((_file, args, _opts, callback) => {
      if (args[0] === 'config') callback(null, 'test-socket', '');
      else
        callback(
          Object.assign(new Error('private-socket-and-token'), { killed: true, code: 1 }),
          http([]).stdout,
          'private-stderr',
        );
    });
    const reader = await planReader('o/r', {});
    const result = await planCommand([], { reader, repo: 'o/r', now: () => NOW });
    expect(result.code).toBe(2);
    expect(result.lines[0]).toContain('进程不可用、超时或输出超限');
    expect(result.lines[0]).not.toContain('private');
  });
});

describe('共享 gh 写进程的 stdin', () => {
  it('正文通过 stdin 发送，不放进命令参数', async () => {
    const end = vi.fn();
    child.execFile.mockImplementation((_file, _args, _opts, callback) => {
      end.mockImplementation(() => callback(null, 'receipt', ''));
      return { stdin: { on: vi.fn(), end } };
    });
    const args = ['api', '--input', '-'];
    expect(await runGh(args, {}, '{"body":"private-payload"}')).toEqual({ code: 0, stdout: 'receipt' });
    expect(end).toHaveBeenCalledWith('{"body":"private-payload"}');
    expect(args.join(' ')).not.toContain('private-payload');
  });

  it('stdin 写失败明确返回 transport，不能吞错误后当成功', async () => {
    let fail: () => void = () => {};
    child.execFile.mockImplementation(() => ({
      stdin: {
        on: (_event: string, listener: () => void) => {
          fail = listener;
        },
        end: () => fail(),
      },
    }));
    expect(await runGh(['api', '--input', '-'], {}, '{}')).toEqual({
      code: null,
      stdout: '',
      failure: 'transport',
    });
  });
});
