import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { closeOnMerge } from '../src/close-on-merge.ts';
import { closeOnMergeGh } from '../src/close-on-merge-gh.ts';
import type { GhResult } from '../src/issue-new.ts';
import { runChild } from './child.ts';

const START = Date.parse('2026-10-20T00:00:00Z');
const GET = ['api', 'repos/{owner}/{repo}/pulls/3330'];
const response = (status: number, headers: string[] = [], body: unknown = {}): GhResult => ({
  code: status >= 400 ? 1 : 0,
  stdout: [`HTTP/2.0 ${status} Status`, ...headers, '', JSON.stringify(body)].join('\r\n'),
  stderr: '',
});
const good = () => response(200, [], { result: 'original-json' });
const PRIMARY_MESSAGE = { message: 'API rate limit exceeded for installation.' };

function fixture(...responses: GhResult[]) {
  let time = START;
  const run = vi.fn(async (_args: string[]) => responses.shift() ?? good());
  const wait = vi.fn(async (ms: number) => {
    time += ms;
  });
  const log = vi.fn();
  const gh = closeOnMergeGh(run, { now: () => time, wait, log });
  return {
    gh,
    run,
    wait,
    log,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

it('主限流在reset之后一次重试，剥除HTTP头并保留原JSON', async () => {
  const f = fixture(
    response(
      403,
      ['X-RateLimit-Remaining: 0', `X-RateLimit-Reset: ${START / 1000 + 2}`, 'X-GitHub-Request-Id: ABC:123'],
      PRIMARY_MESSAGE,
    ),
    good(),
  );
  const result = await f.gh(GET);
  expect(result).toEqual({ code: 0, stdout: JSON.stringify({ result: 'original-json' }), stderr: '' });
  expect(f.wait).toHaveBeenCalledExactlyOnceWith(3000);
  expect(f.run).toHaveBeenCalledTimes(2);
  expect(f.run.mock.calls[0]?.[0]).toEqual([...GET, '--include', '--method', 'GET']);
  expect(f.log.mock.calls.flat().join(' ')).toContain('ABC:123');
});

it.each([403, 429])('次限流%d遵守Retry-After，整轮只重试一次', async (status) => {
  const f = fixture(
    response(status, ['Retry-After: 5'], { message: 'You have exceeded a secondary rate limit.' }),
    good(),
  );
  expect((await f.gh(GET)).code).toBe(0);
  expect(f.wait).toHaveBeenCalledExactlyOnceWith(5000);
  expect(f.run).toHaveBeenCalledTimes(2);
});

it('同时存在reset和Retry-After时不早于较晚时点', async () => {
  const f = fixture(
    response(429, ['Retry-After: 2', 'X-RateLimit-Remaining: 0', `X-RateLimit-Reset: ${START / 1000 + 9}`]),
    good(),
  );
  expect((await f.gh(GET)).code).toBe(0);
  expect(f.wait).toHaveBeenCalledExactlyOnceWith(10000);
});

it('超30秒预算不等待，保留安全重试时点', async () => {
  const f = fixture(
    response(403, ['X-RateLimit-Remaining: 0', `X-RateLimit-Reset: ${START / 1000 + 90}`], PRIMARY_MESSAGE),
  );
  const result = await f.gh(GET);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('2026-10-20T00:01:31.000Z');
  expect(result.stderr).toContain('预算');
  expect(f.wait).not.toHaveBeenCalled();
  expect(f.run).toHaveBeenCalledTimes(1);
});

it('预算包括本轮已有耗时，重试成功后遇第二个限流也不再重试', async () => {
  const f = fixture(good(), response(429, ['Retry-After: 20']));
  await f.gh(GET);
  f.advance(15000);
  expect((await f.gh(GET)).code).not.toBe(0);
  expect(f.wait).not.toHaveBeenCalled();
  const once = fixture(response(429, ['Retry-After: 1']), good(), response(429, ['Retry-After: 1']));
  expect((await once.gh(GET)).code).toBe(0);
  expect((await once.gh(GET)).code).not.toBe(0);
  expect(once.wait).toHaveBeenCalledTimes(1);
  expect(once.run).toHaveBeenCalledTimes(3);
});

it.each([
  ['缺头', 429, []],
  ['坏Retry-After', 429, ['Retry-After: banana']],
  ['负Retry-After', 429, ['Retry-After: -1']],
  ['重复Retry-After', 429, ['Retry-After: 1', 'Retry-After: 2']],
  ['坏reset', 403, ['X-RateLimit-Remaining: 0', 'X-RateLimit-Reset: bad']],
  ['缺reset', 403, ['X-RateLimit-Remaining: 0']],
  ['坏remaining', 429, ['Retry-After: 1', 'X-RateLimit-Remaining: -1']],
  ['未知HTTP失败', 502, ['Retry-After: 1']],
  ['权限403', 403, ['Retry-After: 1', 'X-RateLimit-Remaining: 10']],
] as const)('%s明确失败且不猜重试时点', async (_name, status, headers) => {
  const f = fixture(response(status, [...headers], { message: 'Resource not accessible by integration' }));
  const result = await f.gh(GET);
  expect(result.code).not.toBe(0);
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.wait).not.toHaveBeenCalled();
  expect(result.stdout).toBe('');
});

it('managed显式GET也保留方法，仅追加include', async () => {
  const f = fixture(good());
  const args = ['api', '--method', 'GET', '/repos/o/r/issues/1'];
  expect((await f.gh(args)).stdout).toBe(JSON.stringify({ result: 'original-json' }));
  expect(f.run).toHaveBeenCalledExactlyOnceWith([...args, '--include']);
});

it.each([
  ['issue', 'close', '1', '--comment', 'evidence'],
  ['api', '--method', 'POST', '/repos/o/r/issues/1/comments', '--input', 'payload'],
  ['api', '-X', 'PATCH', '/repos/o/r/issues/1', '-f', 'state=closed'],
  ['api', '/repos/o/r/issues/1/comments', '-f', 'body=comment'],
  ['api', 'graphql', '-f', 'query=mutation'],
])('写/未知形状不加GET或重放：%s', async (...args) => {
  const failed = response(429, ['Retry-After: 1'], { secret: 'private-payload' });
  failed.stderr = 'Authorization: fake-private-token';
  const f = fixture(failed);
  const result = await f.gh(args);
  expect(result.code).not.toBe(0);
  expect(f.run).toHaveBeenCalledExactlyOnceWith(args);
  expect(f.wait).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('private');
});

it('日志和失败回执只留白名单字段，不留原始头、stderr或私有payload', async () => {
  const limited = response(
    429,
    [
      'Retry-After: 1',
      'X-RateLimit-Limit: 1000',
      'X-RateLimit-Remaining: 9',
      'X-RateLimit-Used: 991',
      'X-RateLimit-Resource: core',
      'X-GitHub-Request-Id: SAFE:ID',
      'Authorization: fake-private-token',
      'Set-Cookie: fake-private-cookie',
      'X-Unlisted: fake-private-other',
    ],
    { private: 'fake-private-payload' },
  );
  limited.stderr = 'fake-private-stderr';
  const f = fixture(limited, limited);
  const result = await f.gh(GET);
  const visible = JSON.stringify([result, f.log.mock.calls]);
  expect(visible).not.toContain('fake-private');
  expect(visible).not.toContain('Authorization');
  expect(visible).toContain('SAFE:ID');
  expect(visible).toContain('1000');
  expect(f.run).toHaveBeenCalledTimes(2);
});

it.each(['missing HTTP headers', 'HTTP/2.0 200 OK\r\nRetry-After: bad\r\n\r\n{}'])(
  '坏运输输出不冒充成功：%s',
  async (stdout) => {
    const f = fixture({ code: 0, stdout, stderr: 'private-stderr' });
    expect((await f.gh(GET)).code).not.toBe(0);
    expect(f.wait).not.toHaveBeenCalled();
  },
);

it('首读恢复后走原closeOnMerge判法，不凭重试放宽收口条件', async () => {
  const f = fixture(
    response(429, ['Retry-After: 1']),
    response(200, [], {
      title: 'unchanged',
      body: '',
      merged_at: '2026-10-20T00:00:00Z',
      head: { ref: 'local/3330' },
      base: { ref: 'main' },
    }),
  );
  expect((await closeOnMerge(3330, { gh: f.gh })).outcomes).toEqual([]);
  expect(f.run).toHaveBeenCalledTimes(2);
});

it('runner异常同样脱敏且不重放', async () => {
  const gh = closeOnMergeGh(async () => {
    throw new Error('fake-private-exception');
  });
  const result = await gh(GET);
  expect(result.code).not.toBe(0);
  expect(JSON.stringify(result)).not.toContain('fake-private');
});

it('HTTP成功但坏JSON同样脱敏，不让JSON.parse泄露私有正文', async () => {
  const result = good();
  result.stdout = 'HTTP/2.0 200 OK\r\n\r\nfake-private-body';
  const f = fixture(result);
  const read = await f.gh(GET);
  expect(read.code).not.toBe(0);
  expect(JSON.stringify([read, f.log.mock.calls])).not.toContain('fake-private');
  expect(f.wait).not.toHaveBeenCalled();
});

it('未知prototype名字的头被忽略，不能混入白名单诊断或破坏成功JSON', async () => {
  const f = fixture(response(200, ['constructor: fake-private', '__proto__: fake-private'], { kept: true }));
  expect(await f.gh(GET)).toEqual({ code: 0, stdout: '{"kept":true}', stderr: '' });
});

it('权限403即使附限流头仍拒绝，不重放读取', async () => {
  const f = fixture(
    response(403, ['Retry-After: 1', 'X-RateLimit-Remaining: 0', `X-RateLimit-Reset: ${START / 1000 + 2}`], {
      message: 'Resource not accessible by integration',
    }),
  );
  expect((await f.gh(GET)).stderr).toContain('权限拒绝');
  expect(f.wait).not.toHaveBeenCalled();
  expect(f.run).toHaveBeenCalledTimes(1);
});

it('未列举的管理员权限403即使remaining0和reset完整也不能推断限流', async () => {
  const f = fixture(
    response(403, ['X-RateLimit-Remaining: 0', `X-RateLimit-Reset: ${START / 1000 + 2}`], {
      message: 'Must have admin rights to Repository.',
    }),
    good(),
  );
  const result = await f.gh(GET);
  expect(result.code).not.toBe(0);
  expect(f.wait).not.toHaveBeenCalled();
  expect(f.run).toHaveBeenCalledTimes(1);
});

it.each([{}, { message: 'Unknown policy restriction.' }, { message: 'See rate limit documentation.' }])(
  '未知403必须正向确认限流，不靠remaining0或泛称rate limit：%j',
  async (body) => {
    const f = fixture(
      response(
        403,
        ['Retry-After: 1', 'X-RateLimit-Remaining: 0', `X-RateLimit-Reset: ${START / 1000 + 2}`],
        body,
      ),
      good(),
    );
    expect((await f.gh(GET)).code).not.toBe(0);
    expect(f.wait).not.toHaveBeenCalled();
    expect(f.run).toHaveBeenCalledTimes(1);
  },
);

it('提前唤醒、超预算唤醒、等待抛错都不能抢跑GET', async () => {
  for (const mode of ['early', 'late', 'throw']) {
    let time = START;
    const run = vi.fn(async () => response(429, ['Retry-After: 1']));
    const gh = closeOnMergeGh(run, {
      now: () => time,
      wait: async () => {
        if (mode === 'throw') throw new Error('fake-private-wait');
        if (mode === 'late') time += 31000;
      },
      log: vi.fn(),
    });
    const result = await gh(GET);
    expect(result.code).not.toBe(0);
    expect(JSON.stringify(result)).not.toContain('fake-private');
    expect(run).toHaveBeenCalledTimes(1);
  }
});

it('真实入口运输失败明确exit2，原gh错误内容不外泄', { timeout: 0 }, () => {
  const bin = fileURLToPath(new URL('../src/bin/close-on-merge.ts', import.meta.url));
  const result = runChild(process.execPath, [bin, '--pr', '3330'], {
    env: { ...process.env, GH_REPO: 'fake-private-invalid-repo' },
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('HTTP响应头缺失或认不出');
  expect(result.stderr).not.toContain('fake-private');
});
