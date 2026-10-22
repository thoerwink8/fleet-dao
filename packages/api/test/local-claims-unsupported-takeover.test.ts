import { NODE_REPORT_HEADER } from '@fleet-dao/shared';
import { describe, expect, it, vi } from 'vitest';
import { pgLocalClaims } from '../src/local-claims.ts';
import { nodeKeyHash } from '../src/node-report.ts';
import type { WorkflowControl } from '../src/ports.ts';
import { harness } from './harness.ts';

// #3644：未交付的已有 PR 接手协议必须在 HTTP 入口拒绝，不能先叫停旧 run 或授予本机租约。
describe('未支持的已有 PR 接手请求', () => {
  const takeoverPr = { pr: 9, head: 'a'.repeat(40) };
  it.each([
    { action: 'claim', repo: 'acme/app', issue: 42, title: '接手', takeoverPr },
    { action: 'takeover_confirm', repo: 'acme/app', issue: 42, takeoverPr },
  ])('$action 在任何信号或 ownership 写入前拒绝', async (request) => {
    const token = 'unsupported-takeover-token-0123456789';
    const signal = vi.fn(async () => {});
    const workflows = {
      signal,
      runningTaskWorkflow: async () => 'task-acme-app-42-g2',
      taskWorkflowExecution: async (workflowId: string) => ({
        workflowId,
        runId: 'run-7',
        running: true,
      }),
    } as WorkflowControl;
    const granted = {
      ok: true as const,
      taskId: 't',
      state: 'running',
      executor: 'local' as const,
      leaseUntil: new Date('2026-10-23T02:00:00.000Z'),
    };
    const claim = vi.fn(async () => {
      await signal();
      return granted;
    });
    const confirmTakeover = vi.fn(async () => granted);
    const renew = vi.fn(async () => granted);
    const finish = vi.fn(async () => granted);
    const ops = { claim, confirmTakeover, renew, finish, workflows, list: async () => [] };
    const h = harness({
      config: { nodeKeys: { 'founder-pc': nodeKeyHash(token) } },
      localClaims: pgLocalClaims(ops),
    });
    const response = await h.cockpit.request('/api/nodes/claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [NODE_REPORT_HEADER]: token },
      body: JSON.stringify(request),
    });
    expect.soft(response.status).toBe(400);
    expect.soft(claim).not.toHaveBeenCalled();
    expect.soft(confirmTakeover).not.toHaveBeenCalled();
    expect.soft(signal).not.toHaveBeenCalled();
    expect.soft(renew).not.toHaveBeenCalled();
    expect.soft(finish).not.toHaveBeenCalled();
  });
});
