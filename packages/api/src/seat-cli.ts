// fleet-api seat …、fleet-api claim …：帅位记「现在是谁」（#446，specs/446-帅位认领简化/需求.md）。本机的帅位、工人经
// ssh 以 root 调（ssh <法国> 'bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api seat …'），机器名、会话号
// 放参数里：经 ssh 进来的一律是 root，看不出是谁。判法在 @fleet-dao/core 的 seat.ts，读写在 Store（seat-store.ts）。
// 每条都能带 --json：只往标准输出打一行 JSON，给本机的脚本认；不带就打给人看的话。
// 退出码：0 做成了；3 别人拿着这张单、认领号对不上（claim 的事，和是不是帅位无关——#446 起没有「不是帅位」这回事）；
// 1 没做成（库出错）；2 参数不对。
import {
  type BoardWrite,
  claimOwnerText,
  claimStateText,
  describeClaim,
  holderText,
  type IssueClaim,
  isActiveClaim,
  isDrillScope,
  lastActivityText,
  MAIN_SEAT,
  machineProblem,
  pendingBoardAnswers,
  type SeatLease,
  seatScopeProblem,
  sessionProblem,
} from '@fleet-dao/core';
import { type Repo, requirementWorkflowId, type Task } from '@fleet-dao/shared';
import type { AskRecord, SeatActor, Store } from './ports.ts';

export const SEAT_USAGE = [
  '用法：fleet-api seat <take|show|handoff|board> …（#446 起帅位只记「现在是谁」，不是锁；都能带 --scope drill:<名字> 用演练座位、带 --json 给脚本读）',
  '  seat board head <项目> --machine … --session … --text "<一句话>"',
  '  seat board add <项目> --machine … --session … --id <步骤> --order <序号> --title "<标题>" [--detail "<说明>"]',
  '  seat board step <项目> --machine … --session … --id <步骤> --status <done|doing|waiting|needs|blocked> [--detail "<说明>"]',
  '  seat board log <项目> --machine … --session … --text "<动态>"',
  '  seat board link <项目> --machine … --session … --id <步骤> --label "<名字>" --url <http(s) 网址>',
  '  seat board need <项目> --machine … --session … --id <编号> --issue <单号> --repo <owner/仓> --recommend <选项> <问题> <选项…>',
  '  seat board clear-needs <项目> --machine … --session …',
  '  seat board pending [<项目>] --machine … --session …   已拍、还没写进单子的',
  '  seat board ack <项目> --machine … --session … --id <编号>',
  '  seat board show [<项目>] [--scope …]   看板上的样子；谁都写得进（board 只给人看，不核是不是现任）',
  '  seat take --machine <机器名> --session <会话号>   接班（永远成功，后说的算；换了人旧帅位下次 show 就看得到）',
  '  seat show                                          看现状：现在是谁、最后活动多久前、在做的认领、引擎在跑的单、没答的提问',
  '  seat handoff --machine <机器名> --session <会话号> 存交接说明（从标准输入读；座位上没人时存不进）',
].join('\n');

