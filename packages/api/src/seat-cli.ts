// fleet-api seat …、fleet-api claim …：帅位只一个（#299，specs/299-帅位只一个/方案.md 第三节）。本机的帅位、工人经 ssh 以
// root 调（ssh <法国> 'bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api seat …'），机器名、会话号放参数里：
// 经 ssh 进来的一律是 root，看不出是谁。判法在 @fleet-dao/core 的 seat.ts，读写在 Store（seat-store.ts）。
// 每条都能带 --json：只往标准输出打一行 JSON，给本机的脚本认（认不出按「不是帅位、没查成」算）；不带就打给人看的话。
// 退出码：0 做成了、是帅位；3 不是你的（不是帅位、过了租期、别人拿着、认领号对不上）；1 没做成（库出错、设置认不出）；
// 2 参数不对。
import {
  claimOwnerText,
  claimStateText,
  describeClaim,
  holderText,
  type IssueClaim,
  isActiveClaim,
  isDrillScope,
  MAIN_SEAT,
  machineProblem,
  type SeatLease,
  type SeatSettingsRead,
  seatExpiresAt,
  seatScopeProblem,
  seatVerdict,
  sessionProblem,
} from '@fleet-dao/core';
import { type Repo, requirementWorkflowId, type Task } from '@fleet-dao/shared';
import type { AskRecord, SeatActor, Store } from './ports.ts';

export const SEAT_USAGE = [
  '用法：fleet-api seat <take|renew|check|show|handoff> …（帅位只一个，#299；都能带 --scope drill:<名字> 用演练座位、带 --json 给脚本读）',
  '  seat take --machine <机器名> --session <会话号>                  接班（后说的算，任期号加一）',
  '  seat renew --machine <机器名> --session <会话号> --term <任期>   续约（每 15 分钟一次）',
  '  seat check --machine <机器名> --session <会话号> --term <任期>   现查：受保护动作前查一次还是不是帅位',
  '  seat show                                                         看现状：帅位、在做的认领、引擎在跑的单、没答的提问',
  '  seat handoff --machine <机器名> --session <会话号> --term <任期> 存交接说明（从标准输入读）',
].join('\n');

export const CLAIM_USAGE = [
  '用法：fleet-api claim <take|step|done|release|show|sweep> …（每张单一个认领，#299；都能带 --json 给脚本读）',
  '  claim take <owner/仓名> <单号> --machine <机器名> --session <会话号> --term <任期> --label <工人名> [--owner worker|seat] [--grace-minutes <分>] [--note "<一句话>"] [--scope drill:<名字>]',
  '                                         帅位认领一张单（派给工人或自己做；帅位自己占着的也换给工人）',
  '  claim take <owner/仓名> <单号> --owner engine --scope drill:<名字>   演练：引擎那一边抢（只在演练座位下，不起工作流）',
  '  claim step <owner/仓名> <单号> --claim <认领号> [--note "<一句话>"] [--pr <PR 号>]   工人报一步（心跳）、登记 PR',
  '  claim done <owner/仓名> <单号> --claim <认领号> --note "<一句话>"                    做完了',
  '  claim release <owner/仓名> <单号> --claim <认领号> --note "<一句话>"                 放下（不做了、交出去）',
  '  claim show <owner/仓名> [<单号>…] [--all]   看认领（默认只列还活着的）',
  '  claim sweep                                 作废过了宽限期没心跳的本机认领（引擎定时跑；演练时手动跑）',
].join('\n');

export class SeatCliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'SeatCliError';
    this.exitCode = exitCode;
  }
}

/** 一条命令跑完：退出码、给人看的话、给脚本读的 JSON。 */
export interface SeatCliResult {
  code: number;
  text: string;
  json: Record<string, unknown>;
}

const REPO_ARG = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_NOTE = 500;
const MAX_HANDOFF = 20_000;

interface Parsed {
  positional: string[];
  options: Map<string, string>;
  flags: Set<string>;
}

const FLAG_NAMES = new Set(['json', 'all']);

