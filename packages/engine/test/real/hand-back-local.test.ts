// 总轮数到顶交还本机（#3603）的真活动：先留言（幂等键）再贴「本机做」；留言没成不贴，哪步没成都抛。
import { LOCAL_LABEL } from '@fleet-dao/conventions';
import { describe, expect, it } from 'vitest';
import { type PortContext, PortError } from '../../src/ports.ts';
import { createHandBackLocal } from '../../src/real/hand-back-local.ts';
import type { HandBackLocalInput } from '../../src/task-contract.ts';

const ctx = {} as PortContext;
const INPUT: HandBackLocalInput = {
  schemaVersion: 1,
  taskId: 'task-1',
  repo: { id: 'repo-1', owner: 'acme', name: 'app', defaultBranch: 'main', testCommand: 'pnpm check' },
  issueNumber: 12,
  key: 'total-rounds:task:acme/app#12:6',
  body: '引擎这一代动手累计 6 轮还没合',
};

function fakeGh(fail?: 'comment' | 'label') {
  const order: string[] = [];
  const gh = {
    async commentIssue(input: {
      repo: { owner: string; name: string };
      issueNumber: number;
      key: string;
      body: string;
    }) {
      order.push(`comment:${input.repo.owner}/${input.repo.name}#${input.issueNumber}:${input.key}`);
      if (fail === 'comment') throw new Error('留言接口 502');
      return { commentId: 1, url: 'https://example.test/c/1', created: true };
    },
    async addIssueLabel(input: {
      repo: { owner: string; name: string };
      issueNumber: number;
      label: string;
    }) {
      order.push(`label:${input.issueNumber}:${input.label}`);
      if (fail === 'label') throw new Error('贴标签没权限');
      return [input.label];
    },
  };
  return { gh, order };
}

describe('交还本机（#3603）', () => {
  it('先留言、再贴「本机做」，回这次是不是新留的', async () => {
    const { gh, order } = fakeGh();
    await expect(createHandBackLocal(gh)(INPUT, ctx)).resolves.toEqual({ commented: true });
    expect(order).toEqual([`comment:acme/app#12:${INPUT.key}`, `label:12:${LOCAL_LABEL}`]);
  });

  it('【故意造出的失败】留言没成：不贴标签，原样抛', async () => {
    const { gh, order } = fakeGh('comment');
    await expect(createHandBackLocal(gh)(INPUT, ctx)).rejects.toThrow('留言接口 502');
    expect(order).toEqual([`comment:acme/app#12:${INPUT.key}`]);
  });

  it('【故意造出的失败】贴标签没成：原样抛，不装作贴过', async () => {
    const { gh } = fakeGh('label');
    await expect(createHandBackLocal(gh)(INPUT, ctx)).rejects.toThrow('贴标签没权限');
  });

  it('缺键、缺正文、单号不对：INVALID_INPUT，一步都不做', async () => {
    const { gh, order } = fakeGh();
    for (const bad of [{ key: ' ' }, { body: '' }, { issueNumber: 0 }]) {
      await expect(createHandBackLocal(gh)({ ...INPUT, ...bad }, ctx)).rejects.toBeInstanceOf(PortError);
    }
    expect(order).toEqual([]);
  });
});
