// fleet-api alert …：提醒是一件活（design 15.3「谁在处理」）。帅位经 ssh 以 root 调（和 fleet-api seat、claim 一样，机器名、
// 会话号放参数里）：看开着的提醒、跟进单、PR（show，不显示谁在处理、认领——#445 起这份状态只给驾驶舱看，不再自动开跟进单、
// 不用认领）；Alertmanager 式静默（silence / unsilence / silences：谁、为什么、必带到期，不必带帅位任期——#445 删掉了这条
// 要求，带了照样核验）。判法在 @fleet-dao/core 的 alert-work.ts。
// 每条都能带 --json：只往标准输出打一行 JSON 给脚本读（本机看板、帅位脚本），认不出按「没查成」算。
// 退出码：0 做成了；3 带了任期或创始人原话核验没过（不是帅位）；1 没做成（库出错、设置认不出）；2 参数不对（不连库）。
import {
  alertHandling,
  MAIN_SEAT,
  machineProblem,
  seatScopeProblem,
  seatVerdict,
  sessionProblem,
  silenceMinutes,
  silenceProblem,
} from '@fleet-dao/core';
import type { AlertRow } from '@fleet-dao/db';
import { type AlertWorkPort, seatAuditWho } from './alert-work.ts';
import type { Store } from './ports.ts';
import { SeatCliError, type SeatCliResult } from './seat-cli.ts';

export const ALERT_USAGE = [
  '用法：fleet-api alert <show|silence|unsilence|silences> …（提醒是一件活，design 15.3「谁在处理」；都能带 --json 给脚本读）',
  '  alert show [<键|编号>]                     开着的提醒、跟进单、PR、多久了；给了键只看那一条（不显示谁在处理、认领，只给驾驶舱看）',
  '  alert silence <键|编号> | --prefix <前缀:>  --until <+2h|+3d|带时区的时刻> --note "<谁拍的、为什么>" --machine <机器名> --session <会话号> [--term <任期> | --founder "<创始人原话>"]',
  '                                             静默：到期前不再 24 小时提醒、显示「已静默」；最长 7 天，到期自动恢复；不带任期或创始人原话也能建，只记 --note 写的人',
  '  alert unsilence <静默编号> --note "<为什么提前撤>" --machine <机器名> --session <会话号> [--term <任期> | --founder "<创始人原话>"]',
  '  alert silences [--all]                     还管用的静默（--all 连撤了、到期的最近 50 条）',
].join('\n');

const FLAGS = new Set(['json', 'all', 'prefix']);
const MAX_NOTE = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Parsed {
  positional: string[];
  options: Map<string, string>;
  flags: Set<string>;
}

function parse(argv: readonly string[], allowed: readonly string[]): Parsed {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (FLAGS.has(name)) {
      if (eq >= 0) throw new SeatCliError(`--${name} 不带值。\n${ALERT_USAGE}`);
      flags.add(name);
      continue;
    }
    if (!allowed.includes(name)) throw new SeatCliError(`认不出参数 --${name}。\n${ALERT_USAGE}`);
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || (eq < 0 && value.startsWith('--')))
      throw new SeatCliError(`--${name} 后面要跟值。\n${ALERT_USAGE}`);
    if (options.has(name)) throw new SeatCliError(`--${name} 给了两次。\n${ALERT_USAGE}`);
    options.set(name, value);
  }
  return { positional, options, flags };
}

function need(p: Parsed, name: string): string {
  const v = p.options.get(name)?.trim();
  if (!v) throw new SeatCliError(`要带 --${name}。\n${ALERT_USAGE}`);
  return v;
}

function text(p: Parsed, name: string, what: string): string | undefined {
  const v = p.options.get(name)?.trim();
  if (v === undefined) return undefined;
  if (!v) throw new SeatCliError(`--${name} 要写${what}，不能是空的。\n${ALERT_USAGE}`);
  if ([...v].length > MAX_NOTE)
    throw new SeatCliError(`--${name} 太长（最多 ${MAX_NOTE} 个字）。\n${ALERT_USAGE}`);
  return v;
}

function identityOf(p: Parsed): { machine: string; session: string } {
  const machine = need(p, 'machine');
  const session = need(p, 'session');
  const why = machineProblem(machine) ?? sessionProblem(session);
  if (why) throw new SeatCliError(`${why}。\n${ALERT_USAGE}`);
  return { machine, session };
}

function positiveInt(raw: string, what: string): number {
  const digits = /^#?(\d{1,9})$/.exec(raw)?.[1];
  const n = digits === undefined ? 0 : Number(digits);
  if (n <= 0) throw new SeatCliError(`认不出${what}「${raw}」：要写成正整数。\n${ALERT_USAGE}`);
  return n;
}

function scopeOf(p: Parsed): string {
  const scope = p.options.get('scope')?.trim() || MAIN_SEAT;
  const why = seatScopeProblem(scope);
  if (why) throw new SeatCliError(`${why}。\n${ALERT_USAGE}`);
  return scope;
}

