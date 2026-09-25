// 飞书四张表的库级约束：接口这边按约定先查一遍，但库自己也得拦（换个人写库、手工改数据时照样成立）。
// 直接写 SQL 造违规：drizzle 的类型挡住的不合写法，只有绕过去才试得出来。
import { createTestDb, resetTestDb, TEST_DB_TIMEOUT_MS, type TestDb } from '@fleet-dao/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IDS } from '../src/dev-fixtures.ts';
import { seedPg } from './pg-fixtures.ts';
import { FEISHU_IDS, feishuData } from './store-contract-feishu.ts';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, TEST_DB_TIMEOUT_MS);
afterAll(() => t.close());
beforeEach(async () => {
  await resetTestDb(t);
  await seedPg(t.db, feishuData());
});

const run = (sql: string, params: unknown[] = []) => t.client.query(sql, params);

/** 一张合规的草稿，按需改几列。 */
function draftSql(over: Record<string, string> = {}): string {
  const cols: Record<string, string> = {
    id: `'${FEISHU_IDS.draft1}'`,
    revision: '1',
    status: "'open'",
    source_message_id: "'om_x'",
    chat_type: "'p2p'",
    raw_text: "'原话'",
    understanding: "'我理解为'",
    unsure: 'true',
    proposed_by: `'${IDS.founderA}'`,
    ...over,
  };
  return `insert into feishu_drafts (${Object.keys(cols).join(', ')}) values (${Object.values(cols).join(', ')})`;
}

/** 一行合规的送达状态，按需改几列。 */
function outboxSql(over: Record<string, string> = {}): string {
  const cols: Record<string, string> = { id: "'ask:1'", revision: '1', fingerprint: "'f'", ...over };
  return `insert into feishu_outbox (${Object.keys(cols).join(', ')}) values (${Object.values(cols).join(', ')})`;
}

describe('飞书表的库级约束', () => {
  it('草稿：取值、长度、确认的样子、任务只挂在确认过的草稿上、同一条消息一张草稿、人和仓得在库里', async () => {
    const confirmedOk = {
      status: "'confirmed'",
      confirmed_by: `'${IDS.founderB}'`,
      confirmed_at: 'now()',
      repo_id: `'${IDS.repo}'`,
    };
    const bad: Array<[string, string, RegExp]> = [
      [
        '「我理解为」超过 1000 字',
        draftSql({ understanding: `'${'x'.repeat(1001)}'` }),
        /understanding_length/,
      ],
      ['「我理解为」是空串', draftSql({ understanding: "''" }), /understanding_length/],
      ['状态不认识', draftSql({ status: "'pending'" }), /status_known/],
      ['会话类型不认识', draftSql({ chat_type: "'guild'" }), /chat_type_known/],
      ['版本小于 1', draftSql({ revision: '0' }), /revision_positive/],
      ['开单次数是负的', draftSql({ intake_attempts: '-1' }), /intake_attempts_nonneg/],
      ['确认了却没写确认人', draftSql({ ...confirmedOk, confirmed_by: 'null' }), /confirm_shape/],
      ['确认了却没选仓', draftSql({ ...confirmedOk, repo_id: 'null' }), /confirm_shape/],
      [
        '没确认却有确认人',
        draftSql({ confirmed_by: `'${IDS.founderA}'`, confirmed_at: 'now()' }),
        /confirm_shape/,
      ],
      ['没确认却挂了任务', draftSql({ task_id: `'${IDS.task12}'` }), /task_needs_confirm/],
      ['提出人不在库里', draftSql({ proposed_by: "'99999999-0000-4000-8000-000000000000'" }), /proposed_by/],
      ['仓不在库里', draftSql({ repo_id: "'99999999-0000-4000-8000-000000000000'" }), /repo_id/],
    ];
    for (const [what, sql, why] of bad) {
      await expect(run(sql), what).rejects.toThrow(why);
    }
    await run(draftSql({ ...confirmedOk, task_id: `'${IDS.task12}'` }));
    await expect(run(draftSql({ id: `'${FEISHU_IDS.draft2}'` })), '同一条消息第二张草稿').rejects.toThrow(
      /source_message_id/,
    );
  });

  it('推送的送达状态：回执整条在或整条不在、不超过当前版本、取值认得；只有推迟/没发成才有等待期；送到的卡三样齐全', async () => {
    const acked = { ack_revision: '1', ack_status: "'sent'", acked_at: 'now()' };
    const bad: Array<[string, string, RegExp]> = [
      ['版本小于 1', outboxSql({ revision: '0' }), /revision_positive/],
      ['只有回执结果没有回执版本', outboxSql({ ack_status: "'sent'", acked_at: 'now()' }), /ack_shape/],
      ['回执版本比现在的还新', outboxSql({ ...acked, ack_revision: '2' }), /ack_shape/],
      ['回执结果不认识', outboxSql({ ...acked, ack_status: "'lost'" }), /ack_status_known/],
      ['「发了」还带等待期', outboxSql({ ...acked, hold_until: 'now()' }), /hold_only_when_waiting/],
      ['送到的卡只记了消息编号', outboxSql({ delivered_message_id: "'om_x'" }), /delivered_shape/],
      ['没发成次数是负的', outboxSql({ failures: '-1' }), /failures_nonneg/],
    ];
    for (const [what, sql, why] of bad) {
      await expect(run(sql), what).rejects.toThrow(why);
    }
    await run(outboxSql({ ...acked, ack_status: "'deferred'", hold_until: 'now()' }));
    await run(
      outboxSql({
        id: "'ask:2'",
        delivered_message_id: "'om_x'",
        delivered_chat_id: "'oc_x'",
        delivered_at: 'now()',
      }),
    );
  });

  it('卡片登记：种类只认约定里的那几种', async () => {
    await run(
      "insert into feishu_cards (message_id, chat_id, kind, sent_at) values ('om_1', 'oc_1', 'draft', now())",
    );
    await expect(
      run(
        "insert into feishu_cards (message_id, chat_id, kind, sent_at) values ('om_2', 'oc_1', 'menu', now())",
      ),
    ).rejects.toThrow(/kind_known/);
  });

  it('关注：一个人对一个需求只有一行；需求没了关注跟着走（不挡删需求）', async () => {
    await run('insert into feishu_follows (task_id, user_id, following) values ($1, $2, true)', [
      FEISHU_IDS.task2of12,
      IDS.founderA,
    ]);
    await expect(
      run('insert into feishu_follows (task_id, user_id, following) values ($1, $2, false)', [
        FEISHU_IDS.task2of12,
        IDS.founderA,
      ]),
    ).rejects.toThrow(/pk|duplicate/);
    await run('delete from tasks where id = $1', [FEISHU_IDS.task2of12]);
    expect((await run('select count(*)::int as n from feishu_follows')).rows).toEqual([{ n: 0 }]);
  });
});