function parse(argv: readonly string[], allowed: readonly string[], usage: string): Parsed {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      if (arg.startsWith('-') && arg !== '-') throw new SeatCliError(`认不出参数 ${arg}。\n${usage}`);
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (!allowed.includes(name) && !FLAG_NAMES.has(name))
      throw new SeatCliError(`认不出参数 --${name}。\n${usage}`);
    if (FLAG_NAMES.has(name)) {
      if (eq >= 0) throw new SeatCliError(`--${name} 不带值。\n${usage}`);
      flags.add(name);
      continue;
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || (eq < 0 && value.startsWith('--')))
      throw new SeatCliError(`--${name} 后面要跟值。\n${usage}`);
    if (options.has(name)) throw new SeatCliError(`--${name} 给了两次。\n${usage}`);
    options.set(name, value);
  }
  return { positional, options, flags };
}

function need(p: Parsed, name: string, usage: string): string {
  const v = p.options.get(name)?.trim();
  if (!v) throw new SeatCliError(`要带 --${name}。\n${usage}`);
  return v;
}

function scopeOf(p: Parsed, usage: string): string {
  const scope = p.options.get('scope')?.trim() || MAIN_SEAT;
  const why = seatScopeProblem(scope);
  if (why) throw new SeatCliError(`${why}。\n${usage}`);
  return scope;
}

function identityOf(p: Parsed, usage: string): { machine: string; session: string } {
  const machine = need(p, 'machine', usage);
  const session = need(p, 'session', usage);
  const why = machineProblem(machine) ?? sessionProblem(session);
  if (why) throw new SeatCliError(`${why}。\n${usage}`);
  return { machine, session };
}

function positiveInt(raw: string, what: string, usage: string): number {
  const digits = /^#?(\d{1,9})$/.exec(raw)?.[1];
  const n = digits === undefined ? 0 : Number(digits);
  if (n <= 0) throw new SeatCliError(`认不出${what}「${raw}」：要写成正整数。\n${usage}`);
  return n;
}

function actorOf(p: Parsed, usage: string): SeatActor {
  return {
    ...identityOf(p, usage),
    scope: scopeOf(p, usage),
    term: positiveInt(need(p, 'term', usage), '任期', usage),
  };
}

function noteOf(p: Parsed, required: boolean, usage: string): string | undefined {
  const note = p.options.get('note')?.trim();
  if (!note) {
    if (required) throw new SeatCliError(`要带 --note：一句话写做到哪了、为什么。\n${usage}`);
    return undefined;
  }
  if ([...note].length > MAX_NOTE) throw new SeatCliError(`--note 太长（最多 ${MAX_NOTE} 个字）。\n${usage}`);
  return note;
}

function repoArg(raw: string | undefined, usage: string): { owner: string; name: string } {
  const m = REPO_ARG.exec(raw ?? '');
  if (!m?.[1] || !m[2]) throw new SeatCliError(`认不出仓「${raw ?? ''}」：要写成 owner/仓名。\n${usage}`);
  return { owner: m[1], name: m[2] };
}

async function repoOf(store: Store, repo: { owner: string; name: string }): Promise<Repo> {
  const found = await store.findRepoByName(repo.owner, repo.name);
  if (!found)
    throw new SeatCliError(
      `库里没有仓 ${repo.owner}/${repo.name}：认领只管驾驶舱导入过的项目（repos 表），别的项目照旧只靠单上的「在做」评论`,
      1,
    );
  return found;
}

// —— 给人看、给脚本读 ——

function leaseJson(lease: SeatLease | null) {
  return lease === null
    ? null
    : {
        scope: lease.scope,
        term: lease.term,
        holder: { machine: lease.holderMachine, session: lease.holderSession },
        previous:
          lease.previousMachine === null
            ? null
            : { machine: lease.previousMachine, session: lease.previousSession },
        acquiredAt: lease.acquiredAt,
        renewedAt: lease.renewedAt,
        handoff: lease.handoff,
        handoffAt: lease.handoffAt,
      };
}

