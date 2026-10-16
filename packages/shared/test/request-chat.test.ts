// 指挥官会话的判法（#2061）：@ 判断、限额、会话交回来的话怎么认、草稿补丁怎么分。
// 接口层（真库、登录会话）在 packages/api/test/request-chat.test.ts，引擎那头在 packages/engine/test/intake-chat.test.ts。
import { describe, expect, it } from 'vitest';
import {
  COMMANDER_PAUSED_PREFIX,
  commanderShouldReply,
  INTAKE_CHAT_LIMITS,
  INTAKE_PROPOSAL_AFTER_TURNS,
  judgeCommanderTurn,
  mentionsCommander,
  ProposalCardSchema,
  parseCommanderOutput,
  parseReviewOutput,
  proposalCard,
  splitCommanderPatch,
  visibleCommanderText,
} from '../src/request-chat.ts';
import {
  RequestCardSchema,
  RequestDetailResponse,
  SendRequestMessageRequest,
} from '../src/web-api/requests.ts';

describe('@ 判断：指挥官什么时候说话', () => {
  it('只有一个人说过话：每句都回', () => {
    expect(commanderShouldReply({ humanSpeakerIds: ['a'], mentioned: false, nudge: false }).reply).toBe(true);
    expect(
      commanderShouldReply({ humanSpeakerIds: ['a', 'a', 'a'], mentioned: false, nudge: false }).reply,
    ).toBe(true);
  });

  it('两个人都说过话：不 @指挥官、没人点「让指挥官接着问」就不说话，原因写明', () => {
    const v = commanderShouldReply({ humanSpeakerIds: ['a', 'b'], mentioned: false, nudge: false });
    expect(v.reply).toBe(false);
    expect(v.why).toContain('两个人都说过话');
  });

  it('两个人都说过话：被 @指挥官 或有人点「让指挥官接着问」才说话', () => {
    expect(commanderShouldReply({ humanSpeakerIds: ['a', 'b'], mentioned: true, nudge: false }).reply).toBe(
      true,
    );
    expect(commanderShouldReply({ humanSpeakerIds: ['a', 'b'], mentioned: false, nudge: true }).reply).toBe(
      true,
    );
  });

  it('正文里写「@指挥官」算 @ 了它；别的 @ 不算', () => {
    expect(mentionsCommander('@指挥官 你看这样行不行')).toBe(true);
    expect(mentionsCommander('@乙 你看这样行不行')).toBe(false);
  });

  it('发消息的约定带 mentionCommander，默认不 @', () => {
    expect(SendRequestMessageRequest.parse({ body: 'x' }).mentionCommander).toBe(false);
    expect(SendRequestMessageRequest.parse({ body: 'x', mentionCommander: true }).mentionCommander).toBe(
      true,
    );
  });
});

describe('限额：每人同时 3 条在聊、每条 40 轮，超了回「指挥官暂停了：原因」', () => {
  const base = {
    busy: false,
    turns: 0,
    otherActive: 0,
    thisActive: false,
    engine: { on: true } as const,
    modelsConfigured: true,
    limits: INTAKE_CHAT_LIMITS,
  };

  it('默认值是 3 条、40 轮、闲置 30 分钟；方案从第 3 次发言之后给出，40 轮硬上限不动', () => {
    expect(INTAKE_CHAT_LIMITS).toEqual({ maxActivePerUser: 3, maxTurns: 40, idleMinutes: 30 });
    expect(INTAKE_PROPOSAL_AFTER_TURNS).toBe(3);
  });

  it('都没超：能排', () => {
    expect(judgeCommanderTurn(base)).toEqual({ ok: true });
  });

  it('聊满 40 轮：不排，原因写明上限', () => {
    const v = judgeCommanderTurn({ ...base, turns: 40 });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.code).toBe('turns');
    expect(!v.ok && v.why).toMatch(new RegExp(`^${COMMANDER_PAUSED_PREFIX}.*40 轮`));
  });

  it('另外已有 3 条在聊：新的一条不排；这一条本来就活着的照排', () => {
    const v = judgeCommanderTurn({ ...base, otherActive: 3 });
    expect(!v.ok && v.code).toBe('active');
    expect(!v.ok && v.why).toContain('同时最多 3 条');
    expect(judgeCommanderTurn({ ...base, otherActive: 3, thisActive: true })).toEqual({ ok: true });
  });

  it('数字可调：限额给 1 条、2 轮就按 1、2 判', () => {
    const limits = { maxActivePerUser: 1, maxTurns: 2, idleMinutes: 5 };
    expect(judgeCommanderTurn({ ...base, limits, turns: 2 }).ok).toBe(false);
    expect(judgeCommanderTurn({ ...base, limits, otherActive: 1 }).ok).toBe(false);
    expect(judgeCommanderTurn({ ...base, limits, turns: 1 }).ok).toBe(true);
  });

  it('引擎关着（额度熔断）、用途没配模型、还在回上一句：各写各的原因', () => {
    const off = judgeCommanderTurn({ ...base, engine: { on: false, why: '额度熔断' } });
    expect(!off.ok && off.why).toBe(
      '指挥官暂停了：引擎总开关关着（额度熔断），起不了指挥官：主页打开总开关后再发一句',
    );
    const none = judgeCommanderTurn({ ...base, modelsConfigured: false });
    expect(!none.ok && none.why).toContain('intake-chat');
    const busy = judgeCommanderTurn({ ...base, busy: true });
    expect(!busy.ok && busy.code).toBe('busy');
  });
});

