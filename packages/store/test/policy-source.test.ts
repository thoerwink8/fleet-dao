import type { PolicyGitHub } from '@fleet-dao/github';
import { expect, it, vi } from 'vitest';
import { createPolicySourcePublisher, withPolicySource } from '../src/policy-source.ts';

const repo = { owner: 'example', name: 'canary' };
function harness() {
  const state = {
    head: 'a'.repeat(40),
    open: true,
    fork: false,
    public: true,
    id: 12,
    rowId: 12,
    changed: false,
  };
  const write = vi.fn(async () => {
    if (state.changed) state.head = 'b'.repeat(40);
  });
  const gh: PolicyGitHub = {
    repo: async () => ({ githubId: state.id, repo: 'example/canary', public: state.public }),
    pull: async () => ({ number: 7, head: state.head, open: state.open, fork: state.fork }),
    openPulls: async () => [7],
    latest: async () => null,
    write,
  };
  const publisher = createPolicySourcePublisher({
    origin: 'https://cockpit.example.test',
    gh,
    find: async () => ({ ...repo, githubId: state.rowId }),
  });
  return { state, write, publisher };
}
it('精确head发布后head变化拒绝成功回执', async () => {
  const h = harness();
  h.state.changed = true;
  await expect(h.publisher.publish(repo, 7)).rejects.toThrow('head 改变');
  expect(h.write.mock.calls[0]).toEqual([
    repo,
    { githubId: 12, repo: 'example/canary', public: true },
    'a'.repeat(40),
    expect.objectContaining({ context: 'fleet-ci-policy-source/pr/7' }),
  ]);
});
it('数字仓身份不匹配与缺失拒绝，私有与关闭/fork不发布', async () => {
  const h = harness();
  h.state.rowId = 13;
  await expect(h.publisher.publish(repo, 7)).rejects.toThrow('没有可用');
  h.state.rowId = 0;
  await expect(h.publisher.publish(repo, 7)).rejects.toThrow('没有可用');
  h.state.rowId = 12;
  h.state.public = false;
  expect(await h.publisher.publish(repo, 7)).toBe(false);
  h.state.public = true;
  h.state.open = false;
  expect(await h.publisher.publish(repo, 7)).toBe(false);
  h.state.open = true;
  h.state.fork = true;
  expect(await h.publisher.publish(repo, 7)).toBe(false);
  expect(h.write).not.toHaveBeenCalled();
});
it('status不循环，未处理action不授权，synced发布失败不调用下层sink', async () => {
  const accept = vi.fn(async () => {});
  const publish = vi.fn(async () => {
    throw new Error('write failed');
  });
  const sink = withPolicySource({ accept }, { publish });
  const event = {
    deliveryId: 'x',
    source: 'poll' as const,
    event: 'status',
    action: 'synced',
    repo: 'example/canary',
    wake: false,
    receivedAt: '2026-10-19T00:00:00Z',
    payload: { pull_request: { number: 7 } },
  };
  await sink.accept(event);
  await sink.accept({ ...event, event: 'pull_request', action: 'closed' });
  expect(publish).not.toHaveBeenCalled();
  accept.mockClear();
  await expect(sink.accept({ ...event, event: 'pull_request' })).rejects.toThrow('write failed');
  expect(accept).not.toHaveBeenCalled();
});
