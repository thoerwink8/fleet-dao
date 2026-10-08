// 权限：agents/config/claude-permissions.json 里的 defaultMode、allow、deny、additionalDirectories 合进 ~/.claude/settings.json 的 permissions，
// 它的 autoMode（environment、allow）合进同一份设置的 autoMode——auto 模式下宽规则会被撤掉、交给分类器判，autoMode 是给分类器看的自然语言规则。
// allow、deny、additionalDirectories 按并集合并：仓里有、机器上没有的补上，机器上自己加的不删；只有 retired 里写明的才摘。
// autoMode 的两个数组同样按并集合并，但仓里的源数组必须带 "$defaults"：Claude Code 文档里那段 Danger 写明，少一个 "$defaults" 就把那一类的
// 内置规则整段换掉（force push、curl | bash、生产发布、往外发数据这些都不再拦），所以源文件不带就拒收——不是逐条补上、也不当没看见。
// defaultMode 平常归本脚本管、每次覆盖；**机器上自己设成 bypassPermissions 的例外**（创始人 2026-10-01）：保留机器上的、只报一行，不当漂移。
// 仓里的源文件写 bypassPermissions 仍然拒收：仓里那一份会装到无人值守的机器上，放行它等于把「不用问」推给每一台别人盯不到的机器。
// 设置文件读不懂（不是 JSON、整份不是对象、permissions 不是对象、autoMode 不是对象/数组不是数组）就不动，报没做成——不当成空的重写。
// 仓里的源文件读不到、不合规矩（含 bypassPermissions、autoMode 少了 "$defaults"）也报没查成、没做成，不拿空的顶上。
// 「源文件里写 bypass 拒收」和「机器上自己设的 bypass 保留」是两件事：前者是把「不用问」推给所有机器，后者是这台自己选的做法。
// 它的 env 只认 ENV_KEYS 登记的键（现在只有子代理默认模型 CLAUDE_CODE_SUBAGENT_MODEL，决定 0034）：写进同一份设置的 env，
// 仓里的值每次覆盖（同 defaultMode），机器上 env 里别的变量一个不碰；源文件少写、多写不认得的键、值不合规矩都拒收。
// 合并那套（judge、merged、checkJson、applyJson）不只给 Claude 用：Devin 的 config.json 也是 permissions.allow/deny 三个数组，
// 见 permissions-vendors.ts，翻译成它的写法后走同一套；Devin 那边没有 autoMode、env 这两层（不写就整段不管）。
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Backups } from './backup.ts';
import { readSettings } from './hooks.ts';
import { type Line, line } from './report.ts';
import { type Ctx, code, relOf, type Sources, writeAtomic } from './sync.ts';
import { PERMISSIONS_TARGET, type Place } from './targets.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * auto 模式分类器那一组（~/.claude/settings.json 的 autoMode）：environment 说什么是「自己人」，allow 是内置软拦规则的例外。
 * 数组里写的是自然语言，分类器当规则读，不是工具名/正则。同步的只有这两项：soft_deny、hard_deny（收紧）不推给所有机器，
 * classifyAllShell 也不动（改了它每条 shell 命令都过分类器，费时，是每台自己愿不愿意的事）。
 * 文档：https://code.claude.com/docs/en/auto-mode-config（哪些 scope 会读、并集怎么算、Danger 那段的原话）。
 */
export interface AutoModeSpec {
  /** 自己是谁、什么算外面（Classifier 的 environment 一档） */
  environment: string[];
  /** 内置软拦规则的例外：日常动作写在这里 */
  allow: string[];
}