function claimJson(c: IssueClaim, repos: ReadonlyMap<string, string>) {
  return {
    repo: repos.get(c.repoId) ?? c.repoId,
    issue: c.issueNumber,
    claimId: c.claimId,
    owner: { kind: c.ownerKind, machine: c.ownerMachine, label: c.ownerLabel },
    seat: c.seatScope === null ? null : { scope: c.seatScope, term: c.seatTerm },
    state: c.state,
    active: isActiveClaim(c.state),
    prs: c.prNumbers,
    graceMinutes: c.graceMinutes,
    claimedAt: c.claimedAt,
    heartbeatAt: c.heartbeatAt,
    endedAt: c.endedAt,
    endReason: c.endReason,
    note: c.note,
  };
}

const settingsText = (s: SeatSettingsRead) =>
  s.ok
    ? `租期 ${s.settings.leaseMinutes} 分钟、认领宽限期 ${s.settings.claimGraceMinutes} 分钟${s.source === 'default' ? '（没设过，用的默认）' : ''}`
    : `设置认不出：${s.why}`;

async function repoNames(store: Store): Promise<Map<string, string>> {
  return new Map((await store.listRepos()).map((r) => [r.id, `${r.owner}/${r.name}`]));
}

// —— seat ——

export async function runSeat(
  argv: readonly string[],
  deps: { store: Store; readStdin: () => Promise<string> },
): Promise<SeatCliResult> {
  const [sub = '', ...rest] = argv;
  const usage = SEAT_USAGE;
  const { store } = deps;
  if (sub === 'take') {
    const p = parse(rest, ['machine', 'session', 'scope'], usage);
    if (p.positional.length > 0) throw new SeatCliError(`seat take 不收位置参数。\n${usage}`);
    const me = identityOf(p, usage);
    const scope = scopeOf(p, usage);
    // 租期认不出就不接班（什么都不改）：接了班本机也不知道多久没续约算过期，帅位记录就一直算数
    const before = await store.readSeat(scope);
    if (!before.settings.ok)
      return {
        code: 1,
        text: `没接班（座位没动）：${before.settings.why}。先把设置改对`,
        json: { ok: false, reason: 'settings', why: before.settings.why, now: before.now },
      };
    const { lease, now } = await store.takeSeat({ scope, ...me });
    const snap = await store.readSeat(scope);
    const lm = snap.settings.ok ? snap.settings.settings.leaseMinutes : undefined;
    const prev =
      lease.previousMachine === null
        ? '座位原来没人'
        : `上一任是 ${lease.previousMachine}/${lease.previousSession}（第 ${lease.term - 1} 任），它下一次动手前现查就会退役`;
    return {
      code: 0,
      text: `接班了：${scope} 第 ${lease.term} 任是 ${holderText(lease)}；${prev}。${settingsText(snap.settings)}，每 15 分钟续一次约`,
      json: {
        ok: true,
        seat: leaseJson(lease),
        leaseMinutes: lm ?? null,
        expiresAt: lm === undefined ? null : seatExpiresAt(lease, lm),
        now,
      },
    };
  }
  if (sub === 'renew' || sub === 'check') {
    const p = parse(rest, ['machine', 'session', 'scope', 'term'], usage);
    if (p.positional.length > 0) throw new SeatCliError(`seat ${sub} 不收位置参数。\n${usage}`);
    const me = actorOf(p, usage);
    if (sub === 'renew') {
      const r = await store.renewSeat(me);
      if (!r.ok) {
        const who = r.lease ? `帅位已经是 ${holderText(r.lease)}（第 ${r.lease.term} 任）` : '座位上没人';
        return {
          code: 3,
          text: `没续上：${who}，不是 ${me.machine}/${me.session}（第 ${me.term} 任）。你已经不是帅位：停派新活，只回「我已退役，帅位在 ${r.lease ? holderText(r.lease) : '（没人）'}」`,
          json: { ok: false, reason: r.lease ? 'replaced' : 'vacant', seat: leaseJson(r.lease), now: r.now },
        };
      }
      const snap = await store.readSeat(me.scope);
      const lm = snap.settings.ok ? snap.settings.settings.leaseMinutes : null;
      return {
        code: 0,
        text: `续上了：${me.scope} 第 ${r.lease.term} 任 ${holderText(r.lease)}${lm === null ? `；${settingsText(snap.settings)}` : `，租约到 ${seatExpiresAt(r.lease, lm)}`}（库的时钟）`,
        json: {
          ok: true,
          seat: leaseJson(r.lease),
          leaseMinutes: lm,
          expiresAt: lm === null ? null : seatExpiresAt(r.lease, lm),
          now: r.now,
        },
      };
    }
    const snap = await store.readSeat(me.scope);
    if (!snap.settings.ok)
      return {
        code: 1,
        text: `没查成：${snap.settings.why}。按不是帅位算，先把设置改对`,
        json: { ok: false, reason: 'settings', why: snap.settings.why, now: snap.now },
      };
    const v = seatVerdict(snap.lease, me, snap.now, snap.settings.settings.leaseMinutes);
    if (!v.ok)
      return {
        code: 3,
        text: `不是帅位：${v.why}`,
        json: { ok: false, reason: v.reason, why: v.why, seat: leaseJson(snap.lease), now: snap.now },
      };
    return {
      code: 0,
      text: `是帅位：${me.scope} 第 ${v.term} 任，租约到 ${v.expiresAt}（库的时钟）`,
      json: { ok: true, term: v.term, expiresAt: v.expiresAt, now: snap.now },
    };
  }
  if (sub === 'show') {
    const p = parse(rest, ['scope'], usage);
    if (p.positional.length > 0) throw new SeatCliError(`seat show 不收位置参数。\n${usage}`);
    return showSeat(store, scopeOf(p, usage));
  }
  if (sub === 'handoff') {
    const p = parse(rest, ['machine', 'session', 'scope', 'term'], usage);
    if (p.positional.length > 0)
      throw new SeatCliError(`seat handoff 不收位置参数：交接说明从标准输入读。\n${usage}`);
    const me = actorOf(p, usage);
    const text = (await deps.readStdin()).trim();
    if (!text)
      throw new SeatCliError(
        `交接说明是空的：从标准输入给（在做什么、等谁拍什么、开着的 PR 和工人、下一步）。\n${usage}`,
      );
    if ([...text].length > MAX_HANDOFF) throw new SeatCliError(`交接说明太长（最多 ${MAX_HANDOFF} 个字）`);
    const r = await store.writeHandoff({ ...me, text });
    if (!r.ok)
      return {
        code: 3,
        text: `没存上：${r.lease ? `帅位是 ${holderText(r.lease)}（第 ${r.lease.term} 任）` : '座位上没人'}；只有现任、刚被换下的上一任能写交接`,
        json: { ok: false, seat: leaseJson(r.lease), now: r.now },
      };
    return {
      code: 0,
      text: `交接说明存上了（${[...text].length} 字，${r.lease.handoffAt}）`,
      json: { ok: true, seat: leaseJson(r.lease) },
    };
  }
  throw new SeatCliError(sub ? `没有 seat ${sub} 这条命令。\n${usage}` : usage);
}

