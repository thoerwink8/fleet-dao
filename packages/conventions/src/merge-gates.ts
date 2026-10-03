// 合并闸的判法（design 第五节「流程只为快」，#74；#444 起只留四样；#654 起草稿、冲突交给 GitHub 自己拦）：改到的文件碰没碰先审后合
// 的路径、碰了的当前头上有没有通过的第二意见、引擎任务 PR 当前头上有没有通过的冷调用结论。纯判断，不碰网络；读写 GitHub 的在
// merge-gate.ts。「认领对得上」「写了关单却没带结果.md」两项 #444 起从判红里去掉，「档位」「必填栏」#654 起整个没有了。
// 三态纪律：读不到、认不出由调用方判「没查成」（退出码 2），不当成「没问题」。

/** 本机垫片（将来是引擎）审完写在 PR 当前头上的提交状态。 */
export const SECOND_OPINION_CONTEXT = 'second-opinion';
/**
 * 验收那一遍（合前一次冷调用，#555-2）写在 PR 当前头上的提交状态。**和 second-opinion 分开**：问的不是同一件事
 * （那条问「这改动值不值得先审」，这条问「单子说要的东西真做了没有」），共用一个 context 会互相盖掉。
 *
 * 判法和 second-opinion 一样：合并闸只**读**它——合并闸跑在 CI 里，判法必须确定（同一份代码什么时候跑结果都一样，
 * design 第五节），所以不能在这里起模型调用。冷调用那一遍在装配侧跑，结论贴成这个 context 的状态，闸只认状态。
 */
export const COLD_VERIFY_CONTEXT = 'cold-verify';
/** 冷调用最多几轮（specs/555-3：默认 1 轮、最多 2 轮）。到顶了还不过就是不过，不许拿第 3 轮盖过去。 */
export const COLD_VERIFY_MAX_ROUND = 2;
/** 高风险路径清单在仓里的位置（design 第五节「路径规则放每个仓的配置」）。 */
export const RISK_PATHS_FILE = 'packages/conventions/high-risk-paths.json';

/**
 * 先审后合只有这两种（design 第五节：删改迁移；碰安全——密钥鉴权、CI 工作流和卫生检查、对公网开口子和提权的生产配置）。
 * 原来的「动生产」2026-09-26 下午取消：部署脚本 CI 绿就合，只有防火墙、sudoers、香港 nginx 并进碰安全。
 */
export const RISK_KINDS = ['改数据库', '碰安全'] as const;
export type RiskKind = (typeof RISK_KINDS)[number];

export interface RiskPath {
  /** 以 / 结尾是目录（下面所有文件都算），否则是单个文件；仓内相对路径。 */
  path: string;
  kind: RiskKind;
  why: string;
  /**
   * 'migrations'：迁移目录。新加的迁移只建表、加列不算；改了、删了已有的迁移，或新迁移里有删、改已有表列数据的语句才算。
   * meta/ 下是按 SQL 生成的快照，不单独算。
   */
  mode?: 'migrations' | 'workflow';
}

/** 读清单：认不出返回一句为什么（调用方判没查成）；空清单也算认不出——一条都没有等于不拦。 */
export function parseRiskPaths(text: string): RiskPath[] | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return `不是合法的 JSON（${e instanceof Error ? e.message : String(e)}）`;
  }
  const paths = isObject(raw) ? raw.paths : undefined;
  if (!Array.isArray(paths)) return '没有 paths 列表';
  if (paths.length === 0) return 'paths 是空的（一条都没有等于什么都不拦）';
  const out: RiskPath[] = [];
  for (const [i, item] of paths.entries()) {
    const at = `paths 第 ${i + 1} 条`;
    if (!isObject(item) || typeof item.path !== 'string' || typeof item.why !== 'string') {
      return `${at} 认不出（要有 path、kind、why 三个字符串）`;
    }
    const path = item.path.trim();
    if (
      !path ||
      path === '/' ||
      path.startsWith('/') ||
      path.split('/').includes('..') ||
      path.includes('\\')
    ) {
      return `${at} 的 path「${item.path}」不是仓内相对路径（不以 / 开头、不带 .. 和反斜杠）`;
    }
    if (!RISK_KINDS.includes(item.kind as RiskKind)) {
      return `${at}（${path}）的 kind「${String(item.kind)}」不是${RISK_KINDS.map((k) => `「${k}」`).join('')}之一`;
    }
    if (!item.why.trim()) return `${at}（${path}）没写为什么`;
    const dir = path.endsWith('/');
    if (
      item.mode !== undefined &&
      !((item.mode === 'migrations' && dir) || (item.mode === 'workflow' && !dir && /[.]ya?ml$/.test(path)))
    ) {
      return `${at}（${path}）的 mode 认不出（目录只能写 "migrations"，单个 .yml 工作流文件只能写 "workflow"）`;
    }
    out.push({
      path,
      kind: item.kind as RiskKind,
      why: item.why.trim(),
      ...(item.mode === 'migrations' || item.mode === 'workflow' ? { mode: item.mode } : {}),
    });
  }
  return out;
}

