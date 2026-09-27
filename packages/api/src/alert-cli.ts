// fleet-api alert …：提醒是一件活（design 15.3「谁在处理」）。帅位经 ssh 以 root 调（和 fleet-api seat、claim 一样，机器名、
// 会话号放参数里）：看开着的提醒谁在处理、修到哪（show）；认领一条提醒（claim：认领它的跟进单，就是 #299 的认领，不另记）；
// Alertmanager 式静默（silence / unsilence / silences：谁、为什么、必带到期）。判法在 @fleet-dao/core 的 alert-work.ts。
// 每条都能带 --json：只往标准输出打一行 JSON 给脚本读（本机看板、帅位脚本），认不出按「没查成」算。
// 退出码和 seat、claim 一样：0 做成了；3 不是你的（不是帅位、跟进单在别人手里、提醒已经撤了）；1 没做成（库出错、设置认不出、
// 跟进单的仓不受管）；2 参数不对（不连库）。
import {
  alertHandling,
  claimHowTo,
  claimOwnerText,
  describeClaim,
  holderText,
  type IssueClaim,
  isActiveClaim,
  MAIN_SEAT,
  machineProblem,
  seatScopeProblem,
  seatVerdict,
  sessionProblem,
  silenceMinutes,
  silenceProblem,
} from '@fleet-dao/core';
import type { AlertRow } from '@fleet-dao/db';
import { type AlertWorkPort, handlingView, seatAuditWho } from './alert-work.ts';
import type { SeatActor, Store } from './ports.ts';
import { SeatCliError, type SeatCliResult } from './seat-cli.ts';

