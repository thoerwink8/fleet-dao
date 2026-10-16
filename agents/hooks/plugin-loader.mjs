// 用户级开会话钩子。当前仓有订阅标记，就按目录把过程组写进这个仓的项目设置；
// 没有标记，就把本目录里的过程钩子从项目设置里拿掉，别的钩子不动。
// 另：配了 ~/.fleet-dao/fallback-proxy 就往 $CLAUDE_ENV_FILE 写代理变量（proxy-env.mjs），Bash 里的 gh/curl 不穿 reclaude 的口。
// 0083 删的是「每个仓都跑流程钩子」。这个加载器没标记就不写。
// 引擎无头会话（FLEET_HEADLESS=1）直接退出，不改项目设置；引擎的树（有 refs/fleet/incoming，别家执行体起的会话不带
// FLEET_HEADLESS）也不改（#2721）。
// 订阅文件读不成：不改项目设置，退出 0，并在 stderr 说明。退出 0 是为了不挡住开会话。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRunner } from './git-run.mjs';
import { PROCESS_HOOKS } from './plugin-catalog.mjs';
import { writeProxyEnv } from './proxy-env.mjs';

const SCRIPT_RE = /(?:\/\.fleet-dao\/hooks\/|\/agents\/hooks\/)([\w.-]+\.mjs)(?![\w.-])/;

/**
 * @param {unknown} command
 * @returns {string | null}
 */
export function scriptOf(command) {
  if (typeof command !== 'string') return null;
  return SCRIPT_RE.exec(command.replaceAll('\\', '/'))?.[1] ?? null;
}

/**
 * 一条钩子登记跑的是哪个脚本：shell 形式写在 command 里（`node "…/x.mjs"`），exec 形式是 command: "node"、脚本在 args 里。
 * @param {unknown} handler
 * @returns {string | null}
 */
export function handlerScript(handler) {
  if (!plainObject(handler)) return null;
  const direct = scriptOf(handler.command);
  if (direct !== null) return direct;
  if (!Array.isArray(handler.args)) return null;
  for (const arg of handler.args) {
    const s = scriptOf(arg);
    if (s !== null) return s;
  }
  return null;
}

/**
 * 写盘的 JSON 排版和仓里 biome 格式化后的一致：对象逐键换行；只含标量的数组放得下一行（行宽 110）就写一行，否则逐项换行。
 * 这样加载器写过的文件 `biome check` 照样过，内容不变时也不会改出整文件 diff。
 * @param {unknown} value
 * @param {string} [indent] 这一层的缩进
 * @param {number} [column] 这个值从第几列开始写（前面有缩进和键名）
 * @returns {string}
 */