/** 要合进一份 JSON 设置的那几项：defaultMode 不写就不管模式（Devin 那边文档没说清模式键在不在 config.json 里） */
export interface ListSpec {
  defaultMode?: string;
  additionalDirectories: string[];
  allow: string[];
  deny: string[];
  /** 从 allow、deny 里摘掉的（两边都摘） */
  retired: string[];
  /** 只从 deny 里摘的：放宽时把旧的拒绝撤了、同一条又放进 allow（retired 是两边都摘，这种只能用它） */
  retiredDeny?: string[];
  /** 不写就整段不管 autoMode（Devin 那份没有这一层；写了但仓里没写 autoMode 时是空的两个数组） */
  autoMode?: AutoModeSpec;
  /** 设置文件 env 里归本脚本管的几项（键 → 值）；不写就整段不管 env（Devin 那份没有这一层） */
  env?: Record<string, string>;
}

/** 仓里 agents/config/claude-permissions.json 认出来的样子：env 必须有（ENV_KEYS 里的键一个不能少） */
export interface PermSpec extends ListSpec {
  defaultMode: string;
  env: Record<string, string>;
}

/**
 * 子代理默认模型（code.claude.com/docs/en/model-config、sub-agents）：先后是 调用写的 model > 子代理定义里的 model
 * （写 inherit 就跟主会话）> 这个变量 > 主会话。所以它只兜住两头都没写的（general-purpose 就是）；Plan、fork 定义里是 inherit、
 * 照旧跟主会话（主会话可能是创始人自己选的 Fable），claude-code-guide 定义里是 haiku。决定 0034（子代理永不用 Fable 沿用 0017）。
 */
export const SUBAGENT_MODEL = 'CLAUDE_CODE_SUBAGENT_MODEL';

/**
 * 默认值只许 Opus 或 Sonnet：别名 opus、sonnet，或 claude-opus-5-5、claude-sonnet-5-5 这样的完整 id，可带 [1m]。
 * Fable、Mythos、Haiku 都不算；inherit、default 也不算（等于不设，子代理就跟主会话走）。
 * 决定 0034：子代理按性价比分三档，Haiku 5.5 只在派活时逐个显式选（读多写少、好抽查的活），不当忘了写模型时的兜底——
 * 兜底落到 Haiku，写代码的活就悄悄跑在小模型上了。
 */
export const OPUS_OR_SONNET = /^(?:opus|sonnet|claude-(?:opus|sonnet)-\d+(?:-\d+)*)(?:\[1m\])?$/;

/**
 * 同步工具管的 env 键和各自的校验（返回不合规矩的原因，合规矩返回 null）。源文件里的 env 必须正好是这几个键：
 * 少写一个、多写一个这里没登记的都拒收——env 会推给每一台机器，没登记校验的变量不许搭车。
 */
const ENV_KEYS: ReadonlyMap<string, (value: string) => string | null> = new Map([
  [
    SUBAGENT_MODEL,
    (value: string) =>
      OPUS_OR_SONNET.test(value)
        ? null
        : `env.${SUBAGENT_MODEL} 是「${value}」：子代理默认模型只许 Opus 或 Sonnet（决定 0034；派活时可显式用 Haiku 5.5，但它不当默认），只认 opus、sonnet 或 claude-opus-…、claude-sonnet-… 这样的 id，拒收`,
  ],
]);

/**
 * 仓里的源文件里不许写的模式：一台机器上的会话全放开检查，不能靠仓里一份文件推给所有机器。
 * 这是「源文件拒收」、不是「机器上不许有」：机器上自己设成 bypassPermissions 的由下面的 KEEP_AS_IS 保留。
 */
const FORBIDDEN_MODES = ['bypassPermissions'];

/** 机器上自己设的、本脚本不改也不当漂移的模式：创始人 2026-10-01「我一般都是开启 bypass 模式的……不希望拦」 */
const KEEP_AS_IS = ['bypassPermissions'];

/** 少了它，Claude Code 会把那一类的内置规则整段换掉；文档 Danger 那段点名的是软拦和防外传的规则 */
const DEFAULTS = '$defaults';

/** autoMode 里同步的两项，数组顺序就是这里的顺序 */
const AUTO_LISTS = ['environment', 'allow'] as const;

