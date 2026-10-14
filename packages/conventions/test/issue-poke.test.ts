import { describe, expect, it } from 'vitest';
import { parseIssueUrl, pokeFrance } from '../src/issue-poke.ts';

const url = 'https://github.com/thoerwink8/fleet-dao/issues/2200';

describe('开单顺手戳法国', () => {
  it('认单的网址', () => {
    expect(parseIssueUrl(url)).toEqual({ repo: 'thoerwink8/fleet-dao', number: 2200 });
    expect(parseIssueUrl('https://github.com/a/b/pull/3')).toBeUndefined();
  });

  it('戳成了：远端命令带仓名和单号', async () => {
    const calls: string[] = [];
    const msg = await pokeFrance(url, {
      readHost: () => 'fleet-fr-wg\n',
      ssh: async (h, r) => {
        calls.push(`${h}|${r}`);
        return { code: 0, out: '派了 task:thoerwink8/fleet-dao#2200' };
      },
    });
    expect(calls).toEqual([
      'fleet-fr-wg|bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api dispatch-issue thoerwink8/fleet-dao 2200',
    ]);
    expect(msg).toContain('已戳法国接单');
  });

  it('准入没过（退出码 1）照实说没戳成，不抛', async () => {
    const msg = await pokeFrance(url, {
      readHost: () => 'fleet-fr-wg',
      ssh: async () => ({ code: 1, out: '没派：不是当前版本' }),
    });
    expect(msg).toContain('没戳法国接单');
    expect(msg).toContain('不是当前版本');
  });

  it('没配 ssh 主机、读不到：明说没戳，不抛', async () => {
    const msg = await pokeFrance(url, {
      readHost: () => {
        throw new Error('ENOENT');
      },
      ssh: async () => ({ code: 0, out: '' }),
    });
    expect(msg).toContain('没戳法国接单');
    expect(msg).toContain('ENOENT');
  });

  it('主机名带空格不拼进命令', async () => {
    let called = false;
    const msg = await pokeFrance(url, {
      readHost: () => 'a b',
      ssh: async () => {
        called = true;
        return { code: 0, out: '' };
      },
    });
    expect(called).toBe(false);
    expect(msg).toContain('没戳法国接单');
  });
});
