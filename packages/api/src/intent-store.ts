// 意图的存储口（#553 第 4 条；飞书收缩后网关不再写意图库，F1 #2051）：指挥官读、写回归纳和「已开成 #N」、放下；另有进群记录和飞书用量。
// 两份实现过同一套契约测试（test/intent-store-contract.ts）：这里的内存版（开发环境、测试），intent-store-pg.ts 的 Postgres 版。
// 改这里之前必须知道：
// - 判法（写回和放下让不让）只在 intents.ts 一份，两份存储只负责把要判的事实找齐、照结论写。
// - 读不到、写不进、库里的东西认不出一律抛（调用方回 5xx 或非 0 退出码写明原因），不拿空列表、0 冒充「没有」。
// - 写回归纳、开成单、放下和操作记录在同一个事务里：记不下就不改（Postgres 版）。
import { beijingMonth } from '@fleet-dao/shared';
import {
  type IntentMessageRecord,
  type IntentRecord,
  type IntentStatus,
  type IntentWithMessages,
  orderMessages,
  planDrop,
  planLink,
} from './intents.ts';
import type { NewAuditEntry } from './ports.ts';

export interface LinkInput {
  seq: number;
  issue: string;
  summary: { text: string; by: string };
  /** 谁挂的（服务器上跑命令的人）。 */
  operator: string;
  /** 已经开成了别的单，还要再挂这一张（并进已有的单、一段开成两张）。 */
  relink: boolean;
}

export type LinkResult =
  | { status: 'linked' | 'added' | 'updated'; intent: IntentWithMessages }
  | { status: 'not_found' }
  | { status: 'already_linked'; issues: string[] }
  | { status: 'empty' };

export interface DropInput {
  seq: number;
  reason: string;
  operator: string;
}

export type DropResult =
  | { status: 'dropped' | 'already'; intent: IntentWithMessages }
  | { status: 'not_found' }
  | { status: 'linked'; issues: string[] };

/** 写回归纳、开成单、放下的操作记录：前后两个值由存储按库里实际的填。 */
export type IntentAudit = Omit<NewAuditEntry, 'before' | 'after'>;

export interface IntentListFilter {
  status: IntentStatus | 'all';
  limit: number;
}

/** 拒收或进群留下的一行：没有原文、没有长度。 */
export interface FeishuOutsiderRow {
  chatId: string;
  openIdTail: string;
  at: string;
  reason: string;
  receivedAt: string;
}

export interface FeishuUsageMonth {
  month: string;
  calls: number;
}

export interface IntentStore {
  /** 一次进群事件里每个白名单外的人一行。返回写下的行数。 */
  recordJoins(input: { chatId: string; openIdTails: string[]; at: string; reason: string }): Promise<number>;
  /** 把这一批次数加进 at 所在的北京月。同一个 reportId 再来不加第二次。时刻认不出就抛，不当成 0。 */
  addUsage(reportId: string, calls: number, at: string): Promise<FeishuUsageMonth>;
  /** 读 at 所在北京月的累计。没有这一行是 0（读到了）。时刻认不出就抛。 */
  usageAt(at: string): Promise<FeishuUsageMonth>;
  list(filter: IntentListFilter): Promise<IntentWithMessages[]>;
  get(seq: number): Promise<IntentWithMessages | null>;
  link(input: LinkInput, audit: IntentAudit): Promise<LinkResult>;
  drop(input: DropInput, audit: IntentAudit): Promise<DropResult>;
}

/** 写回、开单、放下进操作记录时「改之前、改之后」写什么：状态、挂的单、归纳是谁几点写的（归纳正文不进，单子里有）。 */
export function auditShape(i: IntentRecord) {
  return {
    seq: i.seq,
    status: i.status,
    links: i.links.map((l) => l.issue),
    summaryBy: i.summary?.by ?? null,
    summaryAt: i.summary?.at ?? null,
    dropReason: i.dropped?.reason ?? null,
  };
}

// —— 内存版 ——

export interface MemoryIntentData {
  intents: IntentRecord[];
  messages: IntentMessageRecord[];
  joins: FeishuOutsiderRow[];
  usage: FeishuUsageMonth[];
  nextSeq: number;
}

export interface MemoryIntentStore extends IntentStore {
  data: MemoryIntentData;
  audits: NewAuditEntry[];
}

export function createMemoryIntentStore(options: { now?: () => Date } = {}): MemoryIntentStore {
  const now = options.now ?? (() => new Date());
  const data: MemoryIntentData = {
    intents: [],
    messages: [],
    joins: [],
    usage: [],
    nextSeq: 1,
  };
  /** reportId → 记进了哪个月。同一份再来直接回那个月的累计，不加第二次。 */
  const usageReports = new Map<string, string>();
  const monthOf = (at: string) => beijingMonth(Date.parse(at));
  const audits: NewAuditEntry[] = [];

  const messagesOf = (intentId: string) => data.messages.filter((m) => m.intentId === intentId);
  const withMessages = (i: IntentRecord): IntentWithMessages =>
    structuredClone({ intent: i, messages: orderMessages(messagesOf(i.id)) });
  /** 换掉一段（照判法算出的下一版）。 */
  const replace = (i: IntentRecord, next: IntentRecord) => {
    Object.assign(i, next);
  };

  return {
    data,
    audits,

    async list(filter) {
      return data.intents
        .filter((i) => filter.status === 'all' || i.status === filter.status)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, filter.limit)
        .map(withMessages);
    },

    async get(seq) {
      const i = data.intents.find((x) => x.seq === seq);
      return i ? withMessages(i) : null;
    },

    async link(input, audit) {
      const intent = data.intents.find((x) => x.seq === input.seq);
      if (!intent) return { status: 'not_found' };
      const plan = planLink(intent, messagesOf(intent.id), input, now());
      if (plan.status === 'empty' || plan.status === 'already_linked') return plan;
      audits.push({ ...audit, before: auditShape(intent), after: auditShape(plan.next) });
      replace(intent, plan.next);
      return { status: plan.status, intent: withMessages(intent) };
    },

    async drop(input, audit) {
      const intent = data.intents.find((x) => x.seq === input.seq);
      if (!intent) return { status: 'not_found' };
      const plan = planDrop(intent, input, now());
      if (plan.status === 'linked') return plan;
      if (plan.status === 'already') return { status: 'already', intent: withMessages(intent) };
      audits.push({ ...audit, before: auditShape(intent), after: auditShape(plan.next) });
      replace(intent, plan.next);
      return { status: 'dropped', intent: withMessages(intent) };
    },

    async recordJoins(input) {
      const receivedAt = now().toISOString();
      for (const openIdTail of input.openIdTails) {
        data.joins.push({
          chatId: input.chatId,
          openIdTail,
          at: input.at,
          reason: input.reason,
          receivedAt,
        });
      }
      return input.openIdTails.length;
    },

    async addUsage(reportId, calls, at) {
      const month = monthOf(at);
      const known = usageReports.get(reportId);
      if (known !== undefined) {
        return { month: known, calls: data.usage.find((u) => u.month === known)?.calls ?? 0 };
      }
      usageReports.set(reportId, month);
      const row = data.usage.find((u) => u.month === month);
      if (row) row.calls += calls;
      else data.usage.push({ month, calls });
      return { month, calls: data.usage.find((u) => u.month === month)?.calls ?? calls };
    },

    async usageAt(at) {
      const month = monthOf(at);
      return { month, calls: data.usage.find((u) => u.month === month)?.calls ?? 0 };
    },
  };
}