export function formatJson(value, indent = '', column = indent.length) {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((v) => v === null || typeof v !== 'object')) {
      const flat = `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
      // 后面可能还跟一个逗号
      if (column + flat.length + 1 <= JSON_LINE_WIDTH) return flat;
    }
    return `[\n${value.map((v) => `${inner}${formatJson(v, inner)}`).join(',\n')}\n${indent}]`;
  }
  if (plainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const lines = keys.map((k) => {
      const lead = `${inner}${JSON.stringify(k)}: `;
      return `${lead}${formatJson(value[k], inner, lead.length)}`;
    });
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 仓根 biome.json 的 formatter.lineWidth */
const JSON_LINE_WIDTH = 110;

/**
 * @param {string} text
 * @returns {string[]}
 */
export function trackOf(text) {
  const value = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('订阅文件要是一个对象');
  }
  const track = /** @type {{ track?: unknown }} */ (value).track;
  if (!Array.isArray(track) || track.some((item) => typeof item !== 'string')) {
    throw new Error('订阅文件要有 track 字符串数组');
  }
  return track;
}

/**
 * @param {string} hooksDir
 * @param {string} script
 */
export function commandFor(hooksDir, script) {
  return `node "${join(hooksDir, script).replaceAll('\\', '/')}"`;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} settings
 * @param {string[]} track
 * @param {string} hooksDir
 */
export function applyCatalog(settings, track, hooksDir) {
  const next = structuredClone(plainObject(settings) ? settings : {});
  const root = /** @type {{ hooks?: Record<string, unknown> }} */ (next);
  const subscribed = track.includes('process');
  if (!plainObject(root.hooks)) {
    if (!subscribed) return next;
    root.hooks = {};
  }
  const catalog = new Set(PROCESS_HOOKS.map((hook) => hook.script));
  for (const event of Object.keys(root.hooks)) {
    const groups = root.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const group of groups) {
      const list = plainObject(group) ? group.hooks : undefined;
      if (!Array.isArray(list)) {
        kept.push(group);
        continue;
      }
      const hooks = list.filter((handler) => {
        const script = handlerScript(handler);
        if (script === null || !catalog.has(script)) return true;
        return subscribed;
      });
      if (hooks.length > 0) kept.push({ ...group, hooks });
    }
    if (kept.length > 0) root.hooks[event] = kept;
    else delete root.hooks[event];
  }
  if (!subscribed) {
    if (Object.keys(root.hooks).length === 0) delete root.hooks;
    return next;
  }
  for (const spec of PROCESS_HOOKS) {
    if (hasScript(root.hooks, spec.script)) continue;
    const groups = Array.isArray(root.hooks[spec.event]) ? root.hooks[spec.event] : [];
    let plain = groups.find(
      (group) =>
        typeof group === 'object' &&
        group !== null &&
        !Object.hasOwn(/** @type {object} */ (group), 'matcher') &&
        Array.isArray(/** @type {{ hooks?: unknown }} */ (group).hooks),
    );
    if (plain === undefined) {
      plain = { hooks: [] };
      groups.push(plain);
    }
    /** @type {{ hooks: unknown[] }} */ (plain).hooks.push({
      type: 'command',
      command: commandFor(hooksDir, spec.script),
      timeout: spec.timeout,
      // 后台钩子的几项照目录写（没有的不写，不往别的钩子里塞 false）
      ...(spec.async === true ? { async: true } : {}),
      ...(spec.asyncRewake === true ? { asyncRewake: true } : {}),
      ...(spec.rewakeMessage ? { rewakeMessage: spec.rewakeMessage } : {}),
      ...(spec.rewakeSummary ? { rewakeSummary: spec.rewakeSummary } : {}),
    });
    root.hooks[spec.event] = groups;
  }
  return next;
}

/**
 * @param {Record<string, unknown>} hooks
 * @param {string} script
 */
function hasScript(hooks, script) {
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const list = /** @type {{ hooks?: unknown[] }} */ (group)?.hooks;
      if (!Array.isArray(list)) continue;
      for (const handler of list) {
        if (handlerScript(handler) === script) return true;
      }
    }
  }
  return false;
}

/** 引擎建树时从 bundle 取进来的引用（packages/engine/src/real/user-git.ts 的 fetchBundle）：本机的检出没有它。 */
export const ENGINE_TREE_REF = 'refs/fleet/incoming';

/**
 * 这个目录是不是引擎的树（有 ENGINE_TREE_REF）。Grok、Cursor、Mirasim 起的引擎会话不带 FLEET_HEADLESS，照样跑这个用户级
 * 加载器（#2721）；树里的项目设置一改，交活核对就把它当成没提交的改动判返工。git 跑不成当成不是（照旧写），不挡开会话。
 * @param {string} cwd
 */
export function isEngineTree(cwd) {
  return gitRunner()(cwd, ['rev-parse', '--verify', '--quiet', `${ENGINE_TREE_REF}^{commit}`]).status === 0;
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(import.meta.url));
}

if (isMain()) {
  if (process.env.FLEET_HEADLESS === '1') process.exit(0);
  // 备用代理进 Bash（proxy-env.mjs）：这是每个仓开会话都跑的用户级钩子，放这里每台、每个仓都有
  for (const l of writeProxyEnv({ envFile: process.env.CLAUDE_ENV_FILE })) process.stderr.write(`${l}\n`);
  try {
    let input = {};
    try {
      input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    } catch {
      input = {};
    }
    const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd();
    if (isEngineTree(cwd)) process.exit(0);
    const markerPath = join(cwd, '.fleet-plugins.json');
    let track = [];
    if (existsSync(markerPath)) {
      try {
        track = trackOf(readFileSync(markerPath, 'utf8'));
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        process.stderr.write(`订阅文件读不成，项目钩子没改：${why}\n`);
        process.exit(0);
      }
    }
    const settingsPath = join(cwd, '.claude', 'settings.json');
    let current = {};
    if (existsSync(settingsPath)) {
      try {
        current = JSON.parse(readFileSync(settingsPath, 'utf8'));
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        process.stderr.write(`项目设置读不成，没改：${why}\n`);
        process.exit(0);
      }
      if (!plainObject(current) || (current.hooks !== undefined && !plainObject(current.hooks))) {
        process.stderr.write('项目设置读不成，没改：整份或 hooks 不是对象\n');
        process.exit(0);
      }
    }
    const next = applyCatalog(current, track, join(homedir(), '.fleet-dao', 'hooks'));
    // 内容等价就不写盘：不碰文件、不改排版
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, `${formatJson(next)}\n`);
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    process.stderr.write(`订阅加载没做成：${why}\n`);
  }
  process.exit(0);
}
