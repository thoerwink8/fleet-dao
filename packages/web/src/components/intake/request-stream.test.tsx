// @vitest-environment happy-dom
// 需求页的消息流：收口的要能看见收口原因（闲置几天、最后一句是谁说的）。
import { REQUEST_ACTIONS, type RequestActions } from '@fleet-dao/shared';
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { RequestDetail } from '../../api/types';
import { renderApp } from '../../test/harness';
import { MessageStream } from './request-stream';

afterEach(() => cleanup());

const REASON = '闲置 3 天没动静，自动收口；最后一句是创始人甲说的';

function actions(): RequestActions {
  const out = {} as RequestActions;
  for (const name of REQUEST_ACTIONS) out[name] = { allowed: false, why: '测试里不做' };
  return out;
}

function detail(status: 'discussing' | 'idle_closed', closeReason?: string): RequestDetail {
  return {
    asOf: '2026-10-16T00:00:00.000Z',
    request: {
      seq: 2,
      title: '导出按钮',
      status,
      repo: { id: 'r', slug: 'acme/orbit' },
      initiator: { id: 'a', name: '创始人甲' },
      participants: [],
      lastActivityAt: '2026-10-13T00:00:00.000Z',
      pinned: false,
      unread: 0,
      waitingOnMe: null,
      idleDays: null,
      issueRefs: [],
      draft: { title: '导出按钮' },
      draftVersion: 1,
      humanEdited: [],
      needsDecision: false,
      createdAt: '2026-10-10T00:00:00.000Z',
      continuedBy: [],
      ...(status === 'idle_closed'
        ? { closedAt: '2026-10-16T00:00:00.000Z', ...(closeReason ? { closeReason } : {}) }
        : {}),
    },
    commander: {
      state: 'idle',
      running: false,
      model: null,
      defaultModel: null,
      models: [],
      turns: 0,
      maxTurns: 6,
    },
    messages: [
      {
        id: 1,
        kind: 'human',
        author: { id: 'a', name: '创始人甲' },
        channel: 'web',
        body: '想要一个导出按钮',
        mentions: [],
        createdAt: '2026-10-13T00:00:00.000Z',
      },
    ],
    lastReadMessageId: 1,
    actions: actions(),
  };
}

function stream(d: RequestDetail) {
  return renderApp(
    <MessageStream d={d} meId="a" phone={false} onOpenPanel={() => undefined} onPick={async () => true} />,
  );
}

describe('需求页上看收口原因', () => {
  test('收口的分隔线写出闲置几天、最后一句是谁说的', () => {
    stream(detail('idle_closed', REASON));
    const line = document.querySelector('[data-close-reason]');
    expect(line?.textContent).toContain(REASON);
    expect(line?.getAttribute('data-close-reason')).toBe(REASON);
  });

  test('讨论中不画收口原因', () => {
    stream(detail('discussing'));
    expect(document.querySelector('[data-close-reason]')).toBeNull();
    expect(document.querySelector('[data-closed-line]')).toBeNull();
  });
});