export type PermSource = { ok: true; value: PermSpec } | { ok: false; why: string };

function strings(v: unknown, name: string): string[] | string {
  if (!Array.isArray(v)) return `${name} 不是数组`;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || x.trim() === '') return `${name} 里有不是非空字符串的项`;
    if (out.includes(x)) return `${name} 里「${x}」写了两遍`;
    out.push(x);
  }
  return out;
}

/**
 * 认 autoMode：可以有，可以没有（没有就整段不管）。有就必须是一个对象、两个数组都合规矩、都带 "$defaults"。
 * 少了 "$defaults" 是拒收而不是替你补上：补上了源文件本身还是错的，下一个人照它改、范围就在他手里悄悄变了。
 * 也拒绝只有 "$defaults" 的空壳。多出来的键（soft_deny、hard_deny、classifyAllShell）照旧：本脚本不写它们，机器上原有的也不动。
 */
function parseAutoMode(v: unknown): AutoModeSpec | string | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) return 'autoMode 不是对象';
  const out: AutoModeSpec = { environment: [], allow: [] };
  for (const name of AUTO_LISTS) {
    const raw = v[name];
    if (raw === undefined) return `autoMode.${name} 没写（两项都要，且都要带 "${DEFAULTS}"）`;
    const got = strings(raw, `autoMode.${name}`);
    if (typeof got === 'string') return got;
    if (!got.includes(DEFAULTS))
      return `autoMode.${name} 里没有 "${DEFAULTS}"：没它 Claude Code 会把这一类的内置规则整段换掉（强推、curl | bash、生产发布、往外发数据这些就不再拦），拒收`;
    if (got.length < 2)
      return `autoMode.${name} 里只有 "${DEFAULTS}"、没有自己的规则：要么写一条，要么整段不写`;
    out[name] = got;
  }
  return out;
}

/**
 * 认 env：必须有，必须正好是 ENV_KEYS 登记的那几个键、值都过各自的校验。
 * 少了子代理默认模型就拒收、不替它补上（同 autoMode 少 "$defaults"）：不写子代理就跟主会话走，主会话可能是 Fable。
 */
function parseEnv(v: unknown): Record<string, string> | string {
  const need = [...ENV_KEYS.keys()].join('、');
  if (v === undefined) return `env 没写：${need} 要写（子代理默认模型只许 Opus 或 Sonnet，决定 0034）`;
  if (!isObj(v)) return 'env 不是对象';
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v)) {
    const check = ENV_KEYS.get(key);
    if (check === undefined)
      return `env.${key} 同步工具不认：env 会推给每一台机器，要加先在 permissions.ts 的 ENV_KEYS 里登记它的校验`;
    if (typeof value !== 'string') return `env.${key} 不是字符串`;
    const bad = check(value);
    if (bad !== null) return bad;
    out[key] = value;
  }
  for (const key of ENV_KEYS.keys())
    if (!(key in out))
      return `env.${key} 没写：不写子代理就跟主会话同一个模型，主会话可能是 Fable（子代理永不用 Fable，决定 0017、0034），拒收`;
  return out;
}

