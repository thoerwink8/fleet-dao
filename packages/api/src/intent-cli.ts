// fleet-api intent …（#553 第 4 条）：指挥官经 ssh 在法国上跑——读飞书意图的全部原话、开单时写回 AI 归纳和「已开成 #N」、放下。
//   intent list [--status new|linked|dropped|all] [--limit N] [--json]
//   intent show <号> [--json]
//   intent link <号> --issue <owner/仓#号> --by <谁写的归纳> --summary-file <文件|-> [--relink] [--json]
//   intent drop <号> --why <理由> [--json]
// 退出码：0 做成了（或本来就是这样）；1 没做成（没有这段、不让写、连不上库、库里的东西认不出）；2 参数不对、没带上库连接。
// 改这里之前必须知道：
// - --json 时标准输出只打一行 JSON（shared 的 IntentCli*：成功 ok=true，没做成 ok=false 带 reason 和 why），本机
//   `pnpm intents` 按它解析。读不成绝不打空列表：「没有新的意图」只在读成了、真的一条都没有时才说。
// - 原话原样打出来，一个字不改；AI 归纳只从 --summary-file 来（指挥官开单时写的），永远不进原话。
// - 写回、放下和操作记录在同一个事务里（存储那层管），记不下就不改。
import {
  INTENT_REASON_MAX,
  INTENT_SUMMARY_MAX,
  type IntentCliFailure,
  type IntentDetailSchema,
  IntentIssueRefSchema,
} from '@fleet-dao/shared';
import type { z } from 'zod';
import { wellFormed } from './feishu-records.ts';
import type { IntentAudit, IntentStore } from './intent-store.ts';
import {
  beijingRange,
  beijingStamp,
  type IntentStatus,
  type IntentWithMessages,
  intentDetail,
} from './intents.ts';

export const INTENT_USAGE =
  '用法：fleet-api intent list [--status new|linked|dropped|all] [--limit N] | show <号> | link <号> --issue <owner/仓#号> --by <谁写的归纳> --summary-file <文件|-> [--relink] | drop <号> --why <理由>（都可加 --json）';

type Reason = z.infer<typeof IntentCliFailure>['reason'];
type IntentDetail = z.infer<typeof IntentDetailSchema>;

export class IntentCliError extends Error {
  readonly exitCode: number;
  readonly reason: Reason;
  constructor(message: string, reason: Reason, exitCode = reason === 'usage' ? 2 : 1) {
    super(message);
    this.name = 'IntentCliError';
    this.reason = reason;
    this.exitCode = exitCode;
  }
}

const usage = (why: string) => new IntentCliError(`${why}。${INTENT_USAGE}`, 'usage');

export type IntentCommand =
  | { kind: 'list'; status: IntentStatus | 'all'; limit: number; json: boolean }
  | { kind: 'show'; seq: number; json: boolean }
  | {
      kind: 'link';
      seq: number;
      issue: string;
      by: string;
      summaryFile: string;
      relink: boolean;
      json: boolean;
    }
  | { kind: 'drop'; seq: number; why: string; json: boolean };

const STATUSES = new Set(['new', 'linked', 'dropped', 'all']);
const LIST_LIMIT_MAX = 500;

function seqArg(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d{0,8}$/.test(value))
    throw usage(`意图号要写成正整数（收到 ${value ?? '空'}）`);
  return Number(value);
}