export const CLAIM_USAGE = [
  '用法：fleet-api claim <take|step|done|release|reassign|show> …（每张单一个认领，留作记录，不再拦人；都能带 --json 给脚本读）',
  '  claim take <owner/仓名> <单号> --machine <机器名> --session <会话号> --label <工人名> [--owner worker|seat] [--note "<一句话>"] [--scope drill:<名字>]',
  '                                         认领一张单（派给工人或自己做；帅位自己占着的也换给工人）；别人还活着拿着的拒绝（3），要抢用 reassign',
  '  claim take <owner/仓名> <单号> --owner engine --scope drill:<名字>   演练：引擎那一边抢（只在演练座位下，不起工作流）',
  '  claim step <owner/仓名> <单号> --claim <认领号> [--note "<一句话>"] [--pr <PR 号>]   工人报一步、登记 PR（纯记录，没有心跳过期这回事）',
  '  claim done <owner/仓名> <单号> --claim <认领号> --note "<一句话>"                    做完了',
  '  claim release <owner/仓名> <单号> --claim <认领号> --note "<一句话>"                 放下（不做了、交出去）',
  '  claim reassign <owner/仓名> <单号> --to worker|seat --label <工人名> --machine <机器名> --session <会话号> [--note "<一句话>"] [--founder "<有的话>"] [--scope drill:<名字>]',
  '                                         改派给本机：原来的结束了的直接改；还活着的（引擎、别的工人）当场作废、换给这次的（#446 起不用带创始人原话，写 --note 记一句为什么）',
  '  claim reassign <owner/仓名> <单号> --to engine --reason "<为什么>" (--machine … --session … | --founder "<有的话>")',
  '                                         改派给引擎：走交单（fleet-api handover）同一条路',
  '  claim show <owner/仓名> [<单号>…] [--all]   看认领（默认只列还活着的）',
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

/** #446 起 --term 不用带（帅位不是锁）：给了就认一下、纯记录进认领行，不给也照做。 */
function actorOf(p: Parsed, usage: string): SeatActor {
  const term = p.options.get('term');
  return {
    ...identityOf(p, usage),
    scope: scopeOf(p, usage),
    ...(term === undefined ? {} : { term: positiveInt(term, '任期', usage) }),
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
        lastActivityAt: lease.lastActivityAt,
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

async function repoNames(store: Store): Promise<Map<string, string>> {
  return new Map((await store.listRepos()).map((r) => [r.id, `${r.owner}/${r.name}`]));
}

const BOARD_OPTS = [
  'machine',
  'session',
  'term',
  'scope',
  'text',
  'id',
  'order',
  'title',
  'detail',
  'status',
  'label',
  'url',
  'issue',
  'repo',
  'recommend',
] as const;

function boardFail(reason: string, why: string, now: string, code: number): SeatCliResult {
  return { code, text: why, json: { ok: false, reason, why, now } };
}

/** 帅位栏：#446 起写、看都不核是不是现任（帅位不是锁）。 */
async function runBoard(rest: readonly string[], store: Store): Promise<SeatCliResult> {
  const usage = SEAT_USAGE;
  const [action = '', ...args] = rest;
  const writes = new Set(['head', 'add', 'step', 'log', 'link', 'need', 'clear-needs', 'ack', 'pending']);
  if (!writes.has(action) && action !== 'show')
    throw new SeatCliError(`没有 seat board ${action || '(缺命令)'}。\n${usage}`);
  const p = parse(args, BOARD_OPTS, usage);
  const project = p.positional[0];
  if (action !== 'show' && action !== 'pending' && !project) {
    throw new SeatCliError(`要写项目名（仓名）。\n${usage}`);
  }
  if (action === 'show') {
    const scope = scopeOf(p, usage);
    const listed = await store.listSeatBoards(scope);
    if (!listed.ok) return boardFail('bad', listed.why, listed.now, 1);
    const boards = project ? listed.boards.filter((b) => b.project === project) : listed.boards;
    const text =
      boards.length === 0
        ? `${scope} 没有${project ? ` ${project} 的` : ''}帅位栏`
        : boards
            .map((b) => {
              const steps = [...b.doc.steps].sort((a, c) => a.order - c.order);
              return [
                `${b.project}（${b.updatedAt}）`,
                `现状：${b.doc.headline || '（没写）'}`,
                b.doc.needs.length
                  ? `要你定的：\n${b.doc.needs.map((n) => `  ${n.id} ${n.question}（${n.options.join(' / ')}）`).join('\n')}`
                  : '要你定的：没有',
                steps.length
                  ? `步骤：\n${steps.map((s) => `  ${s.id} [${s.status}] ${s.title}（${s.updatedAt}）`).join('\n')}`
                  : '步骤：还没有',
                b.doc.log.length
                  ? `最近动态：\n${b.doc.log.map((e) => `  ${e.at} ${e.text}`).join('\n')}`
                  : '最近动态：没有',
              ].join('\n');
            })
            .join('\n\n');
    return {
      code: 0,
      text,
      json: {
        ok: true,
        now: listed.now,
        boards: boards.map((b) => ({
          project: b.project,
          headline: b.doc.headline,
          updatedAt: b.updatedAt,
          steps: b.doc.steps,
          log: b.doc.log,
          needs: b.doc.needs,
        })),
      },
    };
  }
  const seat = actorOf(p, usage);
  if (action === 'pending') {
    const listed = await store.listSeatBoards(seat.scope);
    if (!listed.ok) return boardFail('bad', listed.why, listed.now, 1);
    const picked = project ? listed.boards.filter((b) => b.project === project) : listed.boards;
    const pending = picked.flatMap((b) =>
      pendingBoardAnswers(b.doc).map((a) => ({
        project: b.project,
        id: a.id,
        question: a.question,
        option: a.option,
        repo: a.repo,
        issue: a.issue,
      })),
    );
    return {
      code: 0,
      text:
        pending.length === 0
          ? '没有已拍还没记账的'
          : pending.map((a) => `${a.project} ${a.id} ${a.question} → ${a.option}`).join('\n'),
      json: { ok: true, pending, now: listed.now },
    };
  }
  const op = boardOp(action, p, usage);
  const r = await store.applySeatBoard({ seat, project: project ?? '', op });
  // #446 起写板子不核是不是现任：失败只剩「op 认不出」「项目名不对」，都是 1，没有 3 那一档了
  if (!r.ok) return boardFail(r.reason, r.why, r.now, 1);
  return {
    code: 0,
    text: `改好了（${r.board.project} ${action}）`,
    json: { ok: true, project: r.board.project, now: r.now },
  };
}

function boardOp(action: string, p: Parsed, usage: string): BoardWrite {
  const text = () => need(p, 'text', usage);
  const id = () => need(p, 'id', usage);
  switch (action) {
    case 'head':
      return { kind: 'head', text: text() };
    case 'add':
      return {
        kind: 'add',
        id: id(),
        order: positiveInt(need(p, 'order', usage), '序号', usage),
        title: need(p, 'title', usage),
        detail: p.options.get('detail') ?? '',
      };
    case 'step':
      return {
        kind: 'step',
        id: id(),
        status: need(p, 'status', usage),
        ...(p.options.has('detail') ? { detail: p.options.get('detail') ?? '' } : {}),
      };
    case 'log':
      return { kind: 'log', text: text() };
    case 'link':
      return { kind: 'link', id: id(), label: need(p, 'label', usage), url: need(p, 'url', usage) };
    case 'clear-needs':
      return { kind: 'clear-needs' };
    case 'ack':
      return { kind: 'ack', id: id() };
    case 'need': {
      const question = p.positional[1];
      const options = p.positional.slice(2);
      if (!question || options.length < 2) {
        throw new SeatCliError(`need 要在项目名后面写问题和至少两个选项。\n${usage}`);
      }
      return {
        kind: 'need',
        id: id(),
        question,
        options,
        recommended: need(p, 'recommend', usage),
        repo: need(p, 'repo', usage),
        issue: positiveInt(need(p, 'issue', usage), '单号', usage),
      };
    }
    default:
      throw new SeatCliError(`没有 seat board ${action}。\n${usage}`);
  }
}

// —— seat ——

export async function runSeat(
  argv: readonly string[],
  deps: { store: Store; readStdin: () => Promise<string> },
): Promise<SeatCliResult> {
  const [sub = '', ...rest] = argv;
  const usage = SEAT_USAGE;
  const { store } = deps;
  if (sub === 'board') return runBoard(rest, store);
  if (sub === 'take') {
    const p = parse(rest, ['machine', 'session', 'scope'], usage);
    if (p.positional.length > 0) throw new SeatCliError(`seat take 不收位置参数。\n${usage}`);
    const me = identityOf(p, usage);
    const scope = scopeOf(p, usage);
    // #446 起接班永远成功（后说的算），不核旧的同不同意
    const { lease, now } = await store.takeSeat({ scope, ...me });
    const prev =
      lease.previousMachine === null
        ? '座位原来没人'
        : `上一任是 ${lease.previousMachine}/${lease.previousSession}（第 ${lease.term - 1} 任），它下次 seat show 看一眼就知道该退了`;
    return {
      code: 0,
      text: `接班了：${scope} 第 ${lease.term} 任是 ${holderText(lease)}；${prev}。`,
      json: { ok: true, seat: leaseJson(lease), now },
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
    // #446 起谁都能写（不核是不是现任）：座位上没人（从没接过班）才存不进
    const r = await store.writeHandoff({ ...me, text });
    if (!r.ok)
      return {
        code: 3,
        text: '没存上：座位上没人（还没接过班），没什么可交接的',
        json: { ok: false, seat: null, now: r.now },
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

/** 看现状：现在是谁、最后活动多久前、在做的认领、引擎在跑的单、没答的提问、交接说明。 */
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
  const lines = [
    lease === null
      ? `帅位（${scope}）：座位上没人`
      : `帅位（${scope}）：第 ${lease.term} 任 ${holderText(lease)}，${lastActivityText(lease.lastActivityAt, snap.now)}${lease.previousMachine ? `；上一任 ${lease.previousMachine}/${lease.previousSession}` : ''}`,
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
      now: snap.now,
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
  // #446 起 claimForEngine 不带 force 的失败只有一种：held（reason 恒为 'held'，没有别的分支了）
  return {
    code: 3,
    text: `演练：引擎没抢到 ${label}：${describeClaim(r.claim, r.now)}`,
    json: { ok: false, reason: 'held', claim: claimJson(r.claim, names), now: r.now },
  };
}

/**
 * 改派（#446 起不用创始人原话）。给本机（--to worker|seat）：抢这一行——原来的作废了、放下了、做完了的直接改；还活着的
 * （引擎、别的工人）当场作废、给这次的工人，写 --note 记一句为什么（有创始人原话就用 --founder，纯记录）；引擎的工作流
 * 叫停。给引擎（--to engine）走交单同一条路。
 */
async function reassign(rest: readonly string[], deps: ClaimCliDeps): Promise<SeatCliResult> {
  const usage = CLAIM_USAGE;
  const p = parse(
    rest,
    ['to', 'machine', 'session', 'scope', 'term', 'label', 'founder', 'grace-minutes', 'note', 'reason'],
    usage,
  );
  if (p.positional.length !== 2) throw new SeatCliError(`要两个位置参数：仓和单号。\n${usage}`);
  const repoName = repoArg(p.positional[0], usage);
  const issueNumber = positiveInt(p.positional[1] ?? '', '单号', usage);
  const to = need(p, 'to', usage);
  const founder = p.options.get('founder')?.trim() || undefined;
  if (founder !== undefined && [...founder].length > MAX_NOTE)
    throw new SeatCliError(`--founder 太长（最多 ${MAX_NOTE} 个字）。\n${usage}`);
  if (to === 'engine') {
    for (const k of ['label', 'grace-minutes', 'note'])
      if (p.options.has(k)) throw new SeatCliError(`--to engine 不带 --${k}（交单写 --reason）。\n${usage}`);
    const reason = need(p, 'reason', usage);
    const hasSeat = p.options.has('machine') || p.options.has('session') || p.options.has('term');
    if (!hasSeat && founder === undefined)
      throw new SeatCliError(
        `--to engine 要带着帅位（--machine … --session … --term …）或创始人原话（--founder）。\n${usage}`,
      );
    const text = await deps.handoverToEngine({
      owner: repoName.owner,
      name: repoName.name,
      issueNumber,
      reason,
      seat: hasSeat ? actorOf(p, usage) : undefined,
      founder,
    });
    return { code: 0, text, json: { ok: true, to: 'engine', text } };
  }
  if (to !== 'worker' && to !== 'seat')
    throw new SeatCliError(`--to 只收 worker、seat、engine，没有「${to}」。\n${usage}`);
  if (p.options.has('reason')) throw new SeatCliError(`--to ${to} 不带 --reason（写 --note）。\n${usage}`);
  const seat = actorOf(p, usage);
  const label = need(p, 'label', usage);
  const labelWhy = sessionProblem(label, '工人名');
  if (labelWhy) throw new SeatCliError(`${labelWhy}。\n${usage}`);
  const graceRaw = p.options.get('grace-minutes');
  const graceMinutes = graceRaw === undefined ? undefined : positiveInt(graceRaw, '宽限期（分钟）', usage);
  const note = noteOf(p, false, usage);
  const repo = await repoOf(deps.store, repoName);
  const names = new Map([[repo.id, `${repo.owner}/${repo.name}`]]);
  const label2 = `${repo.owner}/${repo.name}#${issueNumber}`;
  const r = await deps.store.takeClaim({
    repoId: repo.id,
    issueNumber,
    seat,
    owner: { kind: to, label },
    graceMinutes,
    note,
    founder,
    force: true,
  });
  if (!r.ok) {
    // #446 起 reassign 永远 force=true：held 理论上不会再出现，留着是防御性分支
    return {
      code: 1,
      text: `没改派（${label2} 没动）：${r.reason === 'held' ? describeClaim(r.claim, r.now) : '没做成'}`,
      json: { ok: false, reason: r.reason, now: r.now },
    };
  }
  const lines = [
    `改派了 ${label2}：归 ${claimOwnerText(r.claim)}，认领号 ${r.claim.claimId}（开 PR 时正文「认领」栏写它）`,
  ];
  const json: Record<string, unknown> = { ok: true, claim: claimJson(r.claim, names), now: r.now };
  let code = 0;
  const old = r.voided ?? (r.previous?.state === 'voided' ? r.previous : null);
  if (old) {
    const engineOwned = old.ownerKind === 'engine';
    lines.push(
      `原来那份作废了：${claimOwnerText(old)}（认领 ${old.claimId.slice(0, 8)}，${old.endReason ?? '没写原因'}）` +
        (engineOwned ? '' : '；开着的 PR 不动，旧主自己关或帅位手动关'),
    );
    json.voided = claimJson(old, names);
  }
  // 原来归引擎、这次强制作废的：叫停它的工作流（工作流不知道认领已经不归它了，得有人去叫停，不然接着跑）。停成了
  // （或已经不在了）才关它的 PR——引擎的运行叫停了要关它的 PR，specs/169-Fusion形态/需求.md「删减清单全按帅位的做」
  // 第 1 条第 5 点：GPT 两轮标了这条不能删，创始人收了（这不算「拦人」，引擎不是人，是没人管的机器）。人和人之间的
  // 改派不碰 PR（上面 engineOwned 那句），只有引擎这条留着。
  if (r.voided?.ownerKind === 'engine' && r.voided.workflowId) {
    const reason = `改派给 ${claimOwnerText(r.claim)}（${founder ? `创始人原话：${founder}` : note ? note : '没写原因'}）`;
    try {
      const stopped = await deps.stopEngine(r.voided.workflowId, {
        by: `${seat.machine}/${seat.session}`,
        reason,
      });
      lines.push(
        stopped === 'stopped'
          ? `引擎的工作流 ${r.voided.workflowId} 叫停了`
          : `引擎的工作流 ${r.voided.workflowId} 已经不在了`,
      );
      json.engine = stopped;
      if (r.voided.prNumbers.length > 0) {
        const closed = await deps.closeEnginePr({
          owner: repo.owner,
          name: repo.name,
          prNumbers: r.voided.prNumbers,
          reason,
        });
        lines.push(
          closed.closed.length > 0
            ? `它开着的 PR 关了（分支留着）：${closed.closed.map((n) => `#${n}`).join('、')}`
            : '它没有开着的 PR',
        );
        if (closed.problems.length > 0) {
          code = 1;
          lines.push(...closed.problems.map((x) => `没关成：${x}`));
        }
        json.closedPr = closed;
      }
    } catch (err) {
      code = 1;
      const why = err instanceof Error ? err.message : String(err);
      lines.push(
        `引擎的工作流 ${r.voided.workflowId} 没叫停成（${why}）：它开的 PR 合不进去（认领已经不归引擎），但它还在跑，先不关 PR，要人去叫停`,
      );
      json.engine = { error: why };
    }
  }
  return { code, text: lines.join('\n'), json };
}

/**
 * fleet-api claim 碰外面的几样：库；Temporal、交单、关引擎的 PR 用到才连（#446 起不再碰 GitHub 贴「认领对得上」、
 * 不再重判——留着的只有下面这条关 PR，见 closeEnginePr）。
 */
export interface ClaimCliDeps {
  store: Store;
  /** 改派给本机时叫停引擎在跑的工作流：叫停了 stopped；工作流已经不在 gone；连不上抛错。 */
  stopEngine: (workflowId: string, input: { by: string; reason: string }) => Promise<'stopped' | 'gone'>;
  /**
   * 引擎的工作流叫停之后，把它开着的 PR 关掉、撤自动合并、留一句为什么（分支不删）：specs/169-Fusion形态/需求.md
   * 「删减清单全按帅位的做」第 1 条第 5 点留下的一条——引擎的运行叫停了要关它的 PR，GPT 两轮标了不能删、创始人收了。
   * 单个 PR 关不了写进 problems，不抛错（不影响改派本身，已经记上了）。
   */
  closeEnginePr: (input: {
    owner: string;
    name: string;
    prNumbers: readonly number[];
    reason: string;
  }) => Promise<{ closed: number[]; problems: string[] }>;
  /** 改派给引擎：交单（cli.ts 的 handover）同一条路，回给人看的那段话；没交成抛 CliError（带退出码）。 */
  handoverToEngine: (input: {
    owner: string;
    name: string;
    issueNumber: number;
    reason: string;
    seat?: SeatActor | undefined;
    founder?: string | undefined;
  }) => Promise<string>;
}

export async function runClaim(argv: readonly string[], deps: ClaimCliDeps): Promise<SeatCliResult> {
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
    if (r.ok) {
      return {
        code: 0,
        text: `认领了 ${label2}：归 ${claimOwnerText(r.claim)}，认领号 ${r.claim.claimId}`,
        json: { ok: true, claim: claimJson(r.claim, names), now: r.now },
      };
    }
    return {
      code: 3,
      text: `没认领上：${label2} ${describeClaim(r.claim, r.now)}；不碰这张。要接手用 claim reassign 强制改派（不用创始人原话）`,
      json: { ok: false, reason: 'held', claim: claimJson(r.claim, names), now: r.now },
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
    const text = `${label2}：${claimOwnerText(r.claim)} ${claimStateText(r.claim.state)}${sub === 'step' && pr !== undefined ? `，登记了 PR #${pr}` : ''}`;
    return { code: 0, text, json: { ok: true, claim: claimJson(r.claim, names), now: r.now } };
  }
  if (sub === 'reassign') return reassign(rest, deps);
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
  throw new SeatCliError(sub ? `没有 claim ${sub} 这条命令。\n${usage}` : usage);
}
