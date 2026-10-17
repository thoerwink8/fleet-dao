// 钩子：agents/hooks/ 下的脚本整份拷进 ~/.fleet-dao/hooks/，再在各家的设置文件里登记（targets.ts 的 HOOK_TARGETS，写法见 HookFormat）。
// Codex 的钩子还要信任了才跑：登记完替本脚本那几条记上信任（hooks-codex.ts）。
// 设置文件里只动本脚本管的那几条：命令指向 ~/.fleet-dao/hooks/ 下的脚本，或者以前手装在 fleet-guard 目录的两条（接管时换掉）。
// 别的钩子、别的设置一条不碰；设置文件读不懂（不是 JSON、整份不是对象、hooks 不是对象）就不动，报没做成——不当成空的重写。
// 决定 0083：用户级不再给每个仓登记过程钩子。决定 0085：用户级只多一个订阅加载器（plugin-loader.mjs）。
// 这里不再列出的登记，下次同步摘掉。
// 调工具前那条照装：法国会话用户家里就有 reclaude 的设备密钥，借道读这份设置的 Grok、Cursor 起的会话也要拦。
// HookSkip 仍可按事件名少登记一类（调用方传入）。
import { existsSync, mkdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Backups } from './backup.ts';
import { applyCodexTrust, checkCodexTrust, trustKey, trustNeeds } from './hooks-codex.ts';
import { applyKimiHooks, checkKimiHooks, kimiKey } from './hooks-kimi.ts';
import { bareQuietCommand, guiSubsystem, quietExeBytes, quietExeName, replaceExe } from './quiet-win.ts';
import { type Line, line } from './report.ts';
import { type Ctx, code, lstatOrNull, relOf, type Sources, writeAtomic } from './sync.ts';
import {
  AGENTS,
  agentNames,
  HOOK_GAPS,
  HOOK_TARGETS,
  HOOKS_DIR,
  type HookSpec,
  type HookTarget,
  MIRASIM_CODEX_HOMES,
  type Place,
  type Platform,
  placeOn,
  slashed,
} from './targets.ts';
import { linkTarget, readTree, removeEntry, sameTree, treeDiff, writeTree } from './tree.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 设置里登记的命令。Linux：node 加脚本绝对路径（一律 / 分隔、加引号，bash 认）。
 * Windows：家目录路径没有 shell 元字符时，改成 ~/.fleet-dao/bin/quiet-<脚本名>.exe 这一个路径、不加引号。
 * Grok 对这种路径直接 CreateProcess，不再套 cmd（套 cmd 就会闪黑窗口）。有元字符时退回 node 加引号。
 */
export function hookCommand(home: string, platform: Platform, script: string, nodeOnWindows = false): string {
  const nodeCmd = `node "${join(home, placeOn(HOOKS_DIR, platform), script).replaceAll('\\', '/')}"`;
  if (platform !== 'win32' || nodeOnWindows) return nodeCmd;
  return bareQuietCommand(home, script) ?? nodeCmd;
}

/** 这个目标里登记的命令（targets.ts 的 nodeOnWindows：那家在 Windows 上用 PowerShell 跑钩子，不用启动器） */
export function commandIn(t: HookTarget, home: string, platform: Platform, script: string): string {
  return hookCommand(home, platform, script, t.nodeOnWindows === true);
}

/**
 * 这家自己的开关把本脚本的钩子关了：返回为什么，没关返回 null。不是本脚本关的，不替人打开，报出来要人看。
 * - claude：顶层 disableAllHooks。
 * - gemini：hooksConfig.enabled 是 false（全关），或 hooksConfig.disabled 里列了本脚本的命令（那几条不跑；
 *   Gemini CLI 按名字认，没起名字的钩子名字就是命令）。
 */
function switchedOff(root: Obj, t: HookTarget, home: string, platform: Platform): string | null {
  if (t.format === 'claude')
    return root.disableAllHooks === true ? 'disableAllHooks 开着、钩子一条都不跑' : null;
  if (t.format === 'agy') {
    const box = root[agyName(t)];
    return isObj(box) && box.enabled === false
      ? `${agyName(t)} 那一项的 enabled 是 false、本脚本的钩子不跑`
      : null;
  }
  if (t.format !== 'gemini') return null;
  const cfg = isObj(root.hooksConfig) ? root.hooksConfig : {};
  if (cfg.enabled === false) return 'hooksConfig.enabled 是 false、钩子一条都不跑';
  const ours = new Set(t.hooks.map((h) => commandIn(t, home, platform, h.script)));
  const disabled: unknown[] = Array.isArray(cfg.disabled) ? cfg.disabled : [];
  const listed = disabled.filter((x) => typeof x === 'string' && ours.has(x));
  return listed.length ? `hooksConfig.disabled 里列了本脚本的 ${listed.length} 条、那几条不跑` : null;
}