/** 认仓里的源文件；home 用来展开 ${HOME}（换成这台的家目录，路径分隔符按这台的平台） */
export function parsePermissions(text: string, home: string): PermSource {
  let root: unknown;
  try {
    root = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    return { ok: false, why: `不是合法的 JSON（${(err as Error).message}）` };
  }
  if (!isObj(root)) return { ok: false, why: '整份不是一个 JSON 对象' };
  const mode = root.defaultMode;
  if (typeof mode !== 'string' || mode === '') return { ok: false, why: 'defaultMode 没写或不是字符串' };
  if (FORBIDDEN_MODES.includes(mode)) return { ok: false, why: `defaultMode 不许写 ${mode}` };
  const lists: Record<string, string[]> = {};
  for (const name of ['additionalDirectories', 'allow', 'deny', 'retired']) {
    const got = strings(root[name], name);
    if (typeof got === 'string') return { ok: false, why: got };
    lists[name] = got;
  }
  // retiredDeny 可以不写
  const gotDeny = root.retiredDeny === undefined ? [] : strings(root.retiredDeny, 'retiredDeny');
  if (typeof gotDeny === 'string') return { ok: false, why: gotDeny };
  const auto = parseAutoMode(root.autoMode);
  if (typeof auto === 'string') return { ok: false, why: auto };
  const env = parseEnv(root.env);
  if (typeof env === 'string') return { ok: false, why: env };
  const allow = lists.allow as string[];
  const deny = lists.deny as string[];
  const retired = lists.retired as string[];
  const both = allow.find((a) => deny.includes(a));
  if (both) return { ok: false, why: `「${both}」同时在 allow 和 deny 里` };
  const gone = retired.find((r) => allow.includes(r) || deny.includes(r));
  if (gone) return { ok: false, why: `「${gone}」既在 retired 里、又还在 allow 或 deny 里` };
  const goneDeny = gotDeny.find((r) => deny.includes(r));
  if (goneDeny) return { ok: false, why: `「${goneDeny}」既在 retiredDeny 里、又还在 deny 里` };
  const dirs = (lists.additionalDirectories as string[]).map((d) =>
    d.startsWith('${HOME}') ? join(home, d.slice('${HOME}'.length)) : d,
  );
  return {
    ok: true,
    value: {
      defaultMode: mode,
      additionalDirectories: dirs,
      allow,
      deny,
      retired,
      retiredDeny: gotDeny,
      ...(auto === undefined ? {} : { autoMode: auto }),
      env,
    },
  };
}

/** 机器上 permissions 一处和源文件对不上的地方 */
export interface Diff {
  /** 该有、没有的（defaultMode 没写也算） */
  missing: string[];
  /** 读到了但要改的：已退役的还留着、defaultMode 不一样（机器上自己设成 bypassPermissions 的除外） */
  drift: string[];
  /** 本脚本不替人定的：allow 和 deny 相反、类型不对 */
  stuck: string[];
  /** 机器上自己加的、不归本脚本管的条数 */
  others: number;
  /** 机器上自己设成 bypassPermissions：本脚本保留、不改也不当漂移，只报一行 */
  bypass: boolean;
}

const LISTS = ['allow', 'deny', 'additionalDirectories'] as const;

/** 报告里带一句规则原文会很长：截短，够认出是哪条 */
function short(s: string): string {
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}

/**
 * 机器上 autoMode 那一层和源文件对不上的地方。
 * 机器上的数组带了 "$defaults" 才算数：不带就是那一类的内置规则已经被整段换掉了，这是没有源文件也认得出的漂移，单独报。
 */
function judgeAuto(have: unknown, spec: AutoModeSpec, out: Diff): void {
  if (have !== undefined && !isObj(have)) {
    out.stuck.push('autoMode 不是对象');
    return;
  }
  const am: Obj = have ?? {};
  for (const name of AUTO_LISTS) {
    const cur = am[name];
    if (cur !== undefined && !Array.isArray(cur)) {
      out.stuck.push(`autoMode.${name} 不是数组`);
      continue;
    }
    const list: unknown[] = cur ?? [];
    const want = spec[name];
    const missing = want.filter((w) => !list.includes(w));
    if (missing.length)
      out.missing.push(`autoMode.${name} 少 ${missing.length} 条（${missing.map(short).join('、')}）`);
    // 机器上那一档也在、却没有 "$defaults"：内置规则已经被换掉了（这一档是不是本脚本写的无从判断，只报不动）
    if (list.length > 0 && !list.includes(DEFAULTS))
      out.stuck.push(`autoMode.${name} 里没有 "${DEFAULTS}"：这一类的内置规则不生效，要人看`);
    out.others += list.filter((x) => !want.includes(x as string)).length;
  }
}