/** 认不出的参数一律拒，不猜。 */
export function parseIntentArgs(argv: readonly string[]): IntentCommand {
  const json = argv.includes('--json');
  const [sub, ...rest] = argv.filter((a) => a !== '--json');
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const positional: string[] = [];
  const VALUE_FLAGS = new Set(['--status', '--limit', '--issue', '--by', '--summary-file', '--why']);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (arg === '--relink') {
      bools.add(arg);
    } else if (VALUE_FLAGS.has(arg)) {
      const value = rest[++i];
      if (value === undefined || (value.startsWith('--') && value !== '-')) throw usage(`${arg} 后面要跟值`);
      if (flags.has(arg)) throw usage(`${arg} 只能给一次`);
      flags.set(arg, value);
    } else if (arg.startsWith('--')) {
      throw usage(`认不出参数 ${arg.split('=')[0]}`);
    } else {
      positional.push(arg);
    }
  }
  const allowed = (names: readonly string[]) => {
    const extra = [...flags.keys(), ...bools].filter((f) => !names.includes(f));
    if (extra.length > 0) throw usage(`intent ${sub} 不认 ${extra.join('、')}`);
  };
  const one = () => {
    if (positional.length !== 1) throw usage(`intent ${sub} 要且只要一个意图号`);
    return seqArg(positional[0]);
  };

  switch (sub) {
    case 'list': {
      allowed(['--status', '--limit']);
      if (positional.length > 0) throw usage('intent list 不带位置参数');
      const status = flags.get('--status') ?? 'new';
      if (!STATUSES.has(status)) throw usage(`--status 只认 new、linked、dropped、all（收到 ${status}）`);
      const limitText = flags.get('--limit') ?? '50';
      const limit = Number(limitText);
      if (!/^[1-9]\d{0,3}$/.test(limitText) || limit > LIST_LIMIT_MAX) {
        throw usage(`--limit 要 1–${LIST_LIMIT_MAX}（收到 ${limitText}）`);
      }
      return { kind: 'list', status: status as IntentStatus | 'all', limit, json };
    }
    case 'show':
      allowed([]);
      return { kind: 'show', seq: one(), json };
    case 'link': {
      allowed(['--issue', '--by', '--summary-file', '--relink']);
      const seq = one();
      const issue = flags.get('--issue');
      if (issue === undefined) throw usage('intent link 要带 --issue <owner/仓#号>');
      if (!IntentIssueRefSchema.safeParse(issue).success)
        throw usage(`--issue 要写成 owner/仓#号（收到 ${issue}）`);
      const by = flags.get('--by')?.trim();
      if (!by || by.length > 200)
        throw usage('intent link 要带 --by <谁写的归纳：哪个会话、哪个模型>（1–200 字）');
      const summaryFile = flags.get('--summary-file');
      if (summaryFile === undefined) throw usage('intent link 要带 --summary-file <文件>（- 从标准输入读）');
      return { kind: 'link', seq, issue, by, summaryFile, relink: bools.has('--relink'), json };
    }
    case 'drop': {
      allowed(['--why']);
      const seq = one();
      const why = flags.get('--why')?.trim();
      if (!why || why.length > INTENT_REASON_MAX)
        throw usage(`intent drop 要带 --why <理由>（1–${INTENT_REASON_MAX} 字）`);
      return { kind: 'drop', seq, why, json };
    }
    default:
      throw usage(sub === undefined ? '少了子命令' : `认不出子命令 ${sub}`);
  }
}

export interface IntentCliDeps {
  intents: IntentStore;
  /** 读归纳文件（- 是标准输入）。 */
  readSummary(file: string): Promise<string>;
  /** 谁跑的（操作记录、挂单人）。 */
  operator: string;
}

export interface IntentCliResult {
  code: number;
  text: string;
  json: unknown;
}

const STATUS_WORD: Record<IntentStatus, string> = { new: '新', linked: '已开成单', dropped: '放下了' };

/** 给人看的一段（pnpm intents 不带 --json 时也是这个样子）。原话原样，多行的接着缩进。 */
export function describeIntent(d: IntentDetail): string {
  const live = d.messages.filter((m) => m.recalledAt === undefined);
  const names = [...new Set(live.map((m) => m.senderName))].join('、') || '没人（都撤回了）';
  const where = d.chatKind === 'p2p' ? `私聊 ${d.chatId}` : `群 ${d.chatId}`;
  const head = [
    `意图 ${d.seq}`,
    STATUS_WORD[d.status],
    where,
    `${live.length} 条原话`,
    names,
    `${beijingRange(d.firstMessageAt, d.lastMessageAt)}（北京时间）`,
    ...(d.continuesSeq === undefined ? [] : [`接着意图 ${d.continuesSeq}`]),
    ...(d.threadId === undefined ? [] : [`话题 ${d.threadId}`]),
  ].join(' · ');
  const lines = [head, '原话（原样，没改一个字）：'];
  for (const m of d.messages) {
    const tags = [
      String(m.ord),
      ...(m.recalledAt === undefined ? [] : [m.recalledAfterLink ? '开单后在飞书撤回了' : '已撤回，不抄']),
      ...(m.edits.length > 0
        ? [`改过 ${m.edits.length} 次`]
        : m.editedAt !== undefined
          ? ['飞书里改过，旧的那版这里没有']
          : []),
      ...(m.forward === undefined ? [] : [`转发，原说话人${m.forward.senderName ?? '不知道'}`]),
      beijingStamp(m.sentAt),
      m.senderName,
    ].join(' · ');
    lines.push(`  [${tags}] ${m.text.replace(/\n/g, '\n    ')}`);
  }
  if (d.summary) {
    lines.push(
      `AI 归纳（${d.summary.by} 写的，不是原话 · ${beijingStamp(d.summary.at)} · 覆盖到第 ${d.summary.covers} 条）：${d.summary.text}`,
    );
  }
  for (const l of d.links) lines.push(`开成：${l.issue}（${l.by} · ${beijingStamp(l.at)}）`);
  if (d.dropped) lines.push(`放下：${d.dropped.reason}（${d.dropped.by} · ${beijingStamp(d.dropped.at)}）`);
  const card = d.card;
  if (card.error !== undefined) {
    lines.push(`卡：连着 ${card.attempts} 次没发成（${card.error}）`);
  } else if (card.messageId === undefined) {
    lines.push(card.dueAt === undefined ? '卡：还没发' : `卡：还没发，${beijingStamp(card.dueAt)} 到点`);
  } else {
    lines.push(`卡：显示到第 ${card.shownRev ?? 0} 版（最新第 ${card.rev} 版）`);
  }
  return lines.join('\n');
}