/** PR 改到的一个文件（GitHub 的 PR 文件列表里的一条）。 */
export interface ChangedFile {
  filename: string;
  /** added、removed、modified、renamed…… */
  status: string;
  /** 改动内容；文件太大时 GitHub 不给。 */
  patch?: string;
  /** 改名前的名字。 */
  previous?: string;
}

export interface RiskyFile {
  file: string;
  rule: string;
  kind: RiskKind;
  /** 迁移目录里为什么算（新迁移里有哪种语句、或看不到内容）。 */
  note?: string;
}

/**
 * 新迁移里只放行明确是「只加不改」的语句：建表、建索引、建类型、新建函数和触发器（不带 OR REPLACE：同名已有就报错，
 * 改不了已有的）、插数据、写注释、给枚举加值、ALTER TABLE 里只有 ADD COLUMN / ADD CONSTRAINT 这类动作。替换或删掉已有的
 * 函数、视图、触发器（CREATE OR REPLACE、DROP TRIGGER）也算改。别的一律算删改（宁可多拦：认不准的写法由第二意见看一眼，
 * 漏拦一次删数据就回不来）。按整段 SQL 分语句判，语句跨几行都一样。
 */
const ADDITIVE = [
  /^CREATE (UNIQUE )?INDEX\b/,
  /^CREATE TABLE\b/,
  /^CREATE TYPE\b/,
  /^CREATE (FUNCTION|TRIGGER|VIEW)\b/,
  /^CREATE (SEQUENCE|EXTENSION|SCHEMA)\b/,
  /^INSERT INTO\b/,
  /^COMMENT ON\b/,
  /^ALTER TYPE \S+ ADD VALUE\b/,
];
const ADDITIVE_ACTION = /^ADD (COLUMN|CONSTRAINT|PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK)\b/;
const ALTER_TABLE = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:"[^"]*"|[\w.]+)(?:\.(?:"[^"]*"|\w+))? (.+)$/;
/** 函数体（$$…$$、$tag$…$tag$）：里面的分号不是语句分隔。 */
const DOLLAR_BODY = /\$(\w*)\$[\s\S]*?\$\1\$/g;

/** 按最外层的逗号切（括号里的逗号不算）。 */
function topLevelSplit(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function additive(stmt: string): boolean {
  if (ADDITIVE.some((r) => r.test(stmt))) return true;
  const actions = ALTER_TABLE.exec(stmt)?.[1];
  return actions !== undefined && topLevelSplit(actions).every((a) => ADDITIVE_ACTION.test(a));
}

/** 新加的迁移文件里删、改已有东西的第一条语句；看不到改动内容回 '看不到改动内容'；都是只加不改回 undefined。 */
export function destructiveIn(patch: string | undefined): string | undefined {
  if (patch === undefined) return '看不到改动内容';
  const sql = patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1).replace(/--.*$/, ''))
    .join('\n')
    .replace(DOLLAR_BODY, "''");
  for (const raw of sql.split(';')) {
    const stmt = raw.replace(/\s+/g, ' ').trim().toUpperCase();
    if (!stmt || additive(stmt)) continue;
    return `有「${stmt.split(' ').slice(0, 4).join(' ')}」`;
  }
  return undefined;
}