describe('会话交回来的话：回话正文 + 一块 fleet-intake', () => {
  const block = (json: unknown) => `\n\`\`\`fleet-intake\n${JSON.stringify(json)}\n\`\`\``;

  it('正文 + 一个问题（2～4 个选项）+ 补丁', () => {
    const got = parseCommanderOutput(
      `我读了导出那块代码，先问一个。${block({
        question: { text: '导出给谁用？', options: ['自己看', '发给客户'] },
        patch: { title: '导出按钮' },
      })}`,
    );
    expect(got).toEqual({
      ok: true,
      value: {
        reply: '我读了导出那块代码，先问一个。',
        question: { text: '导出给谁用？', options: ['自己看', '发给客户'] },
        patch: { title: '导出按钮' },
      },
    });
  });

  it('只说话、不带那一块：照收，没有问题、没有补丁', () => {
    expect(parseCommanderOutput('好的，草稿齐了。')).toEqual({
      ok: true,
      value: { reply: '好的，草稿齐了。' },
    });
  });

  it('选项只有 1 个或 5 个：明说不合规矩', () => {
    for (const options of [['只有一个'], ['1', '2', '3', '4', '5']]) {
      const got = parseCommanderOutput(`问一下${block({ question: { text: '?', options } })}`);
      expect(got.ok).toBe(false);
      expect(!got.ok && got.why).toContain('选项要 2～4 个');
    }
  });

  it('块里不是 JSON、多了别的键、正文是空的：都明说认不出', () => {
    expect(parseCommanderOutput('话\n```fleet-intake\n{坏的\n```').ok).toBe(false);
    const extra = parseCommanderOutput(`话${block({ question: undefined, closeIssue: true })}`);
    expect(!extra.ok && extra.why).toContain('不合规矩');
    const empty = parseCommanderOutput(block({ patch: { title: 'x' } }));
    expect(!empty.ok && empty.why).toBe('回话正文是空的');
  });

  it('proposal 卡：完整摘要；和问题一起交时只留方案', () => {
    const got = parseCommanderOutput(
      `方案齐了。${block({
        proposal: { summary: '标题：导出\n场景：月底对账' },
        question: { text: '还问吗？', options: ['问', '不问'] },
        patch: { scene: '月底对账' },
      })}`,
    );
    expect(got).toEqual({
      ok: true,
      value: {
        reply: '方案齐了。',
        proposal: { summary: '标题：导出\n场景：月底对账' },
        patch: { scene: '月底对账' },
      },
    });
  });

  it('proposal 摘要是空的：明说不合规矩', () => {
    const got = parseCommanderOutput(`话${block({ proposal: { summary: '  ' } })}`);
    expect(got.ok).toBe(false);
    expect(!got.ok && got.why).toContain('不合规矩');
  });

  it('方案卡带草稿版本号，页面认的卡和解析用的卡是同一张', () => {
    const card = proposalCard(3, '标题：导出');
    expect(card).toEqual({ type: 'proposal', draftVersion: 3, summary: '标题：导出' });
    expect(ProposalCardSchema.parse(card)).toEqual(card);
    expect(RequestCardSchema.parse(card)).toEqual(card);
    expect(RequestCardSchema.safeParse({ type: 'proposal', summary: '缺版本号' }).success).toBe(false);
  });

  it('问题卡存成结构化的 question 卡（页面直接渲染成按钮，另加「我自己说」）', () => {
    const card = {
      type: 'question',
      question: '导出给谁用？',
      options: ['自己看', '发给客户'],
      allowOwn: true,
    };
    expect(RequestCardSchema.parse(card)).toEqual(card);
    expect(RequestCardSchema.safeParse({ ...card, options: ['一个'] }).success).toBe(false);
  });

  it('流给页面的那段不带给服务端看的块（写到一半的也不带）', () => {
    expect(visibleCommanderText('先说一句\n```fleet-intake\n{"patch":')).toBe('先说一句');
    expect(visibleCommanderText('还在写')).toBe('还在写');
  });
});