/**
 * 机器上 env 那一层和源文件对不上的地方：仓里写的那几项每次覆盖（同 defaultMode），env 里别的变量不归本脚本管、一个不碰、也不计数。
 * 机器上的值不一样（哪怕也是 Opus 或 Sonnet）算漂移、改回仓里的：子代理默认模型是全队一个规矩，要改先改仓里。
 */
function judgeEnv(have: unknown, spec: Record<string, string>, out: Diff): void {
  if (have !== undefined && !isObj(have)) {
    out.stuck.push('env 不是对象');
    return;
  }
  const env: Obj = have ?? {};
  for (const [key, want] of Object.entries(spec)) {
    if (env[key] === undefined) out.missing.push(`env.${key}（该是 ${want}）`);
    else if (env[key] !== want) out.drift.push(`env.${key} 是 ${JSON.stringify(env[key])}，该是 ${want}`);
  }
}

/** 逐项对：root 是整份设置文件 */
export function judge(root: unknown, spec: ListSpec): Diff {
  const out: Diff = { missing: [], drift: [], stuck: [], others: 0, bypass: false };
  if (!isObj(root)) {
    out.stuck.push('整份不是一个 JSON 对象');
    return out;
  }
  const have = root.permissions;
  if (have !== undefined && !isObj(have)) {
    out.stuck.push('permissions 不是对象');
    return out;
  }
  const perm: Obj = have ?? {};
  if (spec.defaultMode !== undefined) {
    if (perm.defaultMode === undefined) out.missing.push(`defaultMode（该是 ${spec.defaultMode}）`);
    // 机器上自己设成 bypassPermissions：这台的人主动要的，保留、不当漂移，只让报告多提一句
    else if (KEEP_AS_IS.includes(perm.defaultMode as string)) out.bypass = true;
    else if (perm.defaultMode !== spec.defaultMode)
      out.drift.push(`defaultMode 是 ${JSON.stringify(perm.defaultMode)}，该是 ${spec.defaultMode}`);
  }
  for (const name of LISTS) {
    const cur = perm[name];
    if (cur !== undefined && !Array.isArray(cur)) {
      out.stuck.push(`${name} 不是数组`);
      continue;
    }
    const list: unknown[] = cur ?? [];
    const want = spec[name];
    const missing = want.filter((w) => !list.includes(w));
    if (missing.length) out.missing.push(`${name} 少 ${missing.length} 条（${missing.join('、')}）`);
    const gone = [...spec.retired, ...(name === 'deny' ? (spec.retiredDeny ?? []) : [])];
    const retired = list.filter((x): x is string => typeof x === 'string' && gone.includes(x));
    if (name !== 'additionalDirectories' && retired.length)
      out.drift.push(`${name} 还留着已退役的 ${retired.join('、')}`);
    // 相反的一边：allow 里出现仓里要 deny 的，或反过来（要摘掉的不算：它们这次就被摘了）
    const opposite = name === 'allow' ? spec.deny : name === 'deny' ? spec.allow : [];
    const clash = list.filter(
      (x): x is string => typeof x === 'string' && opposite.includes(x) && !gone.includes(x),
    );
    if (clash.length)
      out.stuck.push(`${name} 里有仓里放在另一边的 ${clash.join('、')}（allow 和 deny 相反）`);
    out.others += list.filter((x) => !want.includes(x as string) && !gone.includes(x as string)).length;
  }
  if (spec.autoMode !== undefined) judgeAuto(root.autoMode, spec.autoMode, out);
  if (spec.env !== undefined) judgeEnv(root.env, spec.env, out);
  return out;
}