const ACTIVE_TASK = (state: string) => !['queued', 'done', 'stopped', 'failed'].includes(state);

/** 看现状：新帅位开场从库里现算的那一份交接（加上最新一份交接说明，只算补充）。 */
async function showSeat(store: Store, scope: string): Promise<SeatCliResult> {
  const snap = await store.readSeat(scope);
  const names = await repoNames(store);
  const { claims, now } = await store.listClaims({ activeOnly: true });
  const repos = await store.listRepos();
  // 一条一条读（不并发）：连不上库时并发的查询会挂着，关连接要等它们
  const tasks: Task[] = [];
  for (const r of repos)
    tasks.push(...(await store.listBoardTasks(r.id)).filter((t) => ACTIVE_TASK(t.state)));
  const asks: { task: Task; ask: AskRecord }[] = [];
  for (const t of tasks)
    for (const a of await store.listAsks(t.id)) if (a.answer === undefined) asks.push({ task: t, ask: a });
  const alerts = await store.listNotifications({ status: 'open', limit: 50 });
  const lease = snap.lease;
  const lm = snap.settings.ok ? snap.settings.settings.leaseMinutes : null;
  const expired =
    lease !== null && lm !== null && Date.parse(seatExpiresAt(lease, lm) ?? '') <= Date.parse(snap.now);
  const lines = [
    lease === null
      ? `帅位（${scope}）：座位上没人`
      : `帅位（${scope}）：第 ${lease.term} 任 ${holderText(lease)}，上次续约 ${lease.renewedAt}${expired ? '（过了租期没续：可能断了）' : ''}${lease.previousMachine ? `；上一任 ${lease.previousMachine}/${lease.previousSession}` : ''}`,
    settingsText(snap.settings),
    `在做的认领（${claims.length}）：`,
    ...claims.map((c) => `  ${names.get(c.repoId) ?? c.repoId}#${c.issueNumber} ${describeClaim(c, now)}`),
    `引擎在跑的单（${tasks.length}）：`,
    ...tasks.map((t) => `  ${names.get(t.repoId) ?? t.repoId}#${t.issueNumber} ${t.state}：${t.title}`),
    `没答的提问（${asks.length}）：`,
    ...asks.map(
      ({ task, ask }) => `  ${names.get(task.repoId) ?? task.repoId}#${task.issueNumber}：${ask.question}`,
    ),
    `没处理的提醒：${alerts.items.length}${alerts.nextCursor ? '+' : ''} 条（驾驶舱提醒中心看）`,
    lease?.handoff ? `最新一份交接说明（${lease.handoffAt}，只算补充）：\n${lease.handoff}` : '没有交接说明',
    '开着的 PR、最近的决定不在库里：本机用 gh pr list、git log origin/main -- docs/decisions specs 现查',
  ];
  return {
    code: 0,
    text: lines.join('\n'),
    json: {
      seat: leaseJson(lease),
      leaseMinutes: lm,
      expired,
      settings: snap.settings,
      claims: claims.map((c) => claimJson(c, names)),
      tasks: tasks.map((t) => ({
        repo: names.get(t.repoId) ?? t.repoId,
        issue: t.issueNumber,
        state: t.state,
        title: t.title,
      })),
      asks: asks.map(({ task, ask }) => ({
        repo: names.get(task.repoId) ?? task.repoId,
        issue: task.issueNumber,
        question: ask.question,
      })),
      openAlerts: alerts.items.length,
      now,
    },
  };
}