const auditOf = (deps: IntentCliDeps, action: string, seq: number, said: string): IntentAudit => ({
  actor: { kind: 'engine', id: 'ops:intent' },
  action,
  target: `intent:${seq}`,
  reason: `服务器上 ${deps.operator} 跑的 fleet-api intent ${said}`,
  via: 'engine',
  ok: true,
});

const view = (i: IntentWithMessages) => intentDetail(i.intent, i.messages);

/** 跑一条 intent 子命令。参数不对、没做成抛 IntentCliError（调用方按 --json 打出来）；库出错原样抛。 */
export async function runIntent(cmd: IntentCommand, deps: IntentCliDeps): Promise<IntentCliResult> {
  switch (cmd.kind) {
    case 'list': {
      // 多读一段：看得出还有没列出来的，不让调用方把前 N 段当成全部
      const read = await deps.intents.list({ status: cmd.status, limit: cmd.limit + 1 });
      const more = read.length > cmd.limit;
      const found = read.slice(0, cmd.limit).map(view);
      const scope =
        cmd.status === 'new' ? '还没处理的' : cmd.status === 'all' ? '' : `「${STATUS_WORD[cmd.status]}」的`;
      return {
        code: 0,
        text:
          found.length === 0
            ? `读成了：没有${scope}意图`
            : [
                `${scope}意图 ${found.length} 段${more ? `（只列了前 ${cmd.limit} 段，还有没列的：加大 --limit 再看）` : ''}：`,
                ...found.map(describeIntent),
              ].join('\n\n'),
        json: { ok: true, intents: found, more },
      };
    }
    case 'show': {
      const got = await deps.intents.get(cmd.seq);
      if (!got) throw new IntentCliError(`没有意图 ${cmd.seq}`, 'not_found');
      const d = view(got);
      return { code: 0, text: describeIntent(d), json: { ok: true, intent: d } };
    }
    case 'link': {
      let raw: string;
      try {
        raw = await deps.readSummary(cmd.summaryFile);
      } catch (err) {
        throw new IntentCliError(
          `读不到归纳（${cmd.summaryFile === '-' ? '标准输入' : cmd.summaryFile}）：${err instanceof Error ? err.message : String(err)}`,
          'usage',
        );
      }
      const summary = wellFormed(raw).text.trim();
      if (summary.length === 0) throw new IntentCliError('归纳是空的：开单时要写一段 AI 归纳再写回', 'usage');
      if (summary.length > INTENT_SUMMARY_MAX) {
        throw new IntentCliError(`归纳 ${summary.length} 字，超过 ${INTENT_SUMMARY_MAX} 字的上限`, 'usage');
      }
      const r = await deps.intents.link(
        {
          seq: cmd.seq,
          issue: cmd.issue,
          summary: { text: summary, by: cmd.by },
          operator: deps.operator,
          relink: cmd.relink,
        },
        auditOf(
          deps,
          'intent.link',
          cmd.seq,
          `link ${cmd.seq} --issue ${cmd.issue}${cmd.relink ? ' --relink' : ''}`,
        ),
      );
      switch (r.status) {
        case 'not_found':
          throw new IntentCliError(`没有意图 ${cmd.seq}，什么都没写`, 'not_found');
        case 'empty':
          throw new IntentCliError(`意图 ${cmd.seq} 的原话在飞书里全撤回了，开不了单，什么都没写`, 'refused');
        case 'already_linked':
          throw new IntentCliError(
            `意图 ${cmd.seq} 已经开成了 ${r.issues.join('、')}，什么都没写；真要再挂 ${cmd.issue} 就加 --relink`,
            'refused',
          );
        default: {
          const d = view(r.intent);
          const said = { linked: '写回了', added: '又挂了一张', updated: '同一张单，只更新了归纳' }[r.status];
          return {
            code: 0,
            text: `${said}：意图 ${cmd.seq} → ${cmd.issue}，飞书那张卡会原地改\n${describeIntent(d)}`,
            json: { ok: true, result: r.status, intent: d },
          };
        }
      }
    }
    case 'drop': {
      const r = await deps.intents.drop(
        { seq: cmd.seq, reason: cmd.why, operator: deps.operator },
        auditOf(deps, 'intent.drop', cmd.seq, `drop ${cmd.seq}`),
      );
      switch (r.status) {
        case 'not_found':
          throw new IntentCliError(`没有意图 ${cmd.seq}，什么都没改`, 'not_found');
        case 'linked':
          throw new IntentCliError(`意图 ${cmd.seq} 已经开成了 ${r.issues.join('、')}，不能放下`, 'refused');
        default: {
          const d = view(r.intent);
          return {
            code: 0,
            text: `${r.status === 'dropped' ? '放下了' : '本来就放下了（理由没改）'}：意图 ${cmd.seq}\n${describeIntent(d)}`,
            json: { ok: true, result: r.status, intent: d },
          };
        }
      }
    }
  }
}