/** 去掉已退役的、补上仓里有而机器上没有的；别的一条不碰；机器上自己设成 bypassPermissions 的 defaultMode 也不碰 */
export function merged(root: Obj, spec: ListSpec): Obj {
  const next = structuredClone(root);
  const perm: Obj = isObj(next.permissions) ? next.permissions : {};
  // 机器上自己设成 bypassPermissions：保留机器上的那个值，仓里写的是 auto 也不覆盖（创始人 2026-10-01）
  if (spec.defaultMode !== undefined && !KEEP_AS_IS.includes(perm.defaultMode as string))
    perm.defaultMode = spec.defaultMode;
  for (const name of LISTS) {
    // 仓里这项是空的、机器上也没有：不凭空建一个空数组
    if (spec[name].length === 0 && !Array.isArray(perm[name])) continue;
    const list: unknown[] = Array.isArray(perm[name]) ? (perm[name] as unknown[]) : [];
    const gone = [...spec.retired, ...(name === 'deny' ? (spec.retiredDeny ?? []) : [])];
    const kept = name === 'additionalDirectories' ? list : list.filter((x) => !gone.includes(x as string));
    for (const w of spec[name]) if (!kept.includes(w)) kept.push(w);
    perm[name] = kept;
  }
  next.permissions = perm;
  if (spec.autoMode !== undefined) {
    const am: Obj = isObj(next.autoMode) ? next.autoMode : {};
    // 机器上别的档（soft_deny、hard_deny、classifyAllShell）一个不碰，只并这两档
    for (const name of AUTO_LISTS) {
      const list: unknown[] = Array.isArray(am[name]) ? (am[name] as unknown[]) : [];
      for (const w of spec.autoMode[name]) if (!list.includes(w)) list.push(w);
      am[name] = list;
    }
    next.autoMode = am;
  }
  if (spec.env !== undefined) {
    // env 里别的变量（代理、各家自己的开关）一个不碰，只写仓里那几项
    const env: Obj = isObj(next.env) ? next.env : {};
    for (const [key, value] of Object.entries(spec.env)) env[key] = value;
    next.env = env;
  }
  return next;
}

/** 报告里补的一句：机器上自己设成 bypassPermissions，本脚本保留它（ok 和 changed 两条路都带） */
const bypassNote = (d: Diff): string => (d.bypass ? '；这台自己设成 bypassPermissions，保留、没改' : '');

/** 一致时报出 env 里那几项的值（子代理默认模型是哪个，看报告就知道） */
const envNote = (spec: ListSpec): string =>
  spec.env === undefined
    ? ''
    : `，${Object.entries(spec.env)
        .map(([key, value]) => `env.${key} 是 ${value}`)
        .join('、')}`;

/** 查一份 JSON 设置里的 permissions；key 是报告里这一项的名字，noFile 是文件不存在时说的话 */
export function checkJson(abs: string, key: string, spec: ListSpec, noFile: string): Line[] {
  let read: ReturnType<typeof readSettings>;
  try {
    read = readSettings(abs);
  } catch (err) {
    return [line('unknown', key, `没查成——读不了（${code(err)}）`)];
  }
  if (read.kind === 'none') return [line('missing', key, `缺失——没有这个文件，${noFile}`)];
  if (read.kind === 'bad') return [line('drift', key, `漂移——${read.why}，权限等于没装`)];
  const d = judge(read.root, spec);
  const bad = [...d.stuck, ...d.drift];
  if (bad.length) return [line('drift', key, `漂移——${bad.join('；')}${bypassNote(d)}`)];
  if (d.missing.length) return [line('missing', key, `缺失——${d.missing.join('；')}${bypassNote(d)}`)];
  return [
    line(
      'ok',
      key,
      `${spec.defaultMode === undefined ? '' : `defaultMode ${spec.defaultMode}、`}allow ${spec.allow.length} 条、deny ${spec.deny.length} 条都在${spec.autoMode === undefined ? '' : `、autoMode ${AUTO_LISTS.map((n) => `${n} ${spec.autoMode?.[n].length ?? 0} 条`).join('、')}都在`}${envNote(spec)}，机器上自己加的 ${d.others} 条没动${bypassNote(d)}`,
    ),
  ];
}