// —— claim ——

/**
 * 演练（方案「演练」第 5 步）：引擎那一边在真库上和本机同时抢一张演练单——走引擎接活用的同一个库函数（claimForEngine），
 * 只在演练座位下允许，记在演练座位名下，不起工作流，待起补起不碰它。真引擎的认领只由接活、交单拿。
 */
async function drillEngineTake(
  p: Parsed,
  store: Store,
  repoName: { owner: string; name: string },
  issueNumber: number,
): Promise<SeatCliResult> {
  const usage = CLAIM_USAGE;
  const scope = scopeOf(p, usage);
  if (!isDrillScope(scope))
    throw new SeatCliError(
      `--owner engine 只在演练座位（--scope drill:<名字>）下能用：真引擎的认领只由接活、交单拿。\n${usage}`,
    );
  for (const k of ['machine', 'session', 'term', 'label', 'grace-minutes'])
    if (p.options.has(k))
      throw new SeatCliError(`--owner engine 不带 --${k}（引擎那一边没有帅位、工人）。\n${usage}`);
  const note = noteOf(p, false, usage);
  const repo = await repoOf(store, repoName);
  const names = new Map([[repo.id, `${repo.owner}/${repo.name}`]]);
  const label = `${repo.owner}/${repo.name}#${issueNumber}`;
  const r = await store.claimForEngine({
    repoId: repo.id,
    issueNumber,
    workflowId: requirementWorkflowId(repo, issueNumber),
    actor: { kind: 'engine', id: 'drill' },
    drill: scope,
    note: note ?? `演练（${scope}）：引擎这一边只抢认领、不起工作流`,
  });
  if (r.ok)
    return {
      code: 0,
      text: `演练：引擎拿到了 ${label}（${r.fresh ? '新认领' : '本来就拿着'}，认领号 ${r.claim.claimId}，待起；不起工作流）`,
      json: { ok: true, claim: claimJson(r.claim, names), fresh: r.fresh, now: r.now },
    };
  if (r.reason === 'held')
    return {
      code: 3,
      text: `演练：引擎没抢到 ${label}：${describeClaim(r.claim, r.now)}`,
      json: { ok: false, reason: 'held', claim: claimJson(r.claim, names), now: r.now },
    };
  return {
    code: 1,
    text: `演练：引擎没抢到 ${label}：${r.why}`,
    json: { ok: false, reason: r.reason, why: r.why, now: r.now },
  };
}

