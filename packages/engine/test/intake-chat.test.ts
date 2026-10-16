// 驾驶舱「提需求」的指挥官会话（#2061）引擎这头的一轮：接手 → 起会话或续会话 → 认回话 → 写回话、意见卡或暂停原因。
// 会话、库都是假的；真装配（选路、检出、Spawner）在 real/intake-chat.ts，Spawner 续会话和不带 GitHub 令牌在 segment-spawner 的测试里。
import type { ChatSessionAfter, ClaimedRequestChat } from '@fleet-dao/db';
import { COMMANDER_BLOCK, REVIEW_BLOCK } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import {
  freshCommanderPrompt,
  type IntakeChatDeps,
  type IntakeSessionInput,
  type IntakeSessionOutcome,
  progressOf,
  reapIdleIntakeChats,
  resumeCommanderPrompt,
  reviewPrompt,
  runIntakeChatTurn,
} from '../src/jobs/intake-chat.ts';

const T0 = new Date('2026-10-14T03:00:00Z');
const ALIVE: ChatSessionAfter = {
  sessionId: 'sess-1',
  routeId: 'r1',
  modelId: 'm-opus',
  workdir: '/w/intake-7',
};
const EMPTY: ChatSessionAfter = { sessionId: null, routeId: null, modelId: null, workdir: null };

function chat(over: Partial<ClaimedRequestChat> = {}): ClaimedRequestChat {
  return {
    requestId: 'req-7',
    seq: 7,
    job: 'reply',
    queuedBy: 'u-a',
    repo: { id: 'repo-1', owner: 'acme', name: 'app', defaultBranch: 'main' },
    draft: { title: '导出报表' },
    draftVersion: 3,
    humanEdited: ['scene'],
    modelChoice: null,
    session: EMPTY,
    lastMessageId: null,
    turns: 0,
    messages: [
      { id: 1, kind: 'human', authorName: '甲', body: '想要导出报表', card: null, createdAt: T0 },
      { id: 2, kind: 'commander', authorName: null, body: '导出成什么格式？', card: null, createdAt: T0 },
      { id: 3, kind: 'human', authorName: '乙', body: 'Excel', card: null, createdAt: T0 },
    ],
    ...over,
  };
}

function fake(outcome: IntakeSessionOutcome | ((i: IntakeSessionInput) => Promise<IntakeSessionOutcome>)) {
  const seen: {
    sessions: IntakeSessionInput[];
    replies: unknown[];
    reviews: unknown[];
    fails: unknown[];
    logs: string[];
  } = { sessions: [], replies: [], reviews: [], fails: [], logs: [] };
  const deps: IntakeChatDeps = {
    claim: async () => null,
    progress: async () => ({ stop: false }),
    stopRequested: async () => false,
    runSession: async (i) => {
      seen.sessions.push(i);
      return typeof outcome === 'function' ? outcome(i) : outcome;
    },
    finishReply: async (i) => void seen.replies.push(i),
    finishReview: async (i) => void seen.reviews.push(i),
    fail: async (i) => void seen.fails.push(i),
    idle: async () => [],
    removeDir: async () => {},
    forget: async () => true,
    recover: async () => 0,
    now: () => T0,
    log: (level, message) => void seen.logs.push(`${level} ${message}`),
  };
  return { deps, seen };
}

const reply = (body: string, block?: unknown) =>
  block === undefined ? body : `${body}\n\n\`\`\`${COMMANDER_BLOCK}\n${JSON.stringify(block)}\n\`\`\``;