/** agy 写法里本脚本那一项的名字 */
const agyName = (t: HookTarget): string => t.name ?? 'fleet-dao';

/**
 * 事件挂在哪个对象下：agy 写法是名字叫 agyName 的那一项，别的写法是 hooks。
 * others：agy 写法里别的项（别人的钩子，本脚本只认出里面有没有自己的命令）。
 */
function boxes(root: Obj, t: HookTarget): { box: unknown; boxName: string; others: Obj[] } {
  if (t.format !== 'agy') return { box: root.hooks, boxName: 'hooks', others: [] };
  const name = agyName(t);
  const others = Object.entries(root)
    .filter(([k, v]) => k !== name && isObj(v))
    .map(([, v]) => v as Obj);
  return { box: root[name], boxName: `${name} 那一项`, others };
}

/** 这条命令是不是本脚本管的：返回它跑的脚本名、是不是以前手装的那份；不是就返回 null */
export function ownedScript(command: unknown): { script: string; legacy: boolean } | null {
  if (typeof command !== 'string') return null;
  const c = command.replaceAll('\\', '/');
  const now = /\/\.fleet-dao\/hooks\/([\w.-]+\.mjs)(?![\w.-])/.exec(c);
  if (now?.[1]) return { script: now[1], legacy: false };
  // quiet-session-start.exe → session-start.mjs。认这个，标准不再登记的流程钩子下次同步才会摘掉，而不是当成别人的钩子留着
  const quiet = /\/\.fleet-dao\/bin\/quiet-([\w.-]+)\.exe(?![\w.-])/.exec(c);
  if (quiet?.[1]) return { script: `${quiet[1]}.mjs`, legacy: false };
  const old = /\/fleet-guard\/(session-start|pretool)\.mjs(?![\w.-])/.exec(c);
  if (old?.[1]) return { script: `${old[1]}.mjs`, legacy: true };
  return null;
}

interface Found {
  event: string;
  matcher: unknown;
  handler: Obj;
  script: string;
  legacy: boolean;
}

/** hooks 里本脚本管的每一条，外加不归它管的有几条 */
function scan(hooks: Obj): { owned: Found[]; others: number } {
  const owned: Found[] = [];
  let others = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isObj(group) || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        const mine = isObj(handler) ? ownedHandler(handler) : null;
        if (mine && isObj(handler)) owned.push({ event, matcher: group.matcher, handler, ...mine });
        else others++;
      }
    }
  }
  return { owned, others };
}

const sameMatcher = (have: unknown, want: string | undefined): boolean =>
  want === undefined ? have === undefined || have === '' : have === want;

/** 报出来的名字：事件（脚本，matcher） */
const specName = (h: HookSpec): string =>
  `${h.event}（${h.script}${h.matcher === undefined ? '' : `，matcher ${h.matcher}`}）`;

interface Judged {
  /** 一条都没登记的事件（脚本名） */
  missing: string[];
  problems: string[];
  /** 这家自己的开关把钩子关了（switchedOff） */
  off: string | null;
  others: number;
  legacy: number;
}