/**
 * 工作流文件里「改了就得有人看一眼」的几类内容（mode 为 workflow 的那条用）。判的是改动里加上、删掉的行（注释行不算），
 * 不是整个文件：改分台、并行、超时、缓存、步骤顺序、注释这些不碰信任的，不用审；碰到下面任何一类就要审。
 * 宁可多拦：认不准的写法让第二意见看一眼，漏拦一次放宽检查或权限就回不来（改下面的清单本身就是改合并闸，走先审后合）。
 *
 * - 权限和令牌：permissions、各权限项、secrets.、GITHUB_TOKEN、github.token、persist-credentials
 * - 触发：on、pull_request、pull_request_target、workflow_run、types、branches、paths
 * - 外来代码：uses（新增、换版本、换来源的 action）
 * - 门槛本身：卫生检查（hygiene、trusted/TRUSTED）、second-opinion、merge-gate、cold-verify、continue-on-error、
 *   `|| true`、exit 0、set +e、if: 里带 always()/failure()/cancelled()/事件名（决定检查跑不跑、红了算不算红）
 * - 汇总和依赖：check job 本身、任何 needs 行、删掉整个 job
 */
const WORKFLOW_SENSITIVE: readonly (readonly [RegExp, string])[] = [
  [
    /\bpermissions\b|\b(?:contents|actions|statuses|pull-requests|checks|id-token|packages|issues):\s*(?:read|write|none)\b/,
    '权限',
  ],
  [/secrets\.|GITHUB_TOKEN|github\.token|persist-credentials/, '令牌或密钥'],
  [
    /^\s*(?:on|push|pull_request|pull_request_target|workflow_run):|\b(?:types|branches|paths|paths-ignore):/,
    '触发条件',
  ],
  [/\buses:/, '用到的 action'],
  [/\bhygiene\b|\btrusted\b|\bTRUSTED\b|卫生检查|second-opinion|merge-gate|cold-verify/, '卫生检查或合并闸'],
  [/continue-on-error|\|\|\s*true|\bexit 0\b|set \+e/, '放过失败'],
  [/\bif:.*(?:always\(\)|failure\(\)|cancelled\(\)|github\.event_name|github\.event\.)/, '检查跑不跑的条件'],
  [
    /^\s*check:\s*$|\bneeds:|CI_NEEDS|ci-verdict|ci-plan\.ts|汇总|::error::/,
    '汇总、依赖或「该跑什么」的判法',
  ],
  [/^ {2}[\w-]+:\s*$/, '整个 job 的增删'],
];

/**
 * 工作流改动里第一处碰到信任的地方；都是不碰信任的改动回 undefined；看不到改动内容回 '看不到改动内容'。
 * 只认「+」「-」开头的行（文件头 +++/--- 不算），去掉前缀后以 # 开头的注释行不算。
 */
export function workflowSensitive(patch: string | undefined): string | undefined {
  if (patch === undefined) return '看不到改动内容';
  for (const raw of patch.split('\n')) {
    if (!/^[+-]/.test(raw) || raw.startsWith('+++') || raw.startsWith('---')) continue;
    const line = raw.slice(1);
    if (/^\s*#/.test(line)) continue;
    for (const [re, what] of WORKFLOW_SENSITIVE) {
      if (re.test(line)) return `改了${what}：${line.trim().slice(0, 50)}`;
    }
  }
  return undefined;
}

/** 改到的文件里落进清单的（改名的新旧名字都算：从高风险目录挪出去也是碰了它）。同一个文件多条规则都沾边时认最具体（路径最长）的那条。 */
export function riskyFiles(files: readonly ChangedFile[], list: readonly RiskPath[]): RiskyFile[] {
  const hits: RiskyFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    for (const name of [f.filename, ...(f.previous ? [f.previous] : [])]) {
      if (seen.has(name)) continue;
      const rule = list
        .filter((r) => (r.path.endsWith('/') ? name.startsWith(r.path) : name === r.path))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (!rule) continue;
      const hit: RiskyFile = { file: name, rule: rule.path, kind: rule.kind };
      if (rule.mode === 'workflow') {
        // 只有「改了已有的工作流」才按内容判；新加、删掉、改名一律算（整个文件都是新的信任面）
        if (f.status === 'modified' && name === f.filename) {
          const note = workflowSensitive(f.patch);
          if (note === undefined) continue;
          hit.note = note;
        } else {
          hit.note = `工作流文件${f.status === 'removed' ? '被删' : f.status === 'added' ? '是新加的' : '被改名'}`;
        }
      } else if (rule.mode === 'migrations') {
        if (name.startsWith(`${rule.path}meta/`)) continue;
        if (f.status === 'added' && name === f.filename) {
          const note = destructiveIn(f.patch);
          if (note === undefined) continue;
          hit.note = note;
        } else {
          hit.note = f.status === 'removed' ? '删了已有的迁移' : '改了已有的迁移';
        }
      }
      seen.add(name);
      hits.push(hit);
    }
  }
  return hits;
}

