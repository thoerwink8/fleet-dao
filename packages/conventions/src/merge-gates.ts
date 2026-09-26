// 合并闸的判法（design 第五节「流程只为快」，#74）：改到的文件碰没碰先审后合的三种路径、碰了的当前头上有没有通过的第二意见，
// 草稿、冲突的说法；PR 正文的档位只做提醒（parseTier 给 pr-fields 用）。纯判断，不碰网络；读写 GitHub 的在 merge-gate.ts。
// 三态纪律：读不到、认不出由调用方判「没查成」（退出码 2），不当成「没问题」。

/** 两档（design 第五节「流程只为快」）；后两个是 2026-09-26 之前的三档叫法，照样认。 */
export const TIERS = ['CI 绿就合', '先审后合', '直接合', '先合后看'] as const;
export type Tier = (typeof TIERS)[number];
/** 要第二意见通过才能合的那一档。 */
export const REVIEW_TIER: Tier = '先审后合';
export const TIER_COLUMN = '档位';
/** 本机垫片（将来是引擎）审完写在 PR 当前头上的提交状态。 */
export const SECOND_OPINION_CONTEXT = 'second-opinion';
/** 高风险路径清单在仓里的位置（design 第五节「路径规则放每个仓的配置」）。 */
export const RISK_PATHS_FILE = 'packages/conventions/high-risk-paths.json';

const TIER_LIST = TIERS.slice(0, 2)
  .map((t) => `「${t}」`)
  .join('');

/** 先审后合只有这三种（design 第五节：删改迁移、部署生产、密钥鉴权含 CI 工作流和卫生检查）。 */
export const RISK_KINDS = ['改数据库', '动生产', '碰安全'] as const;
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
  mode?: 'migrations';
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
    if (item.mode !== undefined && (item.mode !== 'migrations' || !path.endsWith('/'))) {
      return `${at}（${path}）的 mode 认不出（只有目录能写 "migrations"）`;
    }
    out.push({
      path,
      kind: item.kind as RiskKind,
      why: item.why.trim(),
      ...(item.mode === 'migrations' ? { mode: 'migrations' as const } : {}),
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
 * 新迁移里只放行明确是「只加不改」的语句：建表、建索引、建类型、建或替换函数和触发器、重建触发器前的 DROP TRIGGER IF EXISTS、
 * 插数据、写注释、给枚举加值、ALTER TABLE 里只有 ADD COLUMN / ADD CONSTRAINT 这类动作。别的一律算删改（宁可多拦：
 * 认不准的写法由第二意见看一眼，漏拦一次删数据就回不来）。按整段 SQL 分语句判，语句跨几行都一样。
 */
const ADDITIVE = [
  /^CREATE (UNIQUE )?INDEX\b/,
  /^CREATE TABLE\b/,
  /^CREATE TYPE\b/,
  /^CREATE (OR REPLACE )?(FUNCTION|TRIGGER|VIEW)\b/,
  /^CREATE (SEQUENCE|EXTENSION|SCHEMA)\b/,
  /^DROP TRIGGER IF EXISTS\b/,
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

/** 改到的文件里落进清单的（改名的新旧名字都算：从高风险目录挪出去也是碰了它）。 */
export function riskyFiles(files: readonly ChangedFile[], list: readonly RiskPath[]): RiskyFile[] {
  const hits: RiskyFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    for (const name of [f.filename, ...(f.previous ? [f.previous] : [])]) {
      if (seen.has(name)) continue;
      const rule = list.find((r) => (r.path.endsWith('/') ? name.startsWith(r.path) : name === r.path));
      if (!rule) continue;
      const hit: RiskyFile = { file: name, rule: rule.path, kind: rule.kind };
      if (rule.mode === 'migrations') {
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

export type TierRead = { tier: Tier } | { problem: string };

/** 「档位」一栏：开头是三档之一，后面跟理由（design：档位和理由写进 PR 正文）。 */
export function parseTier(value: string | undefined): TierRead {
  if (value === undefined) {
    return {
      problem: `正文里认不出「档位」一栏：要写成 档位：CI 绿就合——理由（单独起一行；两档是${TIER_LIST}，见 design 第五节，拿不准写「先审后合」）。`,
    };
  }
  const v = value.replace(/`|\*\*/g, '').trim();
  if (!v) return { problem: `「档位」一栏是空的：写${TIER_LIST}之一，后面跟理由（拿不准写「先审后合」）。` };
  const tier = TIERS.find((t) => v.startsWith(t));
  if (!tier) {
    return { problem: `「档位」写的「${oneLine(v)}」认不出：开头写${TIER_LIST}之一，后面跟理由。` };
  }
  const reason = v.slice(tier.length).replace(/[\s\-—–:：,，;；.。、()（）[\]【】]/g, '');
  if (!reason) {
    return {
      problem: `「档位」只写了「${tier}」没写理由：后面跟一句为什么是这一档，比如 ${tier}——只改测试。`,
    };
  }
  return { tier };
}

export type StatusState = 'success' | 'failure' | 'error' | 'pending';
const STATES: readonly string[] = ['success', 'failure', 'error', 'pending'];

export interface SecondOpinion {
  state: StatusState;
  description: string;
}

/**
 * 从「当前头的合并状态」（GET /commits/{sha}/status，各 context 只留最新一条）里取 second-opinion。
 * 没有这一条返回 null；读回来的样子认不出返回一句为什么（调用方判没查成）。
 */
export function secondOpinionFrom(statuses: readonly unknown[]): SecondOpinion | null | string {
  let found: SecondOpinion | null = null;
  for (const s of statuses) {
    if (!isObject(s) || typeof s.context !== 'string') return '提交状态里有一条认不出（没有 context）';
    if (s.context !== SECOND_OPINION_CONTEXT) continue;
    if (typeof s.state !== 'string' || !STATES.includes(s.state)) {
      return `${SECOND_OPINION_CONTEXT} 的 state「${String(s.state)}」认不出`;
    }
    if (found) continue; // 同一个 context 只该有一条；多了取第一条（GitHub 按新到旧排）
    found = {
      state: s.state as StatusState,
      description: typeof s.description === 'string' ? s.description.trim() : '',
    };
  }
  return found;
}

/** 改到的先审后合的地方，一句话列出（最多 10 个）。 */
function listHits(hits: readonly RiskyFile[]): string {
  const shown = hits.slice(0, 10).map((h) => `${h.file}（${h.kind}${h.note ? `：${h.note}` : ''}）`);
  if (hits.length > shown.length) shown.push(`另有 ${hits.length - shown.length} 个`);
  return shown.join('、');
}

/**
 * 改到先审后合的三种地方：当前头上要有通过的第二意见。按路径判，不看 PR 自己写的档位；旧头上的不算——调用方只拿当前头的状态来判。
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

// —— 合并闸的其余几条和写回 GitHub 的提交状态 ——

/** 合并闸写在 PR 当前头上的提交状态：「按我们的规矩能不能合」的唯一信号。 */
export const GATE_CONTEXT = 'merge-gate';
export const DRAFT_PROBLEM = '是草稿：做完了点「Ready for review」，合并闸会自动重算。';
export const CONFLICT_PROBLEM =
  '和主线有冲突，合不进去：把最新主线合进来（或 rebase）解掉冲突再推，合并闸会自动重算。';
export const MERGEABLE_UNKNOWN =
  'GitHub 还没算完和主线有没有冲突：过一会儿再算（再推一次、改一下正文，或在 Actions 里手动跑 merge-gate）。';

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