function judge(root: unknown, t: HookTarget, home: string, platform: Platform): Judged {
  const out: Judged = { missing: [], problems: [], off: null, others: 0, legacy: 0 };
  if (!isObj(root)) {
    out.problems.push('整份不是一个 JSON 对象');
    return out;
  }
  out.off = switchedOff(root, t, home, platform);
  const { box, boxName, others: elsewhere } = boxes(root, t);
  for (const other of elsewhere) {
    const s = scan(other);
    out.others += s.others;
    for (const f of s.owned)
      out.problems.push(`别的钩子项里也登记着本脚本的 ${f.script}（挂在 ${f.event} 上）`);
  }
  if (box === undefined) {
    out.missing.push(...t.hooks.map(specName));
    return out;
  }
  if (!isObj(box)) {
    out.problems.push(`${boxName} 不是对象`);
    return out;
  }
  const { owned, others } = scan(box);
  out.others += others;
  // 同一个脚本可以按不同的 matcher 登记几条（调工具前那条：Claude 的工具名一组、Devin 的一组），按事件加 matcher 对号
  const claimed = new Set<Found>();
  for (const spec of t.hooks) {
    const mine = owned.filter(
      (f) =>
        !f.legacy &&
        f.script === spec.script &&
        f.event === spec.event &&
        sameMatcher(f.matcher, spec.matcher),
    );
    if (mine.length === 0) {
      out.missing.push(specName(spec));
      continue;
    }
    for (const f of mine) claimed.add(f);
    if (mine.length > 1) out.problems.push(`${spec.script} 登记了 ${mine.length} 次（${specName(spec)}）`);
    const f = mine[0] as Found;
    const wrong: string[] = [];
    const want = handlerFor(t, spec, home, platform);
    if (f.handler.type !== 'command') wrong.push('type 不是 command');
    if (f.handler.command !== want.command) wrong.push('命令和本机该有的不一样');
    if (f.handler.timeout !== spec.timeout)
      wrong.push(`timeout 是 ${String(f.handler.timeout)}，应是 ${spec.timeout}`);
    if (JSON.stringify(f.handler.args) !== JSON.stringify(want.args))
      wrong.push(
        `args 是 ${JSON.stringify(f.handler.args ?? null)}，应是 ${JSON.stringify(want.args ?? null)}`,
      );
    if (f.handler.onFailure !== want.onFailure)
      wrong.push(`onFailure 是 ${String(f.handler.onFailure)}，应是 ${String(want.onFailure)}`);
    if (wrong.length) out.problems.push(`${spec.script}（${specName(spec)}）：${wrong.join('、')}`);
  }
  const known = new Set(t.hooks.map((h) => h.script));
  const legacy = new Set<string>();
  for (const f of owned) {
    if (f.legacy) {
      out.legacy++;
      legacy.add(f.script);
    } else if (!known.has(f.script)) out.problems.push(`还登记着仓里已经没有的 ${f.script}`);
    else if (!claimed.has(f))
      out.problems.push(
        `${f.script} 多登记了一条：挂在 ${f.event} 上、matcher 是 ${JSON.stringify(f.matcher ?? null)}，不是该有的那几条`,
      );
  }
  for (const script of legacy) out.problems.push(`还挂着以前手装的 ${script}（fleet-guard 目录那份）`);
  return out;
}

export type Read =
  | { kind: 'none' }
  | { kind: 'ok'; text: string; root: unknown }
  | { kind: 'bad'; why: string };