export async function runClaim(argv: readonly string[], deps: { store: Store }): Promise<SeatCliResult> {
  const [sub = '', ...rest] = argv;
  const usage = CLAIM_USAGE;
  const { store } = deps;
  if (sub === 'take') {
    const p = parse(
      rest,
      ['machine', 'session', 'scope', 'term', 'label', 'owner', 'grace-minutes', 'note'],
      usage,
    );
    if (p.positional.length !== 2) throw new SeatCliError(`要两个位置参数：仓和单号。\n${usage}`);
    const repoName = repoArg(p.positional[0], usage);
    const issueNumber = positiveInt(p.positional[1] ?? '', '单号', usage);
    if (p.options.get('owner') === 'engine') return drillEngineTake(p, store, repoName, issueNumber);
    const seat = actorOf(p, usage);
    const label = need(p, 'label', usage);
    const labelWhy = sessionProblem(label, '工人名');
    if (labelWhy) throw new SeatCliError(`${labelWhy}。\n${usage}`);
    const kind = p.options.get('owner') ?? 'worker';
    if (kind !== 'worker' && kind !== 'seat')
      throw new SeatCliError(
        `--owner 只收 worker、seat（演练座位下还有 engine），没有「${kind}」。\n${usage}`,
      );
    const graceRaw = p.options.get('grace-minutes');
    const graceMinutes = graceRaw === undefined ? undefined : positiveInt(graceRaw, '宽限期（分钟）', usage);
    const note = noteOf(p, false, usage);
    const repo = await repoOf(store, repoName);
    const names = new Map([[repo.id, `${repo.owner}/${repo.name}`]]);
    const r = await store.takeClaim({
      repoId: repo.id,
      issueNumber,
      seat,
      owner: { kind, label },
      graceMinutes,
      note,
    });
    const label2 = `${repo.owner}/${repo.name}#${issueNumber}`;
    if (r.ok)
      return {
        code: 0,
        text: `认领了 ${label2}：归 ${claimOwnerText(r.claim)}，认领号 ${r.claim.claimId}（开 PR 时正文「认领」栏写它），宽限期 ${r.claim.graceMinutes} 分钟没心跳就作废`,
        json: { ok: true, claim: claimJson(r.claim, names), now: r.now },
      };
    if (r.reason === 'held')
      return {
        code: 3,
        text: `没认领上：${label2} ${describeClaim(r.claim, r.now)}；不碰这张。要接手得等它结束、作废，或者创始人说了改派`,
        json: { ok: false, reason: 'held', claim: claimJson(r.claim, names), now: r.now },
      };
    return {
      code: r.reason === 'not_seat' ? 3 : 1,
      text: `没认领上（${label2} 没动）：${r.why}`,
      json: { ok: false, reason: r.reason, why: r.why, now: r.now },
    };
  }
  if (sub === 'step' || sub === 'done' || sub === 'release') {
    const p = parse(rest, sub === 'step' ? ['claim', 'note', 'pr'] : ['claim', 'note'], usage);
    if (p.positional.length !== 2) throw new SeatCliError(`要两个位置参数：仓和单号。\n${usage}`);
    const repoName = repoArg(p.positional[0], usage);
    const issueNumber = positiveInt(p.positional[1] ?? '', '单号', usage);
    const claimId = need(p, 'claim', usage).toLowerCase();
    if (!UUID.test(claimId))
      throw new SeatCliError(`认不出认领号「${claimId}」：认领时打印的那一串。\n${usage}`);
    const note = noteOf(p, sub !== 'step', usage);
    const prRaw = p.options.get('pr');
    const pr = prRaw === undefined ? undefined : positiveInt(prRaw, 'PR 号', usage);
    const repo = await repoOf(store, repoName);
    const names = new Map([[repo.id, `${repo.owner}/${repo.name}`]]);
    const target = { repoId: repo.id, issueNumber, claimId };
    const r =
      sub === 'step'
        ? await store.stepClaim({ ...target, note, pr })
        : await store.endClaim({
            ...target,
            state: sub === 'done' ? 'done' : 'released',
            reason: note ?? '',
          });
    const label2 = `${repo.owner}/${repo.name}#${issueNumber}`;
    if (!r.ok)
      return {
        code: 3,
        text: `没记上：${label2} ${r.claim ? `现在是 ${describeClaim(r.claim, r.now)}` : '没有认领'}，你的认领号 ${claimId.slice(0, 8)} 对不上或已经结束；这张已经不归你，别再动（推不上、合不进）`,
        json: { ok: false, claim: r.claim && claimJson(r.claim, names), now: r.now },
      };
    return {
      code: 0,
      text: `${label2}：${claimOwnerText(r.claim)} ${claimStateText(r.claim.state)}${sub === 'step' && pr !== undefined ? `，登记了 PR #${pr}` : ''}`,
      json: { ok: true, claim: claimJson(r.claim, names), now: r.now },
    };
  }
  if (sub === 'show') {
    const p = parse(rest, [], usage);
    const [repoRaw, ...nums] = p.positional;
    const repo = await repoOf(store, repoArg(repoRaw, usage));
    const numbers = nums.map((n) => positiveInt(n, '单号', usage));
    const names = new Map([[repo.id, `${repo.owner}/${repo.name}`]]);
    const { claims, now } = await store.listClaims({ repoId: repo.id, activeOnly: !p.flags.has('all') });
    const picked = numbers.length === 0 ? claims : claims.filter((c) => numbers.includes(c.issueNumber));
    const missing = numbers.filter((n) => !picked.some((c) => c.issueNumber === n));
    const lines = [
      ...picked.map((c) => `${repo.owner}/${repo.name}#${c.issueNumber} ${describeClaim(c, now)}`),
      ...missing.map(
        (n) =>
          `${repo.owner}/${repo.name}#${n} 没人认领${p.flags.has('all') ? '' : '（还活着的里没有；带 --all 连结束了的一起看）'}`,
      ),
    ];
    return {
      code: 0,
      text:
        lines.length > 0
          ? lines.join('\n')
          : `${repo.owner}/${repo.name} 没有${p.flags.has('all') ? '' : '还活着的'}认领`,
      json: { claims: picked.map((c) => claimJson(c, names)), missing, now },
    };
  }
  if (sub === 'sweep') {
    const p = parse(rest, [], usage);
    if (p.positional.length > 0) throw new SeatCliError(`claim sweep 不收位置参数。\n${usage}`);
    const names = await repoNames(store);
    const { voided, now } = await store.voidExpiredClaims({ limit: 200 });
    return {
      code: 0,
      text:
        voided.length === 0
          ? '没有过了宽限期没心跳的认领'
          : [
              `作废了 ${voided.length} 张（它们开着的 PR 撤自动合并、贴红在 #299 下一步接上）：`,
              ...voided.map(
                (c) => `  ${names.get(c.repoId) ?? c.repoId}#${c.issueNumber} ${describeClaim(c, now)}`,
              ),
            ].join('\n'),
      json: { voided: voided.map((c) => claimJson(c, names)), now },
    };
  }
  throw new SeatCliError(sub ? `没有 claim ${sub} 这条命令。\n${usage}` : usage);
}
