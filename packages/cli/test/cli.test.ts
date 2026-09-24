// fleet 命令对着假后端测：请求形状（方法、路径、通行证、JSON 体）、本地校验、出错处理、退出码。
import { DEFAULT_BASH_TIMEOUT_MS } from '@fleet-dao/adapters';
import { afterEach, describe, expect, it } from 'vitest';
import { ASK_WAIT_MS, type CliIo, parseStep, runFleet } from '../src/cli.ts';
import { EXIT } from '../src/client.ts';
import { COMMAND_HELP } from '../src/help.ts';
import { deadUrl, type FakeBackend, type Responder, startFakeBackend } from './fake-backend.ts';

const backends: FakeBackend[] = [];
afterEach(async () => {
  for (const b of backends.splice(0)) await b.close();
});

async function backend(responder: Responder): Promise<FakeBackend> {
  const b = await startFakeBackend(responder);
  backends.push(b);
  return b;
}

interface Ran {
  code: number;
  out: string;
  err: string;
  sleeps: number[];
}

async function fleet(
  argv: string[],
  opts: { url?: string; env?: Record<string, string | undefined>; timing?: CliIo['timing'] } = {},
): Promise<Ran> {
  let out = '';
  let err = '';
  const sleeps: number[] = [];
  const code = await runFleet(argv, {
    env: opts.env ?? { FLEET_API: opts.url, FLEET_TOKEN: 'tok-1' },
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    fetch: globalThis.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(opts.timing ? { timing: opts.timing } : {}),
  });
  return { code, out, err, sleeps };
}

const TASK = {
  taskId: 'T12',
  subtaskId: 'S2',
  repo: 'thoerwink8/fleet-dao',
  branch: 'task/12-otp',
  specDir: 'specs/12-登录验证码',
  request: '给登录页加手机验证码',
  acceptance: ['验证码 5 分钟过期', '输错 3 次锁定'],
  touches: ['packages/api/src/auth'],
  plan: [
    { title: '读需求', state: 'done' },
    { title: '写过期测试', state: 'in_progress' },
  ],
};

const ok: Responder = () => ({ status: 204 });

describe('说明与用法', () => {
  it('fleet --help 列出全部子命令、环境变量和退出码', async () => {
    const r = await fleet(['--help']);
    expect(r.code).toBe(EXIT.ok);
    for (const cmd of ['task', 'plan', 'say', 'ask', 'history', 'done', 'blocked'])
      expect(r.out).toContain(cmd);
    expect(r.out).toContain('FLEET_API');
    expect(r.out).toContain('退出码');
  });

  it('每个子命令都有自己的说明和例子；help <子命令> 与 <子命令> --help 一样', async () => {
    for (const cmd of Object.keys(COMMAND_HELP)) {
      const a = await fleet([cmd, '--help']);
      const b = await fleet(['help', cmd]);
      expect(a.code).toBe(EXIT.ok);
      expect(a.out).toBe(COMMAND_HELP[cmd]);
      expect(b.out).toBe(a.out);
    }
  });

  it('不认识的子命令、多余的选项：用法错，不发请求', async () => {
    const b = await backend(ok);
    expect((await fleet(['deploy'], { url: b.url })).code).toBe(EXIT.usage);
    const r = await fleet(['say', '你好', '--force'], { url: b.url });
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain('参数不对');
    expect(b.requests).toEqual([]);
  });

  it('缺 FLEET_API 或 FLEET_TOKEN：用法错并说清缺哪个', async () => {
    const noApi = await fleet(['task'], { env: { FLEET_TOKEN: 't' } });
    expect(noApi.code).toBe(EXIT.usage);
    expect(noApi.err).toContain('FLEET_API');
    const noToken = await fleet(['task'], { env: { FLEET_API: 'http://127.0.0.1:1' } });
    expect(noToken.code).toBe(EXIT.usage);
    expect(noToken.err).toContain('FLEET_TOKEN');
    const badUrl = await fleet(['task'], { env: { FLEET_API: 'localhost:7070', FLEET_TOKEN: 't' } });
    expect(badUrl.code).toBe(EXIT.usage);
  });
});