export type StatusState = 'success' | 'failure' | 'error' | 'pending';
const STATES: readonly string[] = ['success', 'failure', 'error', 'pending'];

export interface SecondOpinion {
  state: StatusState;
  description: string;
}

/**
 * 从「当前头的合并状态」（GET /commits/{sha}/status）里取某个 context 的那一条。second-opinion 和 cold-verify
 * 形状一样、读法一样，共用这一段：少一套就会有一条读法偷偷不一样（比如多认一个状态名）。
 *
 * 没有这一条返回 null；读回来的样子认不出返回一句为什么（调用方判没查成）。
 */
export function statusByContext(
  statuses: readonly unknown[],
  context: string,
): SecondOpinion | null | string {
  let found: SecondOpinion | null = null;
  for (const s of statuses) {
    if (!isObject(s) || typeof s.context !== 'string') return '提交状态里有一条认不出（没有 context）';
    if (s.context !== context) continue;
    if (typeof s.state !== 'string' || !STATES.includes(s.state)) {
      return `${context} 的 state「${String(s.state)}」认不出`;
    }
    if (found) continue; // 同一个 context 只该有一条；多了取第一条（GitHub 按新到旧排）
    found = {
      state: s.state as StatusState,
      description: typeof s.description === 'string' ? s.description.trim() : '',
    };
  }
  return found;
}

/**
 * 从「当前头的合并状态」（GET /commits/{sha}/status，各 context 只留最新一条）里取 second-opinion。
 * 没有这一条返回 null；读回来的样子认不出返回一句为什么（调用方判没查成）。
 */
export function secondOpinionFrom(statuses: readonly unknown[]): SecondOpinion | null | string {
  return statusByContext(statuses, SECOND_OPINION_CONTEXT);
}

/**
 * 从同一份提交状态里取冷调用（#555）写下的一条。判法和 secondOpinionFrom 一样：没有 = null（闸判「还没验」），
 * 认不出 = 一句为什么（闸判没查成，不当成没问题）。
 */
export function coldVerifyFrom(statuses: readonly unknown[]): SecondOpinion | null | string {
  return statusByContext(statuses, COLD_VERIFY_CONTEXT);
}

/** 改到的先审后合的地方，一句话列出（最多 10 个）。 */
function listHits(hits: readonly RiskyFile[]): string {
  const shown = hits.slice(0, 10).map((h) => `${h.file}（${h.kind}${h.note ? `：${h.note}` : ''}）`);
  if (hits.length > shown.length) shown.push(`另有 ${hits.length - shown.length} 个`);
  return shown.join('、');
}

/**
 * 改到先审后合的地方：当前头上要有通过的第二意见。按路径判，不看 PR 自己写的档位；旧头上的不算——调用方只拿当前头的状态来判。
 */
export function checkSecondOpinion(
  head: string,
  got: SecondOpinion | null,
  hits: readonly RiskyFile[],
): string[] {
  if (hits.length === 0) return [];
  const at = `当前头 ${head.slice(0, 7)}`;
  const where = `改到了先审后合的地方：${listHits(hits)}（清单和理由见 ${RISK_PATHS_FILE}）`;
  if (got === null) {
    return [
      `等第二意见：${at} 上还没有 ${SECOND_OPINION_CONTEXT} 状态，${where}。第二意见审完写上，合并闸自动重算；推了新提交的，旧头上的不算。`,
    ];
  }
  const why = got.description ? `：${oneLine(got.description)}` : '';
  switch (got.state) {
    case 'success':
      return [];
    case 'pending':
      return [`等第二意见：${at} 上的 ${SECOND_OPINION_CONTEXT} 还在跑（pending${why}），${where}。`];
    default:
      return [
        `第二意见没过：${at} 上的 ${SECOND_OPINION_CONTEXT} 是 ${got.state}${why}，${where}。按意见改完推上去，对新头重跑第二意见。`,
      ];
  }
}

