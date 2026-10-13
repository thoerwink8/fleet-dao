// fleet-api intent …（#553 第 4 条）：指挥官经 ssh 读全部原话、开单时写回归纳和「已开成 #N」、放下。
// 参数不对不连库（退出码 2）；没有这段、不让写退出码 1；连不上库退出码 1，--json 时打 ok=false，绝不打空列表（B7）。
// 存储的语义在 intent-store-contract.ts；这里管命令这一层（内存版存储）。
import {
  IntentCliFailure,
  IntentCliListOutput,
  IntentCliShowOutput,
  IntentCliWriteOutput,
} from '@fleet-dao/shared';
import { IDS } from '@fleet-dao/store';
import { describe, expect, it } from 'vitest';
import { type CliDeps, main } from '../src/cli.ts';
import { createMemoryIntentStore, type IntentStore } from '../src/intent-store.ts';

const T0 = new Date('2026-10-04T06:00:00.000Z');

function setup(
  over: {
    intents?: IntentStore;
    open?: CliDeps['openIntents'];
    stdin?: string;
    files?: Record<string, string>;
  } = {},
) {
  const intents = over.intents ?? createMemoryIntentStore({ now: () => new Date(T0) });
  const out: string[] = [];
  const err: string[] = [];
  let opened = 0;
  const deps: CliDeps = {
    env: { DATABASE_URL: 'postgres:///fleet', FLEET_OPS_OPERATOR: 'root' },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    openStore: async () => {
      throw new Error('intent 命令不该连 Store');
    },
    openIntents:
      over.open ??
      (async () => {
        opened += 1;
        return { intents, close: async () => {} };
      }),
    readStdin: async () => over.stdin ?? '',
    readFile: async (path) => {
      const text = over.files?.[path];
      if (text === undefined) throw new Error(`ENOENT: no such file ${path}`);
      return text;
    },
    now: () => new Date(T0),
  };
  const run = async (...args: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await main(['intent', ...args], deps);
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const json = async (...args: string[]) => {
    const r = await run(...args, '--json');
    return { code: r.code, raw: r.out, body: JSON.parse(r.out) as unknown };
  };
  return { intents, run, json, opened: () => opened };
}

async function seed(intents: IntentStore) {
  const base = {
    chatId: 'oc_team',
    chatKind: 'group' as const,
    source: 'event' as const,
    msgType: 'text',
    atBot: false,
    newSegment: false,
  };
  await intents.intakeMessage({
    ...base,
    messageId: 'om_1',
    sentAt: '2026-10-04T06:02:00.000Z',
    text: '我觉得驾驶舱首页太乱了',
    rawContent: '{"text":"我觉得驾驶舱首页太乱了"}',
    senderUserId: IDS.founderA,
    senderName: '甲',
  });
  await intents.intakeMessage({
    ...base,
    messageId: 'om_2',
    sentAt: '2026-10-04T06:05:00.000Z',
    text: '对，要一眼看到要我拍的\n第二行',
    rawContent: '{"text":"对"}',
    senderUserId: IDS.founderB,
    senderName: '乙',
  });
}

describe('fleet-api intent：参数', () => {
  it.each([
    [[], '少了子命令'],
    [['nope'], '认不出子命令'],
    [['show'], '要且只要一个意图号'],
    [['show', '0'], '正整数'],
    [['list', '--status', 'open'], '--status 只认'],
    [['list', '--limit', '9999'], '--limit'],
    [['link', '1', '--by', 'x', '--summary-file', '-'], '--issue'],
    [['link', '1', '--issue', 'fleet-dao#5', '--by', 'x', '--summary-file', '-'], 'owner/仓#号'],
    [['link', '1', '--issue', 'o/r#5', '--summary-file', '-'], '--by'],
    [['link', '1', '--issue', 'o/r#5', '--by', 'x'], '--summary-file'],
    [['drop', '1'], '--why'],
    [['show', '1', '--why', 'x'], '不认'],
    [['list', '--force'], '认不出参数'],
  ])('【故意造出的失败】%j：退出码 2，不连库', async (args, why) => {
    const s = setup();
    const r = await s.json(...args);
    expect(r.code).toBe(2);
    expect(IntentCliFailure.parse(r.body)).toMatchObject({ ok: false, reason: 'usage' });
    expect((r.body as { why: string }).why).toContain(why);
    expect(s.opened()).toBe(0);
  });

  it('--help 只打用法，不连库', async () => {
    const s = setup();
    const r = await s.run('--help');
    expect(r.code).toBe(0);
    expect(r.out).toContain('fleet-api intent list');
    expect(s.opened()).toBe(0);
  });

  it('【故意造出的失败】没带 DATABASE_URL：退出码 2，写明要带 api.env', async () => {
    const s = setup();
    const r = await main(['intent', 'list'], {
      env: {},
      out: () => {},
      err: (t) => {
        expect(t).toContain('DATABASE_URL');
      },
      openStore: async () => {
        throw new Error('不该连');
      },
      now: () => T0,
    });
    expect(r).toBe(2);
    expect(s.opened()).toBe(0);
  });
});

describe('fleet-api intent：读', () => {
  it('list --json：全部原话原样、带说话人和时刻；形状照 shared 的约定', async () => {
    const s = setup();
    await seed(s.intents);
    const r = await s.json('list');
    expect(r.code).toBe(0);
    const body = IntentCliListOutput.parse(r.body);
    expect(body.intents).toHaveLength(1);
    expect(body.intents[0]?.messages.map((m) => [m.ord, m.senderName, m.text])).toEqual([
      [1, '甲', '我觉得驾驶舱首页太乱了'],
      [2, '乙', '对，要一眼看到要我拍的\n第二行'],
    ]);
  });

  it('show（给人看）：原话一条一行、多行的接着缩进；还没归纳就不编归纳', async () => {
    const s = setup();
    await seed(s.intents);
    const r = await s.run('show', '1');
    expect(r.code).toBe(0);
    expect(r.out).toContain('意图 1 · 新 · 群 oc_team · 2 条原话 · 甲、乙 · 10-04 14:02–14:05（北京时间）');
    expect(r.out).toContain('  [1 · 10-04 14:02 · 甲] 我觉得驾驶舱首页太乱了');
    expect(r.out).toContain('  [2 · 10-04 14:05 · 乙] 对，要一眼看到要我拍的\n    第二行');
    expect(r.out).not.toContain('AI 归纳');
  });

  it('真的没有：只有读成了才说「没有」', async () => {
    const s = setup();
    const r = await s.run('list');
    expect(r.code).toBe(0);
    expect(r.out).toBe('读成了：没有还没处理的意图');
    expect(IntentCliListOutput.parse((await s.json('list')).body)).toEqual({
      ok: true,
      intents: [],
      more: false,
    });
  });

  it('超过 --limit：写明还有没列的（more），不让人把前几段当成全部', async () => {
    const s = setup();
    await seed(s.intents);
    await s.intents.intakeMessage({
      messageId: 'om_p',
      chatId: 'oc_p2p_a',
      chatKind: 'p2p',
      source: 'event',
      msgType: 'text',
      atBot: false,
      newSegment: false,
      sentAt: '2026-10-04T06:10:00.000Z',
      text: '私聊里随口一句',
      rawContent: '{"text":"私聊里随口一句"}',
      senderUserId: IDS.founderA,
      senderName: '甲',
    });
    const cut = IntentCliListOutput.parse((await s.json('list', '--limit', '1')).body);
    expect(cut.intents.map((i) => i.seq)).toEqual([1]);
    expect(cut.more).toBe(true);
    expect((await s.run('list', '--limit', '1')).out).toContain('还有没列的');
    expect(IntentCliListOutput.parse((await s.json('list', '--limit', '2')).body).more).toBe(false);
  });

  it('【故意造出的失败】没有这一段：退出码 1，not_found', async () => {
    const s = setup();
    const r = await s.json('show', '42');
    expect(r.code).toBe(1);
    expect(IntentCliFailure.parse(r.body)).toMatchObject({ reason: 'not_found' });
  });

  it('【故意造出的失败】连不上库（B7）：退出码 1、写明原因，绝不打空列表', async () => {
    const s = setup({
      open: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
      },
    });
    const r = await s.json('list');
    expect(r.code).toBe(1);
    expect(IntentCliFailure.parse(r.body)).toMatchObject({ ok: false, reason: 'error' });
    expect(r.raw).not.toContain('"intents"');
    expect(r.raw).toContain('ECONNREFUSED');
  });

  it('【故意造出的失败】读到一半库出错：退出码 1，不当成没有', async () => {
    const memory = createMemoryIntentStore();
    const s = setup({
      intents: {
        ...memory,
        list: async () => {
          throw new Error('意图 3 的 links 认不出');
        },
      },
    });
    const human = await s.run('list');
    expect(human.code).toBe(1);
    expect(human.err).toContain('links 认不出');
    expect(human.out).toBe('');
  });
});