describe('task', () => {
  it('GET /agent/v1/task，带通行证；打印需求、做完标准、要改哪里、步骤', async () => {
    const b = await backend(() => ({ status: 200, body: TASK }));
    const r = await fleet(['task'], { url: b.url });
    expect(r.code).toBe(EXIT.ok);
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]).toMatchObject({ method: 'GET', path: '/agent/v1/task', body: undefined });
    expect(b.requests[0]?.headers.authorization).toBe('Bearer tok-1');
    expect(r.out).toBe(
      [
        '任务 T12 · 子任务 S2',
        '仓库：thoerwink8/fleet-dao · 分支：task/12-otp',
        '需求文档：specs/12-登录验证码',
        '',
        '需求：',
        '  给登录页加手机验证码',
        '',
        '做完标准：',
        '  1. 验证码 5 分钟过期',
        '  2. 输错 3 次锁定',
        '',
        '要改的地方：',
        '  - packages/api/src/auth',
        '',
        '步骤：',
        '  [x] 读需求',
        '  [>] 写过期测试',
        '',
      ].join('\n'),
    );
  });

  it('--json 原样输出', async () => {
    const b = await backend(() => ({ status: 200, body: TASK }));
    const r = await fleet(['task', '--json'], { url: b.url });
    expect(JSON.parse(r.out)).toEqual(TASK);
  });

  it('后端回的数据不合约定：算后端出错', async () => {
    const b = await backend(() => ({ status: 200, body: { taskId: 1 } }));
    const r = await fleet(['task'], { url: b.url });
    expect(r.code).toBe(EXIT.backend);
    expect(r.err).toContain('格式不对');
  });
});

describe('plan', () => {
  it('用勾选框写状态，整张替换；打印进度', async () => {
    const b = await backend(ok);
    const r = await fleet(['plan', '[x] 读需求', '[>] 写过期测试', '[ ] 实现过期逻辑', '跑全部测试'], {
      url: b.url,
    });
    expect(r.code).toBe(EXIT.ok);
    expect(b.requests[0]).toMatchObject({
      method: 'POST',
      path: '/agent/v1/plan',
      body: {
        steps: [
          { title: '读需求', state: 'done' },
          { title: '写过期测试', state: 'in_progress' },
          { title: '实现过期逻辑', state: 'pending' },
          { title: '跑全部测试', state: 'pending' },
        ],
      },
    });
    expect(b.requests[0]?.headers['content-type']).toBe('application/json');
    expect(r.out).toBe('步骤已更新：1/4 做完 · 正在：写过期测试\n');
  });

  it('同一时间两步在进行：本地挡下，不发请求', async () => {
    const b = await backend(ok);
    const r = await fleet(['plan', '[>] 甲', '[>] 乙'], { url: b.url });
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain('同一时间只能有一步在进行');
    expect(b.requests).toEqual([]);
  });

  it('不带参数：读任务里的当前步骤', async () => {
    const b = await backend(() => ({ status: 200, body: TASK }));
    const r = await fleet(['plan'], { url: b.url });
    expect(b.requests[0]?.path).toBe('/agent/v1/task');
    expect(r.out).toBe('  [x] 读需求\n  [>] 写过期测试\n');
  });

  it('parseStep 认 markdown 勾选框写法', () => {
    expect(parseStep('- [X] 读需求')).toEqual({ title: '读需求', state: 'done' });
    expect(parseStep('[>]写测试')).toEqual({ title: '写测试', state: 'in_progress' });
    expect(parseStep('  改代码  ')).toEqual({ title: '改代码', state: 'pending' });
  });
});

describe('say', () => {
  it('POST /agent/v1/say，多个参数拼成一句', async () => {
    const b = await backend(ok);
    const r = await fleet(['say', '正在写', '验证码过期的测试'], { url: b.url });
    expect(r.code).toBe(EXIT.ok);
    expect(b.requests[0]).toMatchObject({
      method: 'POST',
      path: '/agent/v1/say',
      body: { text: '正在写 验证码过期的测试' },
    });
    expect(r.out).toBe('已记录。\n');
  });

  it('空话和超过 500 字：本地挡下', async () => {
    const b = await backend(ok);
    expect((await fleet(['say'], { url: b.url })).code).toBe(EXIT.usage);
    expect((await fleet(['say', '字'.repeat(501)], { url: b.url })).code).toBe(EXIT.usage);
    expect(b.requests).toEqual([]);
  });
});