/** 写一份 JSON 设置里的 permissions：补缺、摘退役的，别的不碰；读不懂、相反的整份不动 */
export function applyJson(ctx: Ctx, place: Place, key: string, spec: ListSpec, backups: Backups): Line[] {
  const { rel, abs } = relOf(ctx, place);
  try {
    const read = readSettings(abs);
    if (read.kind === 'bad') return [line('failed', key, `没动——${read.why}；要人看`)];
    const root: unknown = read.kind === 'none' ? {} : read.root;
    const before = judge(root, spec);
    if (before.stuck.length)
      return [line('failed', key, `没动——${before.stuck.join('；')}；要人看${bypassNote(before)}`)];
    if (before.missing.length === 0 && before.drift.length === 0)
      return [line('ok', key, `已经一致，机器上自己加的 ${before.others} 条没动${bypassNote(before)}`)];
    const next = merged(root as Obj, spec);
    const eol = read.kind === 'ok' && read.text.includes('\r\n') ? '\r\n' : '\n';
    const text = `${JSON.stringify(next, null, 2)}\n`.replaceAll('\n', eol);
    const saved = read.kind === 'ok' ? backups.saveFile(abs, rel.replaceAll('\\', '/')) : undefined;
    mkdirSync(dirname(abs), { recursive: true });
    writeAtomic(abs, text, undefined);
    const parts = [
      read.kind === 'none' ? '新建' : '改了',
      [...before.missing, ...before.drift].join('；'),
      `机器上自己加的 ${before.others} 条没动`,
      ...(before.bypass ? ['这台自己设成 bypassPermissions，保留、没改'] : []),
      ...(saved ? [`原文件备份在 ${saved}`] : []),
    ];
    return [line('changed', key, parts.join('，'))];
  } catch (err) {
    return [line('failed', key, `没做成——${code(err)}`)];
  }
}

const KEY = (ctx: Ctx): string => `${relOf(ctx, PERMISSIONS_TARGET.settings).key}#permissions`;

/** 这台有没有装读它的那家 */
const wanted = (ctx: Ctx): boolean => PERMISSIONS_TARGET.readers.some((r) => ctx.installed.has(r));

/** 这次整段不写的原因（--user 替别的用户写时给），不写就只报一行 skip */
export type PermSkip = string;

/** 仓里的源文件认出来；读不到或不合规矩就是没认成，说清为什么 */
export function permissionSource(ctx: Ctx, src: Sources): PermSource {
  if (!src.permissions.ok) return src.permissions;
  return parsePermissions(src.permissions.text, ctx.home);
}

export function checkPermissions(ctx: Ctx, src: Sources, skip?: PermSkip): Line[] {
  const key = KEY(ctx);
  if (skip) return [line('skip', key, skip)];
  if (!wanted(ctx)) return [line('skip', key, '没装 Claude Code，跳过')];
  const spec = permissionSource(ctx, src);
  if (!spec.ok)
    return [line('unknown', key, `没查成——仓里的 agents/config/claude-permissions.json：${spec.why}`)];
  return checkJson(
    relOf(ctx, PERMISSIONS_TARGET.settings).abs,
    key,
    spec.value,
    '权限（defaultMode、allow、deny、autoMode）和子代理默认模型（env）没装',
  );
}

export function applyPermissions(ctx: Ctx, src: Sources, backups: Backups, skip?: PermSkip): Line[] {
  const key = KEY(ctx);
  if (skip) return [line('skip', key, skip)];
  if (!wanted(ctx)) return [line('skip', key, '没装 Claude Code，跳过')];
  const spec = permissionSource(ctx, src);
  if (!spec.ok)
    return [line('failed', key, `没做成——仓里的 agents/config/claude-permissions.json：${spec.why}`)];
  return applyJson(ctx, PERMISSIONS_TARGET.settings, key, spec.value, backups);
}
