// fleet-api claim …：认领账（#299，specs/299-帅位只一个/方案.md 第四节；帅位座位整张删掉见 #531）：
// 判法在 @fleet-dao/core 的 seat.ts，读写在 Store（seat-store.ts）。
// 每条都能带 --json：只往标准输出打一行 JSON，给本机的脚本认（认不出按「没查成」算）；不带就打给人看的话。
// 退出码：0 做成了；3 不是你的（别人拿着、认领号对不上）；1 没做成（库出错）；2 参数不对。
import { claimOwnerText, type IssueClaim, isActiveClaim } from '@fleet-dao/core';
import { type Repo, requirementWorkflowId } from '@fleet-dao/shared';
import type { ClaimStatus } from './claim-status.ts';
import type { Store } from './ports.ts';

export const CLAIM_USAGE = [
  '用法：fleet-api claim <show|sweep|take> …（每张单一个认领，#299；都能带 --json 给脚本读）',
  '  claim show <owner/仓名> [<单号>…] [--all]   看认领（默认只列还活着的）',
  '  claim sweep                                 作废过了宽限期没心跳的本机认领，它们开着的 PR 撤自动合并、贴红、留言（引擎每轮 GitHub 对账都跑；演练时手动跑）',
  '  claim take <owner/仓名> <单号> --owner engine --scope drill:<名字> [--note "<一句话>"]',
  '                                         演练：引擎那一边抢（只在演练座位下，不起工作流）',
  '认领变了（认领、登记 PR、做完、放下、改派）当场重贴挂这张单的开着的 PR 上的「认领对得上」（引擎机器人）；没贴成照实说，GitHub 对账每 15 分钟会补。',
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
const MAX_NOTE = 500;

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

function positiveInt(raw: string, what: string, usage: string): number {
  const digits = /^#?(\d{1,9})$/.exec(raw)?.[1];
  const n = digits === undefined ? 0 : Number(digits);
  if (n <= 0) throw new SeatCliError(`认不出${what}「${raw}」：要写成正整数。\n${usage}`);
  return n;
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

/** fleet-api claim 碰外面的几样：库；GitHub（引擎机器人）、Temporal 用到才连。 */
export interface ClaimCliDeps {
  store: Store;
  /** 「认领对得上」那一侧（claim-status.ts）：认领变了重贴、sweep 撤自动合并。用到才连；连不上抛错。 */
  claims: () => Promise<ClaimStatus>;
}

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
  const scope = p.options.get('scope')?.trim() ?? '';
  if (!scope.startsWith('drill:'))
    throw new SeatCliError(
      `--owner engine 只在演练座位（--scope drill:<名字>）下能用：真引擎的认领只由接活、交单拿。\n${usage}`,
    );
  const note = p.options.get('note')?.trim() || undefined;
  if (note !== undefined && [...note].length > MAX_NOTE)
    throw new SeatCliError(`--note 太长（最多 ${MAX_NOTE} 个字）。\n${usage}`);
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
  return {
    code: 3,
    text: `演练：引擎没抢到 ${label}：${claimOwnerText(r.claim)} 拿着`,
    json: { ok: false, reason: 'held', claim: claimJson(r.claim, names), now: r.now },
  };
}

export async function runClaim(argv: readonly string[], deps: ClaimCliDeps): Promise<SeatCliResult> {
  const [sub = '', ...rest] = argv;
  const usage = CLAIM_USAGE;
  const { store } = deps;
  if (sub === 'take') {
    const p = parse(rest, ['scope', 'owner', 'note'], usage);
    if (p.positional.length !== 2) throw new SeatCliError(`要两个位置参数：仓和单号。\n${usage}`);
    const repoName = repoArg(p.positional[0], usage);
    const issueNumber = positiveInt(p.positional[1] ?? '', '单号', usage);
    if (p.options.get('owner') !== 'engine')
      throw new SeatCliError(
        `帅位座位整张删掉（#531）：claim take 只剩演练那一条（--owner engine）。\n${usage}`,
      );
    return drillEngineTake(p, store, repoName, issueNumber);
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
      ...picked.map((c) => `${repo.owner}/${repo.name}#${c.issueNumber} ${claimOwnerText(c)} ${c.state}`),
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
    let claims: ClaimStatus;
    try {
      claims = await deps.claims();
    } catch (err) {
      // GitHub 连不上也照样作废（库里的事先做）；PR 那边交给引擎每轮的对账
      const { voided, now } = await store.voidExpiredClaims({ limit: 200 });
      const why = err instanceof Error ? err.message : String(err);
      return {
        code: 1,
        text: [
          `作废了 ${voided.length} 张过了宽限期没心跳的认领；PR 那边没做（GitHub 没接上：${why}），撤自动合并、贴红交给引擎每 15 分钟的对账`,
          ...voided.map(
            (c) =>
              `  ${names.get(c.repoId) ?? c.repoId}#${c.issueNumber} ${claimOwnerText(c)}（认领 ${c.claimId.slice(0, 8)}）`,
          ),
        ].join('\n'),
        json: { ok: false, voided: voided.map((c) => claimJson(c, names)), why, now },
      };
    }
    const s = await claims.sweep();
    const lines = [
      s.voided.length === 0
        ? '没有过了宽限期没心跳的认领'
        : `作废了 ${s.voided.length} 张过了宽限期没心跳的认领：`,
      ...s.voided.map(
        (c) =>
          `  ${names.get(c.repoId) ?? c.repoId}#${c.issueNumber} ${claimOwnerText(c)}（认领 ${c.claimId.slice(0, 8)}）`,
      ),
      `开着的 PR 判了 ${s.checked} 个，「认领对得上」贴了 ${s.posted} 条${s.disabled.length > 0 ? `，撤了自动合并：${s.disabled.join('、')}` : ''}${s.commented > 0 ? `，留言 ${s.commented} 条` : ''}`,
      ...(s.reposScanned < s.reposTotal
        ? [`有 ${s.reposTotal - s.reposScanned} 个仓开着的 PR 没列出来`]
        : []),
      ...s.problems.map((x) => `没处理成：${x}`),
    ];
    return {
      code: s.problems.length > 0 ? 1 : 0,
      text: lines.join('\n'),
      json: {
        ok: s.problems.length === 0,
        voided: s.voided.map((c) => claimJson(c, names)),
        checked: s.checked,
        posted: s.posted,
        disabled: s.disabled,
        commented: s.commented,
        problems: s.problems,
      },
    };
  }
  throw new SeatCliError(sub ? `没有 claim ${sub} 这条命令。\n${usage}` : usage);
}