describe('ask', () => {
  it('默认等回答：带选项，回来就打印回答', async () => {
    const b = await backend(() => ({
      status: 200,
      body: { askId: 'A1', status: 'answered', answer: '5 分钟' },
    }));
    const r = await fleet(['ask', '有效期 5 分钟还是 10 分钟？', '-o', '5 分钟', '--option', '10 分钟'], {
      url: b.url,
    });
    expect(r.code).toBe(EXIT.ok);
    expect(b.requests[0]?.body).toEqual({
      question: '有效期 5 分钟还是 10 分钟？',
      options: ['5 分钟', '10 分钟'],
      blocking: true,
    });
    expect(r.out).toBe('回答：5 分钟\n');
  });

  it('等不到回答：退出码 0，提示按写明的假设继续', async () => {
    const b = await backend(() => ({ status: 200, body: { askId: 'A2', status: 'pending' } }));
    const r = await fleet(['ask', '要不要顺手改注册页？'], { url: b.url });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('还没人回答（问题编号 A2）');
    expect(r.out).toContain('假设');
  });

  it('--no-wait 发出去就走', async () => {
    const b = await backend(() => ({ status: 200, body: { askId: 'A3', status: 'pending' } }));
    const r = await fleet(['ask', '顺便问一句', '--no-wait'], { url: b.url });
    expect(b.requests[0]?.body).toEqual({ question: '顺便问一句', blocking: false });
    expect(r.out).toBe('已发出（问题编号 A3），不等回答。\n');
  });

  it('选项超过 4 个：本地挡下', async () => {
    const b = await backend(ok);
    const opts = ['a', 'b', 'c', 'd', 'e'].flatMap((o) => ['-o', o]);
    expect((await fleet(['ask', '选哪个？', ...opts], { url: b.url })).code).toBe(EXIT.usage);
    expect(b.requests).toEqual([]);
  });

  it('等回答的上限短于会话里单条命令的超时：不然命令先被执行体杀掉，AI 只看到超时', () => {
    expect(ASK_WAIT_MS).toBeLessThan(DEFAULT_BASH_TIMEOUT_MS);
  });

  it('等回答超时：不重试（再问一遍只会重复提问），按后端出错退出', async () => {
    const b = await backend(() => 'hang');
    const r = await fleet(['ask', '在吗？'], { url: b.url, timing: { askMs: 200 } });
    expect(r.code).toBe(EXIT.backend);
    expect(r.err).toContain('超时');
    expect(b.requests).toHaveLength(1);
  });
});

describe('history', () => {
  it('POST /agent/v1/history，带条数；逐条打印', async () => {
    const b = await backend(() => ({
      status: 200,
      body: {
        items: [
          {
            taskId: 'T3',
            title: '登录限流',
            specDir: 'specs/3-登录限流',
            resultSummary: '加了按 IP 限流',
            mergedAt: '2026-09-01T10:00:00Z',
          },
        ],
      },
    }));
    const r = await fleet(['history', '登录', '-n', '3'], { url: b.url });
    expect(b.requests[0]).toMatchObject({ path: '/agent/v1/history', body: { query: '登录', limit: 3 } });
    expect(r.out).toBe(
      '找到 1 条：\n- T3 登录限流 · specs/3-登录限流 · 合并于 2026-09-01\n  结果：加了按 IP 限流\n',
    );
  });

  it('不给条数时用约定的默认 5；找不到就直说', async () => {
    const b = await backend(() => ({ status: 200, body: { items: [] } }));
    const r = await fleet(['history', '支付'], { url: b.url });
    expect(b.requests[0]?.body).toEqual({ query: '支付', limit: 5 });
    expect(r.out).toBe('没找到相关的历史需求。\n');
  });

  it('条数不是 1–20 的整数：本地挡下', async () => {
    const b = await backend(ok);
    expect((await fleet(['history', '登录', '-n', '50'], { url: b.url })).code).toBe(EXIT.usage);
    expect((await fleet(['history', '登录', '-n', 'abc'], { url: b.url })).code).toBe(EXIT.usage);
    expect(b.requests).toEqual([]);
  });
});