export const ALERT_USAGE = [
  '用法：fleet-api alert <show|claim|silence|unsilence|silences> …（提醒是一件活，design 15.3「谁在处理」；都能带 --json 给脚本读）',
  '  alert show [<键|编号>]                     开着的提醒谁在处理、修到哪、多久了；给了键只看那一条（带跟进单、认领、PR、发布）',
  '  alert claim <键|编号> --machine <机器名> --session <会话号> --term <任期> --label <工人名> [--owner worker|seat] [--issue <号>|<owner/仓#号>] [--grace-minutes <分>] [--note "<一句话>"] [--scope drill:<名字>]',
  '                                             认领这条提醒的跟进单（有任务的就是那张单，--issue 另挂一张）；修复的 PR 正文「修提醒」栏写它的键',
  '  alert silence <键|编号> | --prefix <前缀:>  --until <+2h|+3d|带时区的时刻> --note "<谁拍的、为什么>" --machine <机器名> --session <会话号> (--term <任期> | --founder "<创始人原话>")',
  '                                             静默：到期前不升级、不开跟进单，显示「已静默」；最长 7 天，到期自动恢复',
  '  alert unsilence <静默编号> --note "<为什么提前撤>" --machine <机器名> --session <会话号> (--term <任期> | --founder "<创始人原话>")',
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

function actorOf(p: Parsed): SeatActor {
  return { ...identityOf(p), scope: scopeOf(p), term: positiveInt(need(p, 'term'), '任期') };
}

/** --issue：<号>（跟进单的仓照提醒原来挂的）或 <owner/仓#号>。 */
function issueArg(raw: string, fallbackRepo: string | null): { repo: string; issueNumber: number } {
  const full = /^([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)#(\d{1,9})$/.exec(raw.trim());
  if (full?.[1] && full[2]) return { repo: full[1], issueNumber: positiveInt(full[2], '单号') };
  const n = positiveInt(raw.trim(), '跟进单');
  if (!fallbackRepo)
    throw new SeatCliError(
      `这条提醒没挂过单，--issue 要写成 <owner/仓#号>（不知道是哪个仓的 #${n}）。\n${ALERT_USAGE}`,
    );
  return { repo: fallbackRepo, issueNumber: n };
}

async function alertOf(alerts: AlertWorkPort, ref: string | undefined): Promise<AlertRow> {
  const r = ref?.trim();
  if (!r) throw new SeatCliError(`要给提醒的键或编号（fleet-api alert show 看得到）。\n${ALERT_USAGE}`);
  const found = await alerts.find(r);
  if (!found) throw new SeatCliError(`认不出提醒「${r}」：没有这个键或编号（fleet-api alert show 看开着的）`);
  return found;
}

function claimJson(c: IssueClaim) {
  return {
    claimId: c.claimId,
    owner: { kind: c.ownerKind, machine: c.ownerMachine, label: c.ownerLabel },
    state: c.state,
    active: isActiveClaim(c.state),
    prs: c.prNumbers,
    claimedAt: c.claimedAt,
    heartbeatAt: c.heartbeatAt,
    note: c.note,
  };
}

function alertJson(a: Pick<AlertRow, 'id' | 'dedupeKey' | 'level' | 'title' | 'createdAt'>) {
  return { id: a.id, key: a.dedupeKey, level: a.level, title: a.title, createdAt: a.createdAt.toISOString() };
}

const LEVEL_TEXT = { decision: '要你拍', alert: '卡住报警', daily: '日报' } as const;

export interface AlertCliDeps {
  store: Store;
  alerts: AlertWorkPort;
}

export async function runAlert(argv: readonly string[], deps: AlertCliDeps): Promise<SeatCliResult> {
  const [sub = '', ...rest] = argv;
  if (sub === 'show') return show(parse(rest, []), deps);
  if (sub === 'claim')
    return claim(
      parse(rest, [
        'machine',
        'session',
        'scope',
        'term',
        'label',
        'owner',
        'grace-minutes',
        'note',
        'issue',
      ]),
      deps,
    );
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
    const h = alertHandling(f, await alerts.deploy(), r.now);
    const lines = [
      `[${LEVEL_TEXT[a.level]}] ${a.title}`,
      `键：${a.dedupeKey}（编号 ${a.id}），${a.createdAt.toISOString()} 报的${a.resolvedAt ? `，${a.resolvedAt.toISOString()} 由 ${a.resolvedBy ?? '?'} 撤了` : ''}`,
      `处理：${h.line}`,
      `跟进单：${f.work ? `${f.work.repo}#${f.work.issueNumber}（${f.work.source === 'task' ? '提醒挂的任务' : f.work.source === 'engine' ? '提醒派单开的' : `${f.work.linkedBy ?? '?'} 挂的`}）` : '没有'}`,
      `认领：${f.claim ? describeClaim(f.claim, r.now) : '没有'}`,
      `PR：${f.prs.length ? f.prs.map((x) => `#${x.number} ${x.state}（${x.via.join('、')}）`).join('；') : '没有'}`,
      ...(h.silence ? [`静默：${h.silence.createdBy}：${h.silence.comment}，到 ${h.silence.endsAt}`] : []),
      ...h.problems.map((x) => `没查成：${x}`),
      ...(h.stage === 'unclaimed' || h.stage === 'engine_stuck' ? [claimHowTo(a.dedupeKey)] : []),
    ];
    return {
      code: 0,
      text: lines.join('\n'),
      json: {
        alert: alertJson(a),
        handling: handlingView(h),
        claim: f.claim && claimJson(f.claim),
        now: r.now,
      },
    };
  }
  const open = await store.listNotifications({ status: 'open', limit: SHOW_LIMIT });
  const read = await alerts.read(open.items.map((n) => n.id));
  const deploy = await alerts.deploy();
  const rows = read.facts.map((f) => ({ a: f.alert, h: alertHandling(f, deploy, read.now) }));
  const truncated = open.nextCursor !== undefined;
  const lines =
    rows.length === 0
      ? ['没有开着的提醒']
      : rows.flatMap(({ a, h }) => [
          `[${LEVEL_TEXT[a.level]}] ${a.title}（${a.dedupeKey}）`,
          `    ${h.line}`,
        ]);
  if (truncated) lines.push(`（开着的超过 ${SHOW_LIMIT} 条，只列了最近的 ${SHOW_LIMIT} 条）`);
  return {
    code: 0,
    text: lines.join('\n'),
    json: {
      alerts: rows.map(({ a, h }) => ({
        id: a.id,
        key: a.dedupeKey,
        level: a.level,
        title: a.title,
        createdAt: a.createdAt,
        handling: handlingView(h),
      })),
      truncated,
      now: read.now,
    },
  };
}

/** alert show 一次最多列多少条开着的提醒（最近的在前）。 */
const SHOW_LIMIT = 200;

// —— claim ——

async function claim(p: Parsed, { store, alerts }: AlertCliDeps): Promise<SeatCliResult> {
  if (p.positional.length !== 1) throw new SeatCliError(`要一个位置参数：提醒的键或编号。\n${ALERT_USAGE}`);
  const seat = actorOf(p);
  const label = need(p, 'label');
  const labelWhy = sessionProblem(label, '工人名');
  if (labelWhy) throw new SeatCliError(`${labelWhy}。\n${ALERT_USAGE}`);
  const kind = p.options.get('owner') ?? 'worker';
  if (kind !== 'worker' && kind !== 'seat')
    throw new SeatCliError(`--owner 只收 worker、seat，没有「${kind}」。\n${ALERT_USAGE}`);
  const graceRaw = p.options.get('grace-minutes');
  const graceMinutes = graceRaw === undefined ? undefined : positiveInt(graceRaw, '宽限期（分钟）');
  const note = text(p, 'note', '一句话');
  const issueRaw = p.options.get('issue');

  const a = await alertOf(alerts, p.positional[0]);
  const alertText = `提醒「${a.title}」（${a.dedupeKey}）`;
  if (a.resolvedAt)
    return {
      code: 3,
      text: `不用认领：${alertText}已经撤了（${a.resolvedBy ?? '没记是谁'}，${a.resolvedAt.toISOString()}）`,
      json: { ok: false, reason: 'resolved', alert: alertJson(a) },
    };
  const r = await alerts.read([a.id]);
  const facts = r.facts[0];
  if (!facts) throw new Error(`提醒 ${a.id} 刚找到、再读就没了`);
  const current = facts.work;
  const target = issueRaw === undefined ? current : issueArg(issueRaw, current?.repo ?? null);
  if (!target)
    throw new SeatCliError(
      `${alertText}还没挂单：先开一张跟进单（pnpm issue:new --local …，正文写清要修的；PR 正文「修提醒」栏写 ${a.dedupeKey}），再带 --issue <owner/仓#号> 认领；或者等提醒派单（没人认领 20 分钟后）自己开一张`,
    );
  const [owner = '', name = ''] = target.repo.split('/');
  const repo = await store.findRepoByName(owner, name);
  if (!repo)
    return {
      code: 1,
      text: `没认领上：${target.repo} 不在库里（认领只管驾驶舱导入过的项目）`,
      json: { ok: false, reason: 'repo_not_managed', repo: target.repo },
    };
  const issueText = `${target.repo}#${target.issueNumber}`;
  const took = await store.takeClaim({
    repoId: repo.id,
    issueNumber: target.issueNumber,
    seat,
    owner: { kind, label },
    graceMinutes,
    note: note ?? `修${alertText}`,
  });
  let held: IssueClaim | null = null;
  if (!took.ok) {
    if (took.reason === 'held') {
      const mine =
        took.claim.ownerKind !== 'engine' &&
        took.claim.ownerMachine === seat.machine &&
        took.claim.ownerLabel === label;
      if (!mine) {
        const engine = took.claim.ownerKind === 'engine';
        return {
          code: 3,
          text: engine
            ? `没认领上：跟进单 ${issueText} 在引擎手里（它自己卡住了才报的这条）。本机接手要创始人说改派；或者另开一张单跟进，带 --issue <owner/仓#号> 再认领`
            : `没认领上：跟进单 ${issueText} ${describeClaim(took.claim, took.now)}；不碰它`,
          json: { ok: false, reason: 'held', claim: claimJson(took.claim), now: took.now },
        };
      }
      held = took.claim;
    } else {
      return {
        code: took.reason === 'not_seat' ? 3 : 1,
        text: `没认领上（${issueText} 没动）：${took.why}`,
        json: { ok: false, reason: took.reason, why: took.why, now: took.now },
      };
    }
  }
  const claimRow = took.ok ? took.claim : (held as IssueClaim);
  // 跟进单换了（--issue 给了另一张，或者原来没挂）才挂：认领在前、挂在后，认领没成的不留半截
  const differs =
    !current ||
    current.repoId !== repo.id ||
    current.issueNumber !== target.issueNumber ||
    current.source === 'task';
  let linked: 'linked' | 'same' | 'none' = issueRaw !== undefined && !differs ? 'same' : 'none';
  if (issueRaw !== undefined && differs) {
    try {
      const got = await alerts.link({
        notificationId: a.id,
        repoId: repo.id,
        issueNumber: target.issueNumber,
        source: 'claim',
        linkedBy: `${seat.machine}/${seat.session}`,
        note: note ?? (current ? `原来挂的是 ${current.repo}#${current.issueNumber}` : null),
        mode: 'replace',
        audit: seatAuditWho(seat.machine, seat.session),
      });
      if (got.result === 'not_found') throw new Error('提醒刚找到、挂单时不在了');
      linked = got.result === 'same' ? 'same' : 'linked';
    } catch (err) {
      return {
        code: 1,
        text: `认领上了 ${issueText}（认领号 ${claimRow.claimId}），可跟进单没挂到${alertText}上：${err instanceof Error ? err.message : String(err)}。再跑一次同一条命令会接着挂（认领那步认得出是你拿着）`,
        json: { ok: false, reason: 'link_failed', claim: claimJson(claimRow) },
      };
    }
  }
  return {
    code: 0,
    text: `${held ? '本来就是你拿着' : '认领了'}${alertText}：跟进单 ${issueText} 归 ${claimOwnerText(claimRow)}，认领号 ${claimRow.claimId}${linked === 'linked' ? '（跟进单挂上了）' : ''}。修复的 PR 正文「修提醒」栏写 ${a.dedupeKey}，「认领」栏写认领号`,
    json: {
      ok: true,
      alert: alertJson(a),
      work: { repo: target.repo, issueNumber: target.issueNumber },
      claim: claimJson(claimRow),
      linked,
      already: held !== null,
      now: took.now,
    },
  };
}

// —— 静默 ——

/**
 * 静默、撤静默要么是帅位（带任期，库里核），要么带创始人原话（运维以 root 手敲）；帅位还没人接过时（上线过渡）只记是谁。
 * 回操作记录里写的「谁」和一句说明。
 */
async function silenceActor(
  p: Parsed,
  store: Store,
): Promise<{ machine: string; session: string; basis: string }> {
  const who = identityOf(p);
  const founder = text(p, 'founder', '创始人的原话');
  if (founder) return { ...who, basis: `创始人原话：${founder}` };
  const scope = scopeOf(p);
  const snap = await store.readSeat(scope);
  if (!p.options.has('term')) {
    if (snap.lease)
      throw new SeatCliError(
        `帅位已经上线（现在是 ${holderText(snap.lease)}，第 ${snap.lease.term} 任）：静默要带任期（--term），运维手敲的带创始人原话（--founder "…"）`,
        3,
      );
    return { ...who, basis: '帅位还没人接过（上线过渡）' };
  }
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
    text: `静默了：${prefix ? `键以 ${match} 开头的提醒` : match}，到 ${s.endsAt}（${actor.basis}；${note}）。到期前不升级、不开跟进单，到期自动恢复；提前撤：fleet-api alert unsilence ${s.id} --note "…"`,
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
    text: `撤了静默：${r.silence.match}（${note}）；对得上的提醒照常升级`,
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
