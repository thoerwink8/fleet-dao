import { NODE_DISPATCH_FULL_PATH, NODE_REPORT_HEADER } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  DISPATCH_TOKEN_HEADER,
  DISPATCH_URL_PATH,
  type PokeDeps,
  parseIssueUrl,
  pokeFrance,
} from '../src/issue-poke.ts';

const url = 'https://github.com/thoerwink8/fleet-dao/issues/2200';

function deps(reply: { status: number; text: string } | Error) {
  const sent: Parameters<PokeDeps['post']>[0][] = [];
  const d: PokeDeps = {
    post: async (body) => {
      sent.push(body);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { d, sent };
}

describe('开单顺手戳法国', () => {
  it('认单的网址', () => {
    expect(parseIssueUrl(url)).toEqual({ repo: 'thoerwink8/fleet-dao', number: 2200 });
    expect(parseIssueUrl('https://github.com/a/b/pull/3')).toBeUndefined();
  });

  it('路径、请求头和 shared 的协议是同一个值', () => {
    expect(DISPATCH_URL_PATH).toBe(NODE_DISPATCH_FULL_PATH);
    expect(DISPATCH_TOKEN_HEADER).toBe(NODE_REPORT_HEADER);
  });

  it('派了：请求带仓、单号、来源 local-session + 单号（不带 force）；回「已戳」', async () => {
    const { d, sent } = deps({
      status: 200,
      text: JSON.stringify({ result: 'dispatched', text: '已派：x' }),
    });
    const msg = await pokeFrance(url, d);
    expect(sent).toEqual([
      { repo: 'thoerwink8/fleet-dao', issueNumber: 2200, source: { kind: 'local-session', ref: '2200' } },
    ]);
    expect(msg).toContain('已戳法国接单');
    expect(msg).toContain('已派：x');
  });

  it('【故意造出的失败】准入没过（409）：列出每一道原因，说没戳成，不抛', async () => {
    const { d } = deps({
      status: 409,
      text: JSON.stringify({
        result: 'refused',
        reasons: [
          { reason: 'not_current_version', why: '不是当前版本' },
          { reason: 'prerequisite_open', why: '前置 #1 还开着' },
        ],
        text: '没派：…',
      }),
    });
    const msg = await pokeFrance(url, d);
    expect(msg).toContain('没戳法国接单');
    expect(msg).toContain('not_current_version（不是当前版本）');
    expect(msg).toContain('prerequisite_open（前置 #1 还开着）');
  });

  it('【故意造出的失败】通行证不对（401）：照实说，不说派了', async () => {
    const { d } = deps({
      status: 401,
      text: JSON.stringify({ error: { code: 'node_token_invalid', message: '通行证不对' } }),
    });
    const msg = await pokeFrance(url, d);
    expect(msg).toContain('没戳法国接单');
    expect(msg).toContain('401');
    expect(msg).toContain('node_token_invalid');
    expect(msg).not.toContain('已戳');
  });

  it('【故意造出的失败】连不上 / 读不到配置：明说没戳，原因带上，不抛', async () => {
    const msg = await pokeFrance(url, deps(new Error('读不到 ~/.fleet-dao/local-sessions/config.json')).d);
    expect(msg).toContain('没戳法国接单');
    expect(msg).toContain('连不上法国派单接口');
    expect(msg).toContain('config.json');
    const net = await pokeFrance(url, deps(new Error('fetch failed')).d);
    expect(net).toContain('fetch failed');
  });

  it('没查成（503）、接口没上线（404）、回的不是约定的样子：都说没戳，不当成派了', async () => {
    const unavailable = await pokeFrance(
      url,
      deps({
        status: 503,
        text: JSON.stringify({
          error: { code: 'dispatch_unavailable', message: '没查成，不知道派没派：Temporal 连不上' },
        }),
      }).d,
    );
    expect(unavailable).toContain('不知道派没派');
    expect(unavailable).toContain('Temporal 连不上');
    expect(await pokeFrance(url, deps({ status: 404, text: '' }).d)).toContain('可能还没上线');
    const odd = await pokeFrance(url, deps({ status: 200, text: '<html>ok</html>' }).d);
    expect(odd).toContain('没戳法国接单');
    expect(odd).not.toContain('已戳');
  });

  it('认不出单的网址不发请求', async () => {
    const { d, sent } = deps({ status: 200, text: '{}' });
    expect(await pokeFrance('https://example.com/x', d)).toContain('认不出单的网址');
    expect(sent).toEqual([]);
  });
});