describe('done', () => {
  it('POST /agent/v1/done：总结、PR 编号（认 #31 写法）、测试结果', async () => {
    const b = await backend(() => ({ status: 202, body: { message: '收到，正在核实 PR #31' } }));
    const r = await fleet(['done', '加了过期逻辑和 3 个测试', '--tests', 'passed', '--pr', '#31'], {
      url: b.url,
    });
    expect(r.code).toBe(EXIT.ok);
    expect(b.requests[0]).toMatchObject({
      path: '/agent/v1/done',
      body: { summary: '加了过期逻辑和 3 个测试', prNumber: 31, testsPassed: true },
    });
    expect(r.out).toBe('收到，正在核实 PR #31\n');
  });

  it('没写测试结果：本地挡下', async () => {
    const b = await backend(ok);
    const r = await fleet(['done', '做完了'], { url: b.url });
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain('--tests');
    expect(b.requests).toEqual([]);
  });

  it('核实没过、后端拒收：退出码 4，原样说出原因', async () => {
    const b = await backend(() => ({ status: 409, body: { error: 'PR #31 不存在' } }));
    const r = await fleet(['done', '做完了', '--tests', 'passed', '--pr', '31'], { url: b.url });
    expect(r.code).toBe(EXIT.rejected);
    expect(r.err).toBe('fleet：后端拒收（HTTP 409）：PR #31 不存在\n');
    expect(b.requests).toHaveLength(1);
  });
});

describe('blocked', () => {
  it('POST /agent/v1/blocked：原因和需要什么', async () => {
    const b = await backend(ok);
    const r = await fleet(['blocked', '测试要连短信网关，沙箱里没有账号', '--needs', 'access'], {
      url: b.url,
    });
    expect(b.requests[0]).toMatchObject({
      path: '/agent/v1/blocked',
      body: { reason: '测试要连短信网关，沙箱里没有账号', needs: 'access' },
    });
    expect(r.out).toBe('已报卡住（需要：权限或账号）。\n');
  });

  it('没写或写错 --needs：本地挡下', async () => {
    const b = await backend(ok);
    expect((await fleet(['blocked', '卡住了'], { url: b.url })).code).toBe(EXIT.usage);
    expect((await fleet(['blocked', '卡住了', '--needs', 'money'], { url: b.url })).code).toBe(EXIT.usage);
    expect(b.requests).toEqual([]);
  });
});

describe('连不上与出错', () => {
  it('后端暂时不可用：按 0.5/1/2 秒退避重试，同一个幂等键，恢复后成功', async () => {
    const b = await backend((_req, i) =>
      i < 2 ? { status: 503, body: { error: 'starting' } } : { status: 204 },
    );
    const r = await fleet(['say', '你好'], { url: b.url });
    expect(r.code).toBe(EXIT.ok);
    expect(r.sleeps).toEqual([500, 1000]);
    expect(b.requests).toHaveLength(3);
    const keys = new Set(b.requests.map((q) => q.headers['idempotency-key']));
    expect(keys.size).toBe(1);
    expect(r.err).toContain('HTTP 503');
  });

  it('连不上：重试 3 次后大声失败，退出码 1，写清地址和原因', async () => {
    const url = await deadUrl();
    const r = await fleet(['say', '你好'], { url });
    expect(r.code).toBe(EXIT.backend);
    expect(r.sleeps).toEqual([500, 1000, 2000]);
    expect(r.err).toContain(`连不上后端 ${url}/agent/v1/say（试了 4 次，最后一次：ECONNREFUSED）`);
  });

  it('后端一直 500：试满 4 次后退出码 1', async () => {
    const b = await backend(() => ({ status: 500, raw: 'boom' }));
    const r = await fleet(['say', '你好'], { url: b.url });
    expect(r.code).toBe(EXIT.backend);
    expect(b.requests).toHaveLength(4);
    expect(r.err).toContain('HTTP 500 boom');
  });

  it('请求超时也重试，最后按后端出错退出', async () => {
    const b = await backend(() => 'hang');
    const r = await fleet(['say', '你好'], { url: b.url, timing: { requestMs: 150 } });
    expect(r.code).toBe(EXIT.backend);
    expect(b.requests).toHaveLength(4);
    expect(r.err).toContain('超时');
  });

  it('通行证无效或过期：退出码 3，不重试', async () => {
    const b = await backend(() => ({ status: 401, body: { error: 'token expired' } }));
    const r = await fleet(['say', '你好'], { url: b.url });
    expect(r.code).toBe(EXIT.auth);
    expect(b.requests).toHaveLength(1);
    expect(r.err).toContain('通行证无效或已过期（HTTP 401）：token expired');
  });

  it('后端回的不是 JSON：算后端出错', async () => {
    const b = await backend(() => ({ status: 200, raw: '<html>' }));
    const r = await fleet(['task'], { url: b.url });
    expect(r.code).toBe(EXIT.backend);
    expect(r.err).toContain('不是 JSON');
  });
});