async function alertOf(alerts: AlertWorkPort, ref: string | undefined): Promise<AlertRow> {
  const r = ref?.trim();
  if (!r) throw new SeatCliError(`要给提醒的键或编号（fleet-api alert show 看得到）。\n${ALERT_USAGE}`);
  const found = await alerts.find(r);
  if (!found) throw new SeatCliError(`认不出提醒「${r}」：没有这个键或编号（fleet-api alert show 看开着的）`);
  return found;
}

// 单条（alertOf 来的 AlertRow）createdAt 是 Date；列表（alerts.read 的 facts.alert，@fleet-dao/core 的 AlertRef）
// 已经是 ISO 字符串——两处共用一个函数，两种都收。
function alertJson(a: {
  id: string;
  dedupeKey: string;
  level: AlertRow['level'];
  title: string;
  createdAt: Date | string;
}) {
  const createdAt = typeof a.createdAt === 'string' ? a.createdAt : a.createdAt.toISOString();
  return { id: a.id, key: a.dedupeKey, level: a.level, title: a.title, createdAt };
}

const LEVEL_TEXT = { decision: '要你拍', alert: '卡住报警', daily: '日报' } as const;

export interface AlertCliDeps {
  store: Store;
  alerts: AlertWorkPort;
}

export async function runAlert(argv: readonly string[], deps: AlertCliDeps): Promise<SeatCliResult> {
  const [sub = '', ...rest] = argv;
  if (sub === 'show') return show(parse(rest, []), deps);
  if (sub === 'silence')
    return silence(parse(rest, ['until', 'note', 'machine', 'session', 'scope', 'term', 'founder']), deps);
  if (sub === 'unsilence')
    return unsilence(parse(rest, ['note', 'machine', 'session', 'scope', 'term', 'founder']), deps);
  if (sub === 'silences') return silences(parse(rest, []), deps);
  throw new SeatCliError(sub ? `没有 alert ${sub} 这条命令。\n${ALERT_USAGE}` : ALERT_USAGE);
}

// —— show ——

async function show(p: Parsed, { store, alerts }: AlertCliDeps): Promise<SeatCliResult> {
  if (p.positional.length > 1) throw new SeatCliError(`alert show 最多给一条提醒的键。\n${ALERT_USAGE}`);
  if (p.positional.length === 1) {
    const a = await alertOf(alerts, p.positional[0]);
    const r = await alerts.read([a.id]);
    const f = r.facts[0];
    if (!f) throw new Error(`提醒 ${a.id} 刚找到、再读就没了`);
    // 谁在处理、认领只给驾驶舱看（#445）：这里只借 alertHandling 读静默、没查成，不显示 h.line/h.who。
    const h = alertHandling(f, await alerts.deploy(), r.now);
    const lines = [
      `[${LEVEL_TEXT[a.level]}] ${a.title}`,
      `键：${a.dedupeKey}（编号 ${a.id}），${a.createdAt.toISOString()} 报的${a.resolvedAt ? `，${a.resolvedAt.toISOString()} 由 ${a.resolvedBy ?? '?'} 撤了` : ''}`,
      `跟进单：${f.work ? `${f.work.repo}#${f.work.issueNumber}` : '没有'}`,
      `PR：${f.prs.length ? f.prs.map((x) => `#${x.number} ${x.state}（${x.via.join('、')}）`).join('；') : '没有'}`,
      ...(h.silence ? [`静默：${h.silence.createdBy}：${h.silence.comment}，到 ${h.silence.endsAt}`] : []),
      ...h.problems.map((x) => `没查成：${x}`),
    ];
    return {
      code: 0,
      text: lines.join('\n'),
      json: { alert: alertJson(a), now: r.now },
    };
  }
  const open = await store.listNotifications({ status: 'open', limit: SHOW_LIMIT });
  // 列表这一页不显示谁在处理（#445），但照旧经 alerts.read 走一遍：读不到库要照实报「没做成」，不能拿
  // 「没有开着的提醒」冒充查过了（AGENTS.md 底线）。
  const read = await alerts.read(open.items.map((n) => n.id));
  const rows = read.facts.map((f) => f.alert);
  const truncated = open.nextCursor !== undefined;
  const lines =
    rows.length === 0
      ? ['没有开着的提醒']
      : rows.map((a) => `[${LEVEL_TEXT[a.level]}] ${a.title}（${a.dedupeKey}）`);
  if (truncated) lines.push(`（开着的超过 ${SHOW_LIMIT} 条，只列了最近的 ${SHOW_LIMIT} 条）`);
  return {
    code: 0,
    text: lines.join('\n'),
    json: {
      alerts: rows.map((a) => alertJson(a)),
      truncated,
      now: read.now,
    },
  };
}

/** alert show 一次最多列多少条开着的提醒（最近的在前）。 */
const SHOW_LIMIT = 200;

// —— 静默 ——

/**
 * 静默、撤静默不必带帅位任期（#445：只要 --note 写明谁拍的、为什么就行，不再逼着走 seat check 那一套）：带了创始人原话
 * 或任期的，照旧核一遍（认不出、不是帅位一律拒），没带的只记 --machine/--session 是谁、basis 写明没核过身份。
 * 回操作记录里写的「谁」和一句说明。
 */