/**
 * 这个 PR 该不该有冷调用（合前验收）的结论。`needed` 为假就是不用验。
 *
 * **范围是引擎任务工作流（#632）开的 PR，不是改到先审后合路径的 PR**：验收是三段流程的第三段，由引擎在合之前跑、把结论贴成状态；
 * 闸要保证的是「引擎的 PR 没验过就合不进去」——不论是引擎自己的顺序出了错、有人手挂了自动合并，还是兜底的对账挂了它。
 * 人手开的 PR（含碰先审后合路径的）走第二意见那一套，没有引擎替它们验，也就不能要这条状态（要了就永远卡在「还没验」）。
 * 认「引擎的 PR」靠分支名（flow-branch.ts 的 isFlowBranch）：它防的是引擎的 bug 和漏挂，不防存心绕过的人（那样的人本来就能直接合）。
 */
export interface ColdVerifyNeed {
  needed: boolean;
  /** 要验时的理由（写给人看）；不用验时是空串。 */
  why: string;
}

export function coldVerifyNeed(flowPr: boolean): ColdVerifyNeed {
  return flowPr
    ? { needed: true, why: '这是引擎任务工作流开的 PR（分支名 fleet/<单号>-t<8 位>）' }
    : { needed: false, why: '' };
}

/**
 * 验收那一遍（合前一次冷调用，#555-2）的判法。和 checkSecondOpinion 同一套三态纪律，只有两处不同：
 *
 * 1. **没有这条状态不是「没问题」**：这条 status 该由装配侧写好才轮到合并闸（规格里「读不到就明确失败」那条），
 *    闸看到的「没有」只有两种可能——装配侧压根没跑、或写了没写成。两种都不许放行，所以判红的措辞是
 *    「还没验 / 没验成」而不是第二意见那种「等它写着」。
 * 2. **error 也算没过**：GitHub 自己把状态写成 error（写的时候网络断在半路之类）时不能当通过。
 *
 * 调用方只在需要它的地方问（引擎任务工作流开的 PR，见 coldVerifyNeed）：别的 PR 不验，也就没有这条状态——那是「不用验」，
 * 不是「没验成」，所以判「要不要验」必须在调用方，不在这里。
 */
export function checkColdVerify(head: string, got: SecondOpinion | null, need: ColdVerifyNeed): string[] {
  if (!need.needed) return [];
  const at = `当前头 ${head.slice(0, 7)}`;
  const why = `${need.why}，${at} 上要有通过的 ${COLD_VERIFY_CONTEXT} 状态（specs/555：合之前一次冷调用，换家族验「单子说要的东西真做了没有」）`;
  if (got === null) {
    // 没有这条 = 没验成（不是「等它写」）：装配侧要么没跑、要么写了没写成，两种都不放行。
    return [
      `还没验：${at} 上没有 ${COLD_VERIFY_CONTEXT} 状态，${why}。冷调用那一遍跑完会把结论写上，合并闸自动重算；推了新提交的，旧头上的不算。`,
    ];
  }
  const desc = got.description ? `：${oneLine(got.description)}` : '';
  switch (got.state) {
    case 'success':
      return [];
    case 'pending':
      return [`等验收：${at} 上的 ${COLD_VERIFY_CONTEXT} 还在跑（pending${desc}），${why}。`];
    default:
      return [
        `验收没过：${at} 上的 ${COLD_VERIFY_CONTEXT} 是 ${got.state}${desc}，${why}。按它写的问题改完推上去；第 ${COLD_VERIFY_MAX_ROUND} 轮还不过就得人看（specs/555 第 3 条：默认 1 轮、最多 2 轮）。`,
      ];
  }
}

// —— 合并闸的其余几条和写回 GitHub 的提交状态 ——

/** 合并闸写在 PR 当前头上的提交状态：「按我们的规矩能不能合」的唯一信号。 */
export const GATE_CONTEXT = 'merge-gate';
/** 提交状态的 description 上限（GitHub 限 140 个字符）。 */
export const DESCRIPTION_MAX = 140;

/** description 放第一条，多的写「另有 N 条」；全文在详情链接（这次运行的日志）里。 */
export function statusDescription(lines: readonly string[]): string {
  const first = (lines[0] ?? '').replace(/\s+/g, ' ').trim();
  const more = lines.length > 1 ? `（另有 ${lines.length - 1} 条，点详情看）` : '';
  const room = DESCRIPTION_MAX - [...more].length;
  const chars = [...first];
  const head = chars.length > room ? `${chars.slice(0, room - 1).join('')}…` : first;
  return head + more;
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