describe('一轮回话', () => {
  it('没有活着的会话：整份存档重起；回话、问题、草稿补丁原样交给写回，会话留着下次续', async () => {
    const text = reply('好的，导出 Excel。', {
      question: { text: '要按月还是按周？', options: ['按月', '按周'] },
      patch: { want: '能导出 Excel 报表' },
    });
    const { deps, seen } = fake({ ok: true, text, session: ALIVE, modelId: 'm-opus' });
    await runIntakeChatTurn(deps, chat());
    expect(seen.sessions[0]?.resume).toBeNull();
    expect(seen.sessions[0]?.prompt.resume).toBeNull();
    expect(seen.sessions[0]?.prompt.fresh).toContain('想要导出报表');
    expect(seen.replies).toEqual([
      {
        requestId: 'req-7',
        reply: '好的，导出 Excel。',
        question: { text: '要按月还是按周？', options: ['按月', '按周'] },
        patch: { want: '能导出 Excel 报表' },
        session: ALIVE,
      },
    ]);
    expect(seen.fails).toEqual([]);
  });

  it('会话活着：先续，续的那份只有上一轮之后的新消息', async () => {
    const { deps, seen } = fake({ ok: true, text: '收到', session: ALIVE, modelId: 'm-opus' });
    await runIntakeChatTurn(deps, chat({ session: ALIVE, lastMessageId: 2 }));
    const s = seen.sessions[0];
    expect(s?.resume).toEqual({ sessionId: 'sess-1', routeId: 'r1', workdir: '/w/intake-7' });
    expect(s?.prompt.resume).toContain('Excel');
    expect(s?.prompt.resume).not.toContain('想要导出报表');
    // 续不成时真装配改用整份：整份里什么都有
    expect(s?.prompt.fresh).toContain('想要导出报表');
  });

  it('方案卡原样交给写回（问题被解析丢掉）', async () => {
    const text = reply('方案齐了，确认就能开单。', {
      proposal: { summary: '标题：导出报表\n场景：月底对账' },
      question: { text: '还问吗？', options: ['问', '不问'] },
      patch: { want: '按月导出' },
    });
    const { deps, seen } = fake({ ok: true, text, session: ALIVE, modelId: 'm-opus' });
    await runIntakeChatTurn(deps, chat());
    expect(seen.replies).toEqual([
      {
        requestId: 'req-7',
        reply: '方案齐了，确认就能开单。',
        proposal: { summary: '标题：导出报表\n场景：月底对账' },
        patch: { want: '按月导出' },
        session: ALIVE,
      },
    ]);
  });

  it('选了模型的需求只派那个模型', async () => {
    const { deps, seen } = fake({ ok: true, text: '好', session: ALIVE, modelId: 'm-gpt' });
    await runIntakeChatTurn(deps, chat({ modelChoice: 'm-gpt' }));
    expect(seen.sessions[0]?.modelId).toBe('m-gpt');
  });

  it('【故意造出的失败】回话认不出（正文是空的）：写暂停原因，会话留着下次接着续，不拿半截当回话', async () => {
    const { deps, seen } = fake({
      ok: true,
      text: reply('', { patch: { want: 'x' } }),
      session: ALIVE,
      modelId: 'm',
    });
    await runIntakeChatTurn(deps, chat());
    expect(seen.replies).toEqual([]);
    expect(seen.fails).toEqual([
      { requestId: 'req-7', why: expect.stringMatching(/^指挥官的回话认不出：/), session: ALIVE },
    ]);
  });

  it('【故意造出的失败】会话没成：原因原样写成暂停原因', async () => {
    const { deps, seen } = fake({ ok: false, why: '选不到路由（用途 intake-chat）：全熔断', session: EMPTY });
    await runIntakeChatTurn(deps, chat());
    expect(seen.fails).toEqual([
      {
        requestId: 'req-7',
        why: '选不到路由（用途 intake-chat）：全熔断',
        stoppedByHuman: false,
        session: EMPTY,
      },
    ]);
  });

  it('有人点了停下：不算暂停，写「指挥官停下了」', async () => {
    const { deps, seen } = fake({ ok: false, why: '有人点了停下', stoppedByHuman: true, session: ALIVE });
    await runIntakeChatTurn(deps, chat());
    expect(seen.fails).toEqual([
      { requestId: 'req-7', why: '指挥官停下了（有人点了停下）', stoppedByHuman: true, session: ALIVE },
    ]);
  });

  it('写到哪了让页面看：progress 回 stop 就停下这一轮', async () => {
    const { deps, seen } = fake(async (i) => {
      i.onProgress({ phase: 'reading_code', text: '' });
      // 等写库那条链跑完、停下信号落到 signal 上
      await new Promise((r) => setTimeout(r, 10));
      return i.signal.aborted
        ? { ok: false, why: '被停', session: EMPTY }
        : { ok: true, text: '没停', session: EMPTY, modelId: 'm' };
    });
    deps.progress = async () => ({ stop: true });
    await runIntakeChatTurn(deps, chat());
    expect(seen.replies).toEqual([]);
    expect(seen.fails).toEqual([expect.objectContaining({ stoppedByHuman: true })]);
  });

  it('【故意造出的失败】起会话那一下抛了：这一轮写暂停原因、会话清空，不卡在 running', async () => {
    const { deps, seen } = fake(async () => {
      throw new Error('检出建不了');
    });
    await runIntakeChatTurn(deps, chat({ session: ALIVE }));
    expect(seen.fails).toEqual([{ requestId: 'req-7', why: '这一轮没跑成：检出建不了', session: EMPTY }]);
    expect(seen.logs.some((l) => l.startsWith('error 指挥官会话：这一轮没跑成'))).toBe(true);
  });
});

