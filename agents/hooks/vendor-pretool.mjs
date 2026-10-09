// 别家 AI 的调工具前钩子共用的一层。每家一个入口 pretool-<家>.mjs，agents-sync 登记在那家自己的钩子设置里
// （packages/agents-sync/src/targets.ts 的 HOOK_TARGETS）。
// 做法：先把那家的输入翻成 Claude Code 的写法，再交给 pretool.mjs 的 decide 判。拦什么只有 decide 一份，各家只管翻译。
// - tool_name 用 Bash、PowerShell、Read、Grep。
// - tool_input 用 command、file_path、path、pattern、glob、output_mode，外加 cwd。
// 翻不出来（工具名、参数认不出）一律按拦处理：翻译函数返回一句话，那句话就是拦下的理由。
// 回话按那家的协议，由入口自己给：退出码 2 加 stderr（exitCodeReply），或 stdout 一份 JSON。
// 和 pretool.mjs 一样只用 JSDoc 写类型（原样装到各台机器、纯 node 直接跑），agents/tsconfig.json 用 checkJs 过严格检查。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from './pretool.mjs';

/** @typedef {import('./pretool.mjs').Verdict} Verdict */
/** @typedef {'Bash' | 'PowerShell' | 'Read' | 'Grep'} CanonicalTool decide 认得的 Claude Code 工具名 */
/** @typedef {{ tool_name: CanonicalTool, tool_input: Record<string, unknown>, cwd?: string }} Canonical 翻好的输入 */
/**
 * 一家的翻译：认得就返回翻好的输入，认不得返回拦下的理由（一句话）。
 * @typedef {(input: Record<string, unknown>, platform: NodeJS.Platform) => Canonical | string} Normalize
 */

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
export const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 跑命令的工具在这个平台上按哪种终端判：Windows 上是 PowerShell，别处是 bash。
 * 只给确实这样跑的几家用：Codex（codex-rs/shell-command/src/shell_detect.rs 的 default_user_shell）、
 * Gemini CLI（packages/core/src/utils/shell-utils.ts 的 getShellConfiguration）。
 * @param {NodeJS.Platform} platform
 * @returns {CanonicalTool}
 */
export const shellToolOn = (platform) => (platform === 'win32' ? 'PowerShell' : 'Bash');

/**
 * 判一次：输入原文 → 翻译 → decide。输入不是 JSON 对象、翻不出来、翻译自己出错，都按拦处理。
 * @param {string} raw 钩子的 stdin 原文
 * @param {Normalize} normalize 这一家的翻译
 * @param {{ vendor: string, platform?: NodeJS.Platform, cwd?: string }} opts vendor 是给人看的那家的名字；cwd 是输入里没有会话目录时用的
 * @returns {Verdict}
 */
export function judgeVendor(raw, normalize, { vendor, platform = process.platform, cwd = process.cwd() }) {
  /** @type {unknown} */
  let parsed;
  try {
    // Windows 上有的工具喂进来的 stdin 带 UTF-8 BOM（pretool.mjs 的 decide 里有同一处说明）
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return { code: 2, message: `fleet-guard：${vendor} 的钩子输入不是 JSON，按拦处理` };
  }
  if (!isRecord(parsed)) {
    return { code: 2, message: `fleet-guard：${vendor} 的钩子输入不是一个 JSON 对象，按拦处理` };
  }
  /** @type {Canonical | string} */
  let canon;
  try {
    canon = normalize(parsed, platform);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { code: 2, message: `fleet-guard：${vendor} 的钩子输入翻译出错（${why}），按拦处理` };
  }
  if (typeof canon === 'string') return { code: 2, message: canon };
  return decide(JSON.stringify(canon), cwd);
}

/**
 * Codex、Gemini CLI、Kimi Code 的回话：拦下退出码 2、理由写 stderr；放行退出 0，stdout 一个字不出
 * （Gemini CLI 要求 stdout 只能是 JSON，空着就是没意见）。
 * @param {Verdict} v
 * @returns {never}
 */
export function exitCodeReply(v) {
  if (v.code !== 0) process.stderr.write(`${v.message}\n`);
  process.exit(v.code);
}

/**
 * 读 stdin、判、按那家的协议回话。stdin 读不到也按拦处理。
 * @param {Normalize} normalize
 * @param {string} vendor
 * @param {(v: Verdict) => void} reply
 */
export function runVendor(normalize, vendor, reply) {
  /** @type {string} */
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch (err) {
    const why = isRecord(err) && typeof err.code === 'string' ? err.code : String(err);
    reply({ code: 2, message: `fleet-guard：读不到 ${vendor} 的钩子输入（${why}），按拦处理` });
    return;
  }
  /** @type {Verdict} */
  let verdict;
  try {
    verdict = judgeVendor(raw, normalize, { vendor });
  } catch (err) {
    // 判断自己抛了也按拦处理：有的家（Kimi Code）把退出码 1 当放行，抛出去等于放行
    const why = err instanceof Error ? err.message : String(err);
    verdict = { code: 2, message: `fleet-guard：${vendor} 的钩子自己出错了（${why}），按拦处理` };
  }
  reply(verdict);
}

/**
 * 这个模块是不是被 node 直接跑的（不是被测试 import 的）
 * @param {string} url 入口自己的 import.meta.url
 */
export function isMainModule(url) {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (/** @type {string} */ p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(resolve(entry)) === norm(fileURLToPath(url));
}
