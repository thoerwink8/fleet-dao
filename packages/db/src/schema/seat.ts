// 帅位只一个（#299，specs/299-帅位只一个/方案.md 第二节）：帅位租约一个座位一行，认领每张单一行。判法在 @fleet-dao/core 的
// seat.ts（状态、主人的几种字样和这里的约束是同一组，改一边两边一起改）；读写在 @fleet-dao/api 的 pg-store.ts。
// 改这里之前必须知道：心跳、续约、过期一律写库的 now()，不拿各机器的时钟；接班和抢认领都是一条原子语句（方案第二节）。
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { repos } from './work.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

/**
 * 帅位：scope = main 是真帅位，drill:<名字> 是演练（和真帅位互不影响）。term 是第几任，接班一次加一、只增不减，纯
 * 记录用（#446 起不再是栅栏号：没有什么会核它对不对得上再放行）。previous_* 是接班时从旧行抄过来的上一任。renewed_at
 * 这一列没改名（避免迁移），#446 起当「最后活动时间」用，只给人看。
 */
export const seatLeases = pgTable(
  'seat_leases',
  {
    scope: text('scope').primaryKey(),
    term: bigint('term', { mode: 'number' }).notNull(),
    holderMachine: text('holder_machine').notNull(),
    holderSession: text('holder_session').notNull(),
    acquiredAt: timestamp('acquired_at', tz).notNull(),
    renewedAt: timestamp('renewed_at', tz).notNull(),
    previousMachine: text('previous_machine'),
    previousSession: text('previous_session'),
    /** 最新一份交接说明（只算补充：交接以从库里现算的为准）。 */
    handoff: text('handoff'),
    handoffAt: timestamp('handoff_at', tz),
  },
  (t) => [
    check('seat_leases_term_positive', sql`${t.term} > 0`),
    check('seat_leases_scope_known', sql`${t.scope} = 'main' or ${t.scope} like 'drill:%'`),
    check('seat_leases_handoff_shape', sql`(${t.handoff} is null) = (${t.handoffAt} is null)`),
    check('seat_leases_previous_shape', sql`(${t.previousMachine} is null) = (${t.previousSession} is null)`),
  ],
);

/**
 * 认领：每张单一行（主键），记归谁——引擎，或某台机器上的帅位、工人。claim_id 是认领号，每认领一次换一个，是工人的栅栏号。
 * 结束了（done / released / voided）的行留着，直到这张单下一次被认领时整行换掉：拿着旧认领号来的查得出「已作废，现在归谁」。
 * pending_start 只有引擎有：先写待起，再起工作流，起失败的由对账照 workflow_id 补起（编号每张单固定，不会起两份）。
 */
export const issueClaims = pgTable(
  'issue_claims',
  {
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id),
    issueNumber: integer('issue_number').notNull(),
    claimId: uuid('claim_id').notNull(),
    ownerKind: text('owner_kind').$type<'engine' | 'seat' | 'worker'>().notNull(),
    ownerMachine: text('owner_machine'),
    ownerLabel: text('owner_label'),
    seatScope: text('seat_scope'),
    seatTerm: bigint('seat_term', { mode: 'number' }),
    state: text('state')
      .$type<'pending_start' | 'claimed' | 'doing' | 'pr_open' | 'done' | 'released' | 'voided'>()
      .notNull(),
    workflowId: text('workflow_id'),
    prNumbers: integer('pr_numbers').array().notNull().default(sql`'{}'::integer[]`),
    graceMinutes: integer('grace_minutes').notNull(),
    claimedAt: timestamp('claimed_at', tz).notNull(),
    heartbeatAt: timestamp('heartbeat_at', tz).notNull(),
    updatedAt: timestamp('updated_at', tz).notNull(),
    endedAt: timestamp('ended_at', tz),
    endReason: text('end_reason'),
    note: text('note'),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.issueNumber] }),
    unique('issue_claims_claim_id_unique').on(t.claimId),
    check('issue_claims_issue_number_positive', sql`${t.issueNumber} > 0`),
    check('issue_claims_owner_kind_known', sql`${t.ownerKind} in ('engine', 'seat', 'worker')`),
    check(
      'issue_claims_state_known',
      sql`${t.state} in ('pending_start', 'claimed', 'doing', 'pr_open', 'done', 'released', 'voided')`,
    ),
    // 引擎的没有机器、工人名，要有工作流编号；本机的两样都要有
    check(
      'issue_claims_owner_shape',
      sql`case when ${t.ownerKind} = 'engine' then ${t.ownerMachine} is null and ${t.ownerLabel} is null and ${t.workflowId} is not null else ${t.ownerMachine} is not null and ${t.ownerLabel} is not null end`,
    ),
    check(
      'issue_claims_pending_engine_only',
      sql`${t.state} <> 'pending_start' or ${t.ownerKind} = 'engine'`,
    ),
    check(
      'issue_claims_ended_shape',
      sql`(${t.state} in ('done', 'released', 'voided')) = (${t.endedAt} is not null)`,
    ),
    check(
      'issue_claims_end_reason',
      sql`${t.state} not in ('released', 'voided') or coalesce(length(${t.endReason}), 0) > 0`,
    ),
    check('issue_claims_seat_shape', sql`(${t.seatScope} is null) = (${t.seatTerm} is null)`),
    check('issue_claims_grace_positive', sql`${t.graceMinutes} > 0`),
    // 作废扫的是还活着的认领按心跳
    index('issue_claims_state_heartbeat_idx').on(t.state, t.heartbeatAt),
  ],
);

/**
 * 帅位栏（#199）：一个座位、一个项目一行。四段 jsonb 都是数组，细形状由 core 的 readSeatBoard 判。
 * 首页只读 scope = main。updated_at 和步骤里的时刻都用库的 now()。
 */
export const seatBoards = pgTable(
  'seat_boards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: text('scope').notNull(),
    project: text('project').notNull(),
    headline: text('headline').notNull().default(''),
    steps: jsonb('steps').notNull().default(sql`'[]'::jsonb`),
    log: jsonb('log').notNull().default(sql`'[]'::jsonb`),
    needs: jsonb('needs').notNull().default(sql`'[]'::jsonb`),
    answers: jsonb('answers').notNull().default(sql`'[]'::jsonb`),
    updatedAt: timestamp('updated_at', tz).notNull(),
  },
  (t) => [
    unique('seat_boards_scope_project_unique').on(t.scope, t.project),
    check('seat_boards_scope_known', sql`${t.scope} = 'main' or ${t.scope} like 'drill:%'`),
    check('seat_boards_steps_array', sql`jsonb_typeof(${t.steps}) = 'array'`),
    check('seat_boards_log_array', sql`jsonb_typeof(${t.log}) = 'array'`),
    check('seat_boards_needs_array', sql`jsonb_typeof(${t.needs}) = 'array'`),
    check('seat_boards_answers_array', sql`jsonb_typeof(${t.answers}) = 'array'`),
  ],
);