describe('让别家挑错', () => {
  it('一次性会话，不续、不按需求选的模型；避开指挥官现在用的模型；意见逐条交给写回', async () => {
    const text = `看过了\n\n\`\`\`${REVIEW_BLOCK}\n${JSON.stringify({ items: ['验收条看不见', '没写不做什么'] })}\n\`\`\``;
    const { deps, seen } = fake({ ok: true, text, session: EMPTY, modelId: 'm-gpt' });
    await runIntakeChatTurn(deps, chat({ job: 'review', session: ALIVE, modelChoice: 'm-opus' }));
    const s = seen.sessions[0];
    expect(s?.kind).toBe('review');
    expect(s?.resume).toBeNull();
    expect(s?.modelId).toBeNull();
    expect(s?.avoidModelIds).toEqual(['m-opus']);
    expect(seen.reviews).toEqual([
      { requestId: 'req-7', draftVersion: 3, model: 'm-gpt', items: ['验收条看不见', '没写不做什么'] },
    ]);
  });

  it('【故意造出的失败】意见认不出：写暂停原因，指挥官的会话原样留着', async () => {
    const { deps, seen } = fake({ ok: true, text: '没附那一块', session: EMPTY, modelId: 'm-gpt' });
    await runIntakeChatTurn(deps, chat({ job: 'review', session: ALIVE }));
    expect(seen.reviews).toEqual([]);
    expect(seen.fails).toEqual([
      { requestId: 'req-7', why: expect.stringMatching(/^别家的意见认不出：/), session: ALIVE },
    ]);
  });
});

describe('提示词', () => {
  it('重起的那份：只读检出、没有 GitHub 令牌、先填草稿栏、写明第几次发言、人改过的栏点名', () => {
    const p = freshCommanderPrompt(chat());
    expect(p).toContain('只读检出');
    expect(p).toContain('没有 GitHub 令牌');
    expect(p).toContain('一次只问一个问题');
    expect(p).toContain('每一轮先把能从代码和已有对话里推出来的草稿栏填上');
    expect(p).toContain('当前是第 2 次发言之后');
    expect(p).toContain('不回到逐条提问');
    expect(p).toMatch(/人改过的栏[\s\S]*scene/);
    expect(p).toContain('甲（人）：想要导出报表');
  });

  it('人第 3 次发言之后：这一轮必须给 proposal，新信息也直接给更新后的方案', () => {
    const third = chat({
      messages: [
        ...chat().messages,
        { id: 4, kind: 'human', authorName: '甲', body: '按月，给财务', card: null, createdAt: T0 },
      ],
    });
    const p = freshCommanderPrompt(third);
    expect(p).toContain('当前是第 3 次发言之后');
    expect(p).toContain('必须输出一张 proposal');
    expect(p).toContain('不要再追问');
    expect(p).toContain('确认开单');
    expect(p).toContain('改某一栏');
    expect(p).toContain(
      '创始人要是又提了新信息：把新信息写进 patch，这一轮直接给更新后的 proposal，不回到逐条提问。',
    );
    expect(p).not.toContain('接着问下一个问题');
  });

  it('续的那份没有新消息时，还没给方案就给方案', () => {
    const p = resumeCommanderPrompt(chat({ lastMessageId: 3 }));
    expect(p).toContain('让指挥官接着问');
    expect(p).toContain('还没给方案就给方案');
    expect(p).not.toContain('接着问下一个问题');
    expect(p).toContain('不回到逐条提问');
  });

  it('挑错的那份要求交回 fleet-review 那一块', () => {
    expect(reviewPrompt(chat())).toContain(`\`\`\`${REVIEW_BLOCK}`);
  });
});

describe('写到哪了', () => {
  it('读代码推「正在读代码」，说话推写到哪了，给服务端看的那一块不推给页面', () => {
    const state = { text: '' };
    expect(progressOf(state, { kind: 'tool_call', text: 'Read a.ts' })).toEqual({
      phase: 'reading_code',
      text: '',
    });
    expect(
      progressOf(state, { kind: 'assistant', text: `先说一句\n\`\`\`${COMMANDER_BLOCK}\n{}\n\`\`\`` }),
    ).toEqual({
      phase: 'writing',
      text: '先说一句',
    });
    expect(progressOf(state, { kind: 'result', text: 'x' })).toBeNull();
  });
});

describe('闲置收会话', () => {
  it('闲置满 30 分钟的删检出、清会话；删不掉的留着下一眼再删，不清会话', async () => {
    const { deps, seen } = fake({ ok: true, text: '', session: EMPTY, modelId: 'm' });
    const cutoffs: Date[] = [];
    const forgot: string[] = [];
    deps.idle = async (cutoff) => {
      cutoffs.push(cutoff);
      return [
        { requestId: 'a', workdir: '/w/a' },
        { requestId: 'b', workdir: '/w/b' },
      ];
    };
    deps.removeDir = async (dir) => {
      if (dir === '/w/b') throw new Error('被占着');
    };
    deps.forget = async (i) => {
      forgot.push(i.requestId);
      return true;
    };
    expect(await reapIdleIntakeChats(deps)).toBe(1);
    expect(cutoffs[0]?.toISOString()).toBe('2026-10-14T02:30:00.000Z');
    expect(forgot).toEqual(['a']);
    expect(seen.logs.some((l) => l.includes('闲置的检出没删掉'))).toBe(true);
  });
});