describe('fleet-api intent：写回、放下', () => {
  it('link：归纳从标准输入读，写回后卡要原地改；同一张单再写只更新归纳', async () => {
    const s = setup({ stdin: '  首页改成一屏三块：要我拍的、在跑的、做完的。\n' });
    await seed(s.intents);
    const r = await s.json(
      'link',
      '1',
      '--issue',
      'thoerwink8/fleet-dao#812',
      '--by',
      '指挥官会话 · Claude Opus 5.5',
      '--summary-file',
      '-',
    );
    expect(r.code).toBe(0);
    const body = IntentCliWriteOutput.parse(r.body);
    expect(body.result).toBe('linked');
    expect(body.intent.summary).toMatchObject({
      text: '首页改成一屏三块：要我拍的、在跑的、做完的。',
      by: '指挥官会话 · Claude Opus 5.5',
      covers: 2,
    });
    expect(body.intent.links).toEqual([
      { issue: 'thoerwink8/fleet-dao#812', by: 'root', at: T0.toISOString() },
    ]);
    expect(body.intent.card.dueAt).toBe(T0.toISOString());
    const again = await s.json(
      'link',
      '1',
      '--issue',
      'thoerwink8/fleet-dao#812',
      '--by',
      'x',
      '--summary-file',
      '-',
    );
    expect(IntentCliWriteOutput.parse(again.body).result).toBe('updated');

    const memory = s.intents as ReturnType<typeof createMemoryIntentStore>;
    expect(memory.audits.map((a) => [a.action, a.target, a.reason])).toEqual([
      [
        'intent.link',
        'intent:1',
        '服务器上 root 跑的 fleet-api intent link 1 --issue thoerwink8/fleet-dao#812',
      ],
      [
        'intent.link',
        'intent:1',
        '服务器上 root 跑的 fleet-api intent link 1 --issue thoerwink8/fleet-dao#812',
      ],
    ]);
  });

  it('link：归纳从文件读', async () => {
    const s = setup({ files: { '/tmp/s.txt': '归纳正文' } });
    await seed(s.intents);
    const r = await s.json('link', '1', '--issue', 'o/r#5', '--by', 'x', '--summary-file', '/tmp/s.txt');
    expect(IntentCliWriteOutput.parse(r.body).intent.summary?.text).toBe('归纳正文');
  });

  it('【故意造出的失败】归纳读不到、是空的、太长：退出码 2，什么都没写', async () => {
    const s = setup({ stdin: '   ' });
    await seed(s.intents);
    const missing = await s.json('link', '1', '--issue', 'o/r#5', '--by', 'x', '--summary-file', '/nope.txt');
    expect(missing.code).toBe(2);
    expect((missing.body as { why: string }).why).toContain('读不到归纳');
    const empty = await s.json('link', '1', '--issue', 'o/r#5', '--by', 'x', '--summary-file', '-');
    expect(empty.code).toBe(2);
    expect((empty.body as { why: string }).why).toContain('归纳是空的');
    const s2 = setup({ stdin: '长'.repeat(2001) });
    await seed(s2.intents);
    const long = await s2.json('link', '1', '--issue', 'o/r#5', '--by', 'x', '--summary-file', '-');
    expect(long.code).toBe(2);
    expect(IntentCliShowOutput.parse((await s2.json('show', '1')).body).intent.status).toBe('new');
  });

  it('【故意造出的失败】已经开成了别的单：不带 --relink 拒（退出码 1，写明挂在哪）；带了再挂', async () => {
    const s = setup({ stdin: '归纳' });
    await seed(s.intents);
    await s.json('link', '1', '--issue', 'o/r#5', '--by', 'x', '--summary-file', '-');
    const refused = await s.json('link', '1', '--issue', 'o/r#6', '--by', 'x', '--summary-file', '-');
    expect(refused.code).toBe(1);
    expect(IntentCliFailure.parse(refused.body)).toMatchObject({ reason: 'refused' });
    expect((refused.body as { why: string }).why).toContain('o/r#5');
    const added = await s.json(
      'link',
      '1',
      '--issue',
      'o/r#6',
      '--by',
      'x',
      '--summary-file',
      '-',
      '--relink',
    );
    expect(IntentCliWriteOutput.parse(added.body).result).toBe('added');
  });

  it('drop：带理由放下；再放一次 already；开成了单的不能放下（退出码 1）', async () => {
    const s = setup({ stdin: '归纳' });
    await seed(s.intents);
    const dropped = await s.json('drop', '1', '--why', '闲聊');
    expect(IntentCliWriteOutput.parse(dropped.body)).toMatchObject({
      result: 'dropped',
      intent: { dropped: { reason: '闲聊', by: 'root' } },
    });
    expect(IntentCliWriteOutput.parse((await s.json('drop', '1', '--why', '闲聊')).body).result).toBe(
      'already',
    );
    await s.json('link', '1', '--issue', 'o/r#5', '--by', 'x', '--summary-file', '-');
    const refused = await s.json('drop', '1', '--why', '闲聊');
    expect(refused.code).toBe(1);
    expect(IntentCliFailure.parse(refused.body)).toMatchObject({ reason: 'refused' });
  });
});