describe('别家挑错交回来的意见', () => {
  it('fleet-review 里一条条意见', () => {
    expect(parseReviewOutput('看了\n```fleet-review\n{"items":["缺回退方案","验收条看不见"]}\n```')).toEqual({
      ok: true,
      items: ['缺回退方案', '验收条看不见'],
    });
  });

  it('没有那一块、一条都没有：明说', () => {
    expect(parseReviewOutput('没问题').ok).toBe(false);
    expect(parseReviewOutput('```fleet-review\n{"items":[]}\n```').ok).toBe(false);
  });
});

describe('草稿补丁：只改那九栏，人改过的转「建议改」，别的服务端拒掉', () => {
  it('能改的栏直接改；人改过的栏不改、转建议改', () => {
    const got = splitCommanderPatch({ title: '导出按钮', scene: '运营要导出订单' }, ['title']);
    expect(got.apply).toEqual({ scene: '运营要导出订单' });
    expect(got.suggest).toEqual([{ field: 'title', value: '导出按钮' }]);
    expect(got.rejected).toEqual([]);
  });

  it('不在白名单里的栏（原话、状态、拍板人）拒掉，写原因', () => {
    const got = splitCommanderPatch(
      { quotes: '改原话', status: 'closed_do', deciderId: 'x', want: '要导出' },
      [],
    );
    expect(got.apply).toEqual({ want: '要导出' });
    expect(got.rejected.map((r) => r.field).sort()).toEqual(['deciderId', 'quotes', 'status']);
    for (const r of got.rejected) expect(r.why).toBe('不在指挥官能改的栏里');
  });

  it('文字栏写成字符串数组（法国 2026-10-14 点验里模型这么写过）：拼成每行「- 」开头的一段；只有一条就原样', () => {
    const got = splitCommanderPatch(
      { modules: ['README.md', '.github/workflows/ci.yml'], notDo: ['不改代码'], want: [] },
      [],
    );
    expect(got.apply).toEqual({ modules: '- README.md\n- .github/workflows/ci.yml', notDo: '不改代码' });
    expect(got.rejected).toEqual([{ field: 'want', why: '值是空的' }]);
  });

  it('类别只认需求、缺陷、杂项（法国点验里模型写过「文档」，拍板时开单才失败）', () => {
    const got = splitCommanderPatch({ kind: '文档', size: '小' }, []);
    expect(got.apply).toEqual({ size: '小' });
    expect(got.rejected).toEqual([{ field: 'kind', why: '类别只能是需求、缺陷、杂项' }]);
    expect(splitCommanderPatch({ kind: '杂项' }, []).apply).toEqual({ kind: '杂项' });
  });

  it('值不合规矩（怎么算做完不是一串、标题超长）拒掉', () => {
    const got = splitCommanderPatch({ done: '一句话', title: 'x'.repeat(101) }, []);
    expect(got.apply).toEqual({});
    expect(got.rejected.map((r) => r.field).sort()).toEqual(['done', 'title']);
  });

  it('九栏都认：标题、类别、场景、已知的模块、要什么、怎么算做完、不做什么、规模建议、要不要人拍', () => {
    const all = {
      title: 't',
      kind: '需求',
      scene: 's',
      modules: 'm',
      want: 'w',
      done: ['d'],
      notDo: 'n',
      size: '小',
      needsHuman: '碰发布',
    };
    expect(splitCommanderPatch(all, []).apply).toEqual(all);
  });
});

describe('详情的约定带指挥官会话', () => {
  it('commander 是必填：在不在跑、模型、能换哪些、几轮', () => {
    const shape = RequestDetailResponse.shape.commander;
    expect(
      shape.safeParse({
        state: 'running',
        running: true,
        model: null,
        defaultModel: { id: 'sonnet-5.5', name: 'Sonnet 5.5' },
        models: [{ id: 'sonnet-5.5', name: 'Sonnet 5.5' }],
        turns: 1,
        maxTurns: 40,
      }).success,
    ).toBe(true);
    expect(shape.safeParse(undefined).success).toBe(false);
  });
});