async function silenceActor(
  p: Parsed,
  store: Store,
): Promise<{ machine: string; session: string; basis: string }> {
  const who = identityOf(p);
  const founder = text(p, 'founder', '创始人的原话');
  if (founder) return { ...who, basis: `创始人原话：${founder}` };
  if (!p.options.has('term')) return { ...who, basis: '没带帅位任期，按 --note 记的人处理' };
  const scope = scopeOf(p);
  const snap = await store.readSeat(scope);
  const term = positiveInt(need(p, 'term'), '任期');
  if (!snap.settings.ok) throw new SeatCliError(`没查成：${snap.settings.why}`, 1);
  const v = seatVerdict(snap.lease, { ...who, term }, snap.now, snap.settings.settings.leaseMinutes);
  if (!v.ok) throw new SeatCliError(`不是帅位：${v.why}`, 3);
  return { ...who, basis: `帅位 ${scope} 第 ${term} 任` };
}

async function silence(p: Parsed, { store, alerts }: AlertCliDeps): Promise<SeatCliResult> {
  if (p.positional.length !== 1)
    throw new SeatCliError(`要一个位置参数：提醒的键或编号（--prefix 时是前缀）。\n${ALERT_USAGE}`);
  const until = need(p, 'until');
  const note = text(p, 'note', '为什么（谁拍的、为什么不用处理）');
  if (!note) throw new SeatCliError(`静默要带 --note：谁拍的、为什么不用处理。\n${ALERT_USAGE}`);
  const prefix = p.flags.has('prefix');
  const raw = (p.positional[0] ?? '').trim();
  const minutes = silenceMinutes(until, await alerts.now());
  if (typeof minutes === 'string') throw new SeatCliError(`${minutes}。\n${ALERT_USAGE}`);
  const match = prefix ? raw : (await alertOf(alerts, raw)).dedupeKey;
  const why = silenceProblem({ matchKind: prefix ? 'prefix' : 'key', match, comment: note, minutes });
  if (why) throw new SeatCliError(`${why}。\n${ALERT_USAGE}`);
  const actor = await silenceActor(p, store);
  const s = await alerts.createSilence({
    matchKind: prefix ? 'prefix' : 'key',
    match,
    comment: note,
    createdBy: `${actor.machine}/${actor.session}`,
    minutes,
    audit: seatAuditWho(actor.machine, actor.session),
  });
  return {
    code: 0,
    text: `静默了：${prefix ? `键以 ${match} 开头的提醒` : match}，到 ${s.endsAt}（${actor.basis}；${note}）。到期前不再 24 小时提醒，到期自动恢复；提前撤：fleet-api alert unsilence ${s.id} --note "…"`,
    json: { ok: true, silence: s, basis: actor.basis },
  };
}

async function unsilence(p: Parsed, { store, alerts }: AlertCliDeps): Promise<SeatCliResult> {
  if (p.positional.length !== 1) throw new SeatCliError(`要一个位置参数：静默编号。\n${ALERT_USAGE}`);
  const id = (p.positional[0] ?? '').trim().toLowerCase();
  if (!UUID.test(id))
    throw new SeatCliError(`认不出静默编号「${id}」（fleet-api alert silences 看得到）。\n${ALERT_USAGE}`);
  const note = text(p, 'note', '为什么提前撤');
  if (!note) throw new SeatCliError(`撤静默要带 --note：为什么提前撤。\n${ALERT_USAGE}`);
  const actor = await silenceActor(p, store);
  const r = await alerts.expireSilence({
    id,
    by: `${actor.machine}/${actor.session}`,
    note,
    audit: seatAuditWho(actor.machine, actor.session),
  });
  if (r.result === 'not_found') throw new SeatCliError(`没有静默 ${id}`);
  if (r.result === 'ended')
    return {
      code: 0,
      text: `静默 ${id} 本来就不管用了（${r.silence.expiredAt ? `${r.silence.expiredBy} 已经撤了` : `${r.silence.endsAt} 到期了`}），没动`,
      json: { ok: true, already: true, silence: r.silence },
    };
  return {
    code: 0,
    text: `撤了静默：${r.silence.match}（${note}）；对得上的提醒照常显示、按 24 小时再提醒`,
    json: { ok: true, silence: r.silence },
  };
}

async function silences(p: Parsed, { alerts }: AlertCliDeps): Promise<SeatCliResult> {
  if (p.positional.length > 0) throw new SeatCliError(`alert silences 不收位置参数。\n${ALERT_USAGE}`);
  const r = await alerts.listSilences({ all: p.flags.has('all') });
  const lines = r.silences.map(
    (s) =>
      `${s.id} ${s.matchKind === 'prefix' ? `前缀 ${s.match}` : s.match}：${s.comment}（${s.createdBy} 建，到 ${s.endsAt}${s.expiredAt ? `；${s.expiredBy} 提前撤了` : ''}）`,
  );
  return {
    code: 0,
    text: lines.length ? lines.join('\n') : p.flags.has('all') ? '没有静默' : '没有还管用的静默',
    json: { silences: r.silences, now: r.now },
  };
}
