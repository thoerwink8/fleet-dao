// 测试里轮询工作流状态的帮手：工作流刚起、worker 还没处理完第一个工作流任务时查询会当场失败，
// 这算「还没好」接着等；等到期还没读成，要把最后一次的失败原因带出来，不能只剩一句「Failed to query Workflow」。
import { describe, expect, it } from 'vitest';
import { pollQuery } from './helpers.ts';

// 拿到 promise 被拒绝时的错误；本该报错却成功了，当场判测试失败。
const rejection = (p: Promise<unknown>): Promise<Error> =>
  p.then(
    () => {
      throw new Error('本该报错却成功了');
    },
    (e: unknown) => e as Error,
  );

describe('pollQuery', () => {
  it('前几次读失败：接着等，读成了就返回那一刻的状态', async () => {
    let calls = 0;
    const status = await pollQuery(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('Failed to query Workflow');
        return { parked: true };
      },
      (s) => s.parked,
      '停下',
      2_000,
    );
    expect(status).toEqual({ parked: true });
    expect(calls).toBe(3);
  });

  it('【故意造出的失败】一直读不成：到期报错，带上最后一次读失败的原因和它的 cause', async () => {
    const error = await rejection(
      pollQuery(
        async () => {
          throw new Error('Failed to query Workflow', { cause: new Error('workflow task 还没处理完') });
        },
        () => true,
        '停下',
        200,
      ),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('等了 200 毫秒还没等到：停下');
    expect(error.message).toContain('最后一次读失败：Failed to query Workflow（workflow task 还没处理完）');
    expect(error.message).toContain('最后一次状态：undefined');
  });

  it('【故意造出的失败】读成了但条件一直不成立：到期报错，带上最后读到的状态（不当成没事）', async () => {
    const error = await rejection(
      pollQuery(
        async () => ({ parked: false }),
        (s) => s.parked,
        '停下',
        200,
      ),
    );
    expect(error.message).toContain('等了 200 毫秒还没等到：停下');
    expect(error.message).toContain('最后一次状态：{"parked":false}');
    expect(error.message).not.toContain('最后一次读失败');
  });

  it('条件函数自己抛错不被吞：那是测试写错了，原样往外抛', async () => {
    await expect(
      pollQuery(
        async () => ({ parked: true }),
        () => {
          throw new Error('条件写错了');
        },
        '停下',
        200,
      ),
    ).rejects.toThrow('条件写错了');
  });
});