/** 读一份 JSON 设置文件（钩子和权限两段共用）：不存在、是链接、不是 JSON 都说清，不当成空的 */
export function readSettings(abs: string): Read {
  const st = lstatOrNull(abs);
  if (st === null) return { kind: 'none' };
  if (st.isSymbolicLink())
    return { kind: 'bad', why: `这是个链接（→ ${linkTarget(abs)}），不是本脚本能改的文件` };
  if (!st.isFile()) return { kind: 'bad', why: '这里不是文件' };
  const text = readFileSync(abs, 'utf8');
  try {
    return { kind: 'ok', text, root: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (err) {
    return { kind: 'bad', why: `不是合法的 JSON（${(err as Error).message}），它自己也读不了` };
  }
}

/** Mirasim 固定共享入口只读默认文件；不让通用 JSON 读写器跟随任意链接。 */
function hookSettings(ctx: Ctx, t: HookTarget): { read: Read; shared: boolean } {
  const { abs } = relOf(ctx, t.settings);
  const managedRelay =
    t.format === 'codex' &&
    MIRASIM_CODEX_HOMES.some((home) => abs === join(ctx.home, placeOn(home, ctx.platform), 'hooks.json'));
  if (!managedRelay || !lstatOrNull(abs)?.isSymbolicLink()) return { read: readSettings(abs), shared: false };
  const source = join(ctx.home, '.codex', 'hooks.json');
  const parent = lstatOrNull(dirname(source));
  const target = lstatOrNull(source);
  const normalize = (path: string) => {
    const normalized = resolve(path);
    return ctx.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  if (
    !parent?.isDirectory() ||
    parent.isSymbolicLink() ||
    !target?.isFile() ||
    target.isSymbolicLink() ||
    normalize(resolve(dirname(abs), readlinkSync(abs))) !== normalize(source)
  )
    return {
      read: {
        kind: 'bad',
        why: '共享链接只允许精确指向默认 .codex/hooks.json 普通文件，父目录也必须是实目录',
      },
      shared: true,
    };
  return { read: readSettings(source), shared: true };
}

/** 装了要钩子的哪几家 */
function whoFor(ctx: Ctx, t: HookTarget): string {
  return `（给 ${agentNames(
    t.readers.filter((r) => ctx.installed.has(r)),
    t.borrowed,
  )}）`;
}

function noneLine(): string {
  const all = [...new Set(HOOK_TARGETS.flatMap((t) => t.readers))];
  return `没装读钩子设置的那几家（${agentNames(all)}），跳过`;
}

/** 这次不登记的一类钩子（事件名）和为什么；脚本目录照装 */
export interface HookSkip {
  event: string;
  why: string;
}

/** 这台装了的那几家要的钩子；skip 那类去掉（去掉后一条不剩的设置文件整份不管） */
function wanted(
  ctx: Ctx,
  skip?: HookSkip,
): { targets: HookTarget[]; problems: { key: string; why: string }[] } {
  let all = [...HOOK_TARGETS];
  const problems: { key: string; why: string }[] = [];
  // 默认入口本身也不能借父目录链接写出受管家目录。
  const defaultParent = ctx.installed.has('codex') ? lstatOrNull(join(ctx.home, '.codex')) : null;
  if (
    ctx.installed.has('codex') &&
    defaultParent &&
    (defaultParent.isSymbolicLink() || !defaultParent.isDirectory())
  ) {
    all = all.filter((t) => t.format !== 'codex');
    problems.push({ key: '~/.codex', why: '默认 Codex 家目录不是实目录，不跟随链接' });
  }
  const codex = HOOK_TARGETS.find((t) => t.format === 'codex');
  if (ctx.installed.has('codex') && codex) {
    for (const home of MIRASIM_CODEX_HOMES) {
      const rel = placeOn(home, ctx.platform);
      try {
        let dir = ctx.home;
        let present = true;
        // 逐层拒绝链接，不能通过受管路径里的 junction/symlink 写到用户指定的其他目录。
        for (const part of rel.split(/[\\/]/)) {
          dir = join(dir, part);
          const st = lstatOrNull(dir);
          if (st === null) {
            present = false;
            break;
          }
          if (st.isSymbolicLink() || !st.isDirectory())
            throw new Error('受管家目录或其上级不是实目录，不跟随链接');
        }
        if (present)
          all.push({
            ...codex,
            settings: { win32: `${home.win32}\\hooks.json`, linux: `${home.linux}/hooks.json` },
          });
      } catch (err) {
        problems.push({ key: `~/${slashed(rel)}`, why: code(err) });
      }
    }
  }
  const targets = all
    .filter((t) => t.readers.some((r) => ctx.installed.has(r)))
    .map((t) => (skip ? { ...t, hooks: t.hooks.filter((h) => h.event !== skip.event) } : t))
    .filter((t) => t.hooks.length > 0);
  return { targets, problems };
}

/** 这家有、但没登记的那类钩子（targets.ts 的 lacks）：每次都报一行 */
function lackLines(t: HookTarget): Line[] {
  return t.lacks ? [line('skip', `${agentNames(t.readers)} 的${t.lacks.what}`, t.lacks.why)] : [];
}

function skipLines(skip?: HookSkip): Line[] {
  return skip ? [line('skip', skip.event, skip.why)] : [];
}

/** 装了、但没装钩子的各家：逐家一行说为什么 */
function gapLines(ctx: Ctx): Line[] {
  const out: Line[] = [];
  for (const [id, why] of Object.entries(HOOK_GAPS) as [keyof typeof AGENTS, string][]) {
    if (ctx.installed.has(id)) out.push(line('skip', AGENTS[id].name, `没装钩子——${why}`));
  }
  return out;
}

function scriptsKey(ctx: Ctx): { abs: string; key: string } {
  const { abs, key } = relOf(ctx, HOOKS_DIR);
  return { abs, key };
}

const LAUNCHER_KEY = '~/.fleet-dao/bin';
// 同一份 exe。叫这个名字时把自身参数转给 node.exe，给 MCP 的 command 用。
const QUIET_NODE = 'quiet-node.exe';

/** 这台要登记成静默启动器的脚本（路径里有 shell 元字符的不在内，那些仍走 node） */
function launcherScripts(ctx: Ctx, targets: HookTarget[]): string[] {
  return [
    ...new Set(
      targets.flatMap((t) =>
        t.hooks
          .map((h) => h.script)
          .filter((script) => commandIn(t, ctx.home, ctx.platform, script).endsWith('.exe')),
      ),
    ),
  ];
}

function exeBase(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

/** 启动器在不在、是不是不带控制台的程序。Linux、或路径不安全退回 node 时，不报这一行 */
function checkLaunchers(ctx: Ctx, targets: HookTarget[]): Line | null {
  const scripts = launcherScripts(ctx, targets);
  if (scripts.length === 0) return null;
  const missing: string[] = [];
  const bad: string[] = [];
  const paths = [
    ...scripts.map((script) => hookCommand(ctx.home, ctx.platform, script)),
    join(ctx.home, '.fleet-dao', 'bin', QUIET_NODE),
  ];
  for (const exe of paths) {
    if (!existsSync(exe)) {
      missing.push(exeBase(exe));
      continue;
    }
    try {
      if (!guiSubsystem(readFileSync(exe))) bad.push(exeBase(exe));
    } catch (err) {
      return line('unknown', LAUNCHER_KEY, `没查成——读不了（${code(err)}）`);
    }
  }
  if (missing.length) return line('missing', LAUNCHER_KEY, `缺失——没有 ${missing.join('、')}`);
  if (bad.length) return line('drift', LAUNCHER_KEY, `漂移——${bad.join('、')} 不是不带黑窗口的程序`);
  return line('ok', LAUNCHER_KEY, '静默启动器都在');
}

/** 把同一份不带控制台的 exe 按脚本名复制到 ~/.fleet-dao/bin/。编不出就 failed，调用方不要登记指向空处的命令 */
function installLaunchers(ctx: Ctx, targets: HookTarget[]): Line | null {
  const scripts = launcherScripts(ctx, targets);
  if (scripts.length === 0) return null;
  try {
    const bytes = quietExeBytes();
    const dir = join(ctx.home, '.fleet-dao', 'bin');
    mkdirSync(dir, { recursive: true });
    let changed = false;
    const names = new Set<string>([QUIET_NODE]);
    for (const script of scripts) {
      const name = quietExeName(script);
      if (name !== null) names.add(name);
    }
    for (const name of names) {
      const dest = join(dir, name);
      const have = existsSync(dest) ? readFileSync(dest) : null;
      if (have === null || !have.equals(bytes)) {
        replaceExe(dest, bytes);
        changed = true;
      }
    }
    return line(
      changed ? 'changed' : 'ok',
      LAUNCHER_KEY,
      changed ? '装上了不弹黑窗口的启动器' : '静默启动器和仓里的一样',
    );
  } catch (err) {
    return line('failed', LAUNCHER_KEY, `没做成——${code(err)}`);
  }
}

function checkScripts(ctx: Ctx, src: Sources): Line {
  const { abs, key } = scriptsKey(ctx);
  if (!src.hooks.ok) return line('unknown', key, `没查成——${src.hooks.why}`);
  try {
    const st = lstatOrNull(abs);
    if (st === null) return line('missing', key, '缺失——钩子脚本没装');
    if (st.isSymbolicLink()) return line('drift', key, `漂移——被换成了链接（→ ${linkTarget(abs)}）`);
    if (!st.isDirectory()) return line('drift', key, '漂移——这里不是目录');
    const have = readTree(abs).files;
    if (!sameTree(src.hooks.tree, have))
      return line('drift', key, `漂移——和仓里不一样（${treeDiff(src.hooks.tree, have)}）`);
    return line('ok', key, `${src.hooks.tree.size} 个文件和仓里的 agents/hooks/ 一样`);
  } catch (err) {
    return line('unknown', key, `没查成——读不了（${code(err)}）`);
  }
}

function describe(t: HookTarget): string {
  return [...new Set(t.hooks.map((h) => h.event))].join('、');
}

/** 报告里这个目标那一行的键：Kimi Code 那份配置里还有权限那块，钩子这块另起一个键 */
function settingsKey(ctx: Ctx, t: HookTarget): string {
  return t.format === 'kimi' ? kimiKey(ctx, t) : relOf(ctx, t.settings).key;
}

function checkSettings(ctx: Ctx, t: HookTarget): Line {
  if (t.format === 'kimi')
    return checkKimiHooks(ctx, t, (script) => commandIn(t, ctx.home, ctx.platform, script));
  const { key } = relOf(ctx, t.settings);
  const who = whoFor(ctx, t);
  let read: Read;
  try {
    read = hookSettings(ctx, t).read;
  } catch (err) {
    return line('unknown', key, `没查成——读不了（${code(err)}）`);
  }
  if (read.kind === 'none') return line('missing', key, `缺失——没有这个文件，${describe(t)} 钩子没装${who}`);
  if (read.kind === 'bad') return line('drift', key, `漂移——${read.why}，钩子等于没装`);
  const j = judge(read.root, t, ctx.home, ctx.platform);
  const problems = [...(j.off ? [`${j.off}（不是本脚本关的，没动它）`] : []), ...j.problems];
  if (problems.length) return line('drift', key, `漂移——${problems.join('；')}`);
  if (j.missing.length) return line('missing', key, `缺失——没登记 ${j.missing.join('、')}，钩子没装${who}`);
  return line('ok', key, `${describe(t)} 都登记了，别的 ${j.others} 条钩子不归本脚本管${who}`);
}

export function checkHooks(ctx: Ctx, src: Sources, skip?: HookSkip): Line[] {
  const { targets, problems } = wanted(ctx, skip);
  const out: Line[] = problems.map((p) => line('unknown', p.key, `没查成——${p.why}`));
  if (targets.length === 0) {
    out.push(line('skip', scriptsKey(ctx).key, noneLine()));
  } else {
    out.push(checkScripts(ctx, src));
    const launchers = checkLaunchers(ctx, targets);
    if (launchers) out.push(launchers);
    for (const t of targets) {
      out.push(checkSettings(ctx, t), ...lackLines(t));
      if (t.format === 'codex') out.push(codexTrust(ctx, t, null));
    }
  }
  return [...out, ...skipLines(skip), ...gapLines(ctx)];
}

/**
 * Codex 的信任（hooks-codex.ts）：按 hooks.json 现在的内容算本脚本那几条的键和哈希，再查或记。
 * hooks.json 读不懂：查报没查成、写报没做成（设置那一行已经说了为什么）。
 */
function codexTrust(ctx: Ctx, t: HookTarget, backups: Backups | null): Line {
  const { abs } = relOf(ctx, t.settings);
  const config = codexConfig(t);
  let read: Read;
  try {
    read = hookSettings(ctx, t).read;
  } catch (err) {
    return line(
      backups ? 'failed' : 'unknown',
      trustKey(ctx, config),
      `${backups ? '没做成' : '没查成'}——hooks.json 读不了（${code(err)}）`,
    );
  }
  if (read.kind === 'bad')
    return line(
      backups ? 'failed' : 'unknown',
      trustKey(ctx, config),
      `${backups ? '没动' : '没查成'}——hooks.json ${read.why}`,
    );
  const root = read.kind === 'ok' ? read.root : {};
  const { needs, absent } = trustNeeds(abs, root, t.hooks, (script) =>
    commandIn(t, ctx.home, ctx.platform, script),
  );
  if (!backups) return checkCodexTrust(ctx, needs, absent, config);
  if (absent.length)
    return line('failed', trustKey(ctx, config), `没动——${absent.join('、')} 没登记上，不记信任`);
  return applyCodexTrust(ctx, needs, backups, config);
}

/** 信任必须写在该 hooks.json 同一个 Codex 家目录，不能把隔离入口的键写进默认配置。 */
function codexConfig(t: HookTarget): Place {
  return {
    win32: t.settings.win32.replace(/hooks\.json$/, 'config.toml'),
    linux: t.settings.linux.replace(/hooks\.json$/, 'config.toml'),
  };
}

function applyScripts(ctx: Ctx, src: Sources): Line {
  const { abs, key } = scriptsKey(ctx);
  if (!src.hooks.ok) return line('failed', key, `没做成——${src.hooks.why}`);
  try {
    const st = lstatOrNull(abs);
    const same =
      st?.isDirectory() === true && !st.isSymbolicLink() && sameTree(src.hooks.tree, readTree(abs).files);
    if (same) {
      return line('ok', key, `${src.hooks.tree.size} 个文件和仓里的 agents/hooks/ 一样`);
    }
    if (st !== null) removeEntry(abs);
    writeTree(abs, src.hooks.tree);
    return line(
      'changed',
      key,
      `${st === null ? '装上了' : '换成了仓里的版本'}（${[...src.hooks.tree.keys()].sort().join('、')}）`,
    );
  } catch (err) {
    return line('failed', key, `没做成——${code(err)}`);
  }
}

/** 去掉本脚本管的（含以前手装的），再按仓里的登记一遍；别的钩子原样留着 */
function merged(root: Obj, t: HookTarget, home: string, platform: Platform): Obj {
  const next = structuredClone(root);
  if (t.format === 'agy') {
    // 名字叫 agyName 的那一项整项归本脚本：重写，只留人设的 enabled = false；别的项里混进来的本脚本的命令摘掉
    const name = agyName(t);
    for (const [k, v] of Object.entries(next)) if (k !== name && isObj(v)) stripOwned(v);
    const old = next[name];
    const box: Obj = isObj(old) && old.enabled === false ? { enabled: false } : {};
    for (const spec of t.hooks) {
      const list = Array.isArray(box[spec.event]) ? (box[spec.event] as unknown[]) : [];
      list.push(group(t, spec, home, platform));
      box[spec.event] = list;
    }
    next[name] = box;
    return next;
  }
  const hooks: Obj = isObj(next.hooks) ? next.hooks : {};
  stripOwned(hooks);
  for (const spec of t.hooks) {
    const list = Array.isArray(hooks[spec.event]) ? (hooks[spec.event] as unknown[]) : [];
    list.push(group(t, spec, home, platform));
    hooks[spec.event] = list;
  }
  next.hooks = hooks;
  return next;
}

/** 按事件挂的那几组里摘掉本脚本的命令（就地改）；摘空的组去掉，摘空的事件去掉 */
function stripOwned(hooks: Obj): void {
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    let removed = false;
    const kept = groups.filter((g) => {
      if (!isObj(g) || !Array.isArray(g.hooks)) return true;
      const handlers: unknown[] = g.hooks;
      const left = handlers.filter((h) => !(isObj(h) && ownedHandler(h)));
      if (left.length === handlers.length) return true;
      g.hooks = left;
      removed = true;
      return left.length > 0;
    });
    if (removed && kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
}

/**
 * 登记的那一条。claude 写法（targets.ts 的 HOOK_TARGETS 上面「超时即拦」）：
 * - spec.exec：exec 形式 command: node、args: [脚本绝对路径]，Claude Code 直接起 node，不经 Git Bash、不经启动器；
 * - 否则命令是启动器 exe 时 args: []（exec 形式、不经 Git Bash，Grok 认空 args）；
 * - spec 要超时即拦时 onFailure。
 * 别家写法不加键。
 */
export function handlerFor(t: HookTarget, spec: HookSpec, home: string, platform: Platform): Obj {
  const command = commandIn(t, home, platform, spec.script);
  const h: Obj = { type: 'command', command, timeout: spec.timeout };
  if (t.format !== 'claude') return h;
  if (spec.exec) {
    h.command = 'node';
    h.args = [join(home, placeOn(HOOKS_DIR, platform), spec.script).replaceAll('\\', '/')];
  } else if (command.endsWith('.exe')) h.args = [];
  if (spec.onFailure) h.onFailure = spec.onFailure;
  return h;
}

/** 这一条是不是本脚本管的：看 command，exec 形式的再看 args */
function ownedHandler(h: Obj): ReturnType<typeof ownedScript> {
  const byCommand = ownedScript(h.command);
  if (byCommand) return byCommand;
  return Array.isArray(h.args) ? ownedScript(h.args.map(String).join(' ')) : null;
}

function group(t: HookTarget, spec: HookSpec, home: string, platform: Platform): Obj {
  return {
    ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
    hooks: [handlerFor(t, spec, home, platform)],
  };
}

function applySettings(ctx: Ctx, t: HookTarget, backups: Backups): Line {
  if (t.format === 'kimi')
    return applyKimiHooks(ctx, t, (script) => commandIn(t, ctx.home, ctx.platform, script), backups);
  const { rel, abs, key } = relOf(ctx, t.settings);
  const who = whoFor(ctx, t);
  try {
    const { read, shared } = hookSettings(ctx, t);
    if (read.kind === 'bad') return line('failed', key, `没动——${read.why}；要人看`);
    const root: unknown = read.kind === 'none' ? {} : read.root;
    if (!isObj(root)) return line('failed', key, '没动——整份不是一个 JSON 对象；要人看');
    const { box, boxName } = boxes(root, t);
    if (box !== undefined && !isObj(box)) return line('failed', key, `没动——${boxName} 不是对象；要人看`);
    const before = judge(root, t, ctx.home, ctx.platform);
    const off = before.off;
    const fine = before.missing.length === 0 && before.problems.length === 0;
    if (fine) {
      if (off) return line('failed', key, `钩子登记着，可${off}（不是本脚本关的，没动它）；要人看`);
      return line('ok', key, `${describe(t)} 都登记了，别的 ${before.others} 条钩子不归本脚本管${who}`);
    }
    if (shared)
      return line('failed', key, '没动——共享默认 hooks 尚未登记齐全；只由默认入口更新，不写共享链接');
    const next = merged(root, t, ctx.home, ctx.platform);
    const eol = read.kind === 'ok' && read.text.includes('\r\n') ? '\r\n' : '\n';
    const text = `${JSON.stringify(next, null, 2)}\n`.replaceAll('\n', eol);
    const saved = read.kind === 'ok' ? backups.saveFile(abs, rel.replaceAll('\\', '/')) : undefined;
    mkdirSync(dirname(abs), { recursive: true });
    writeAtomic(abs, text, undefined);
    const parts = [
      read.kind === 'none' ? '新建' : '改了',
      `登记了 ${describe(t)}`,
      ...(before.legacy > 0 ? [`换掉了以前手装的 ${before.legacy} 条`] : []),
      `别的 ${before.others} 条钩子没动`,
      ...(saved ? [`原文件备份在 ${saved}`] : []),
    ];
    const done = `${parts.join('，')}${who}`;
    if (off) return line('failed', key, `${done}；可${off}（不是本脚本关的，没动它），要人看`);
    return line('changed', key, done);
  } catch (err) {
    return line('failed', key, `没做成——${code(err)}`);
  }
}

export function applyHooks(ctx: Ctx, src: Sources, backups: Backups, skip?: HookSkip): Line[] {
  const { targets, problems } = wanted(ctx, skip);
  const out: Line[] = problems.map((p) => line('failed', p.key, `没做成——${p.why}`));
  if (targets.length === 0) {
    out.push(line('skip', scriptsKey(ctx).key, noneLine()));
    return [...out, ...skipLines(skip), ...gapLines(ctx)];
  }
  const scripts = applyScripts(ctx, src);
  out.push(scripts);
  const launchers = scripts.kind === 'failed' ? null : installLaunchers(ctx, targets);
  if (launchers) out.push(launchers);
  for (const t of targets) {
    if (scripts.kind === 'failed') {
      out.push(line('failed', settingsKey(ctx, t), '没动——钩子脚本没装上，不登记指向空处的命令'));
      continue;
    }
    const usesLauncher = t.hooks.some((h) => commandIn(t, ctx.home, ctx.platform, h.script).endsWith('.exe'));
    if (launchers?.kind === 'failed' && usesLauncher) {
      out.push(line('failed', settingsKey(ctx, t), '没动——静默启动器没装上，不登记指向空处的命令'));
      continue;
    }
    const missingScript = t.hooks.find((h) => src.hooks.ok && !src.hooks.tree.has(h.script));
    if (missingScript) {
      out.push(
        line('failed', settingsKey(ctx, t), `没动——仓里的 agents/hooks/ 没有 ${missingScript.script}`),
      );
      continue;
    }
    const settings = applySettings(ctx, t, backups);
    out.push(settings, ...lackLines(t));
    if (t.format === 'codex')
      out.push(
        settings.kind === 'failed'
          ? line('failed', trustKey(ctx, codexConfig(t)), '没动——钩子没登记上，不记信任')
          : codexTrust(ctx, t, backups),
      );
  }
  return [...out, ...skipLines(skip), ...gapLines(ctx)];
}
