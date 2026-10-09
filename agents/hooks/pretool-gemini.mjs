// Gemini CLI 的调工具前钩子。agents-sync 登记在 ~/.gemini/settings.json 的 hooks.BeforeTool
// （packages/agents-sync/src/targets.ts 的 HOOK_TARGETS）。
// 输入 { tool_name, tool_input, cwd, … }（github.com/google-gemini/gemini-cli docs/hooks/reference.md）。
// 退出码 2 拦下，stderr 是给模型的理由；放行退出 0、stdout 不出声（它要求 stdout 只能是 JSON）。
// 挂的几个工具和参数（docs/reference/tools.md）：
// - run_shell_command：command、dir_path（在哪个目录跑）、is_background。
//   Windows 上 Gemini CLI 用 PowerShell 跑命令（packages/core/src/utils/shell-utils.ts 的 getShellConfiguration）。
// - read_file：file_path（旧版叫 absolute_path）。
// - read_many_files：include（要读的路径或通配，旧版叫 paths）、exclude。
// - grep_search（旧名 search_file_content）：pattern、dir_path（旧版 path）、include_pattern（旧版 include）、names_only。
// 只取认得的字段翻：exclude、exclude_pattern 是排除的通配，当成路径看会把「排除 .env」误当成读 .env。
import { exitCodeReply, isMainModule, isRecord, runVendor, shellToolOn } from './vendor-pretool.mjs';

/**
 * 第一个是字符串的字段
 * @param {Record<string, unknown>} args
 * @param {string[]} keys
 * @returns {string | undefined}
 */
const firstString = (args, keys) => {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
};

/**
 * 相对路径接在会话目录后面（Gemini CLI 的 dir_path 相对工作区根）
 * @param {string} p
 * @param {unknown} cwd
 */
const under = (p, cwd) =>
  /^(?:[\\/~]|[A-Za-z]:)/.test(p) || typeof cwd !== 'string' || cwd === '' ? p : `${cwd}/${p}`;

/** @type {import('./vendor-pretool.mjs').Normalize} */
export function normalizeGemini(input, platform) {
  const tool = input.tool_name;
  const args = input.tool_input;
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const at = cwd === undefined ? {} : { cwd };
  if (!isRecord(args)) {
    return `fleet-guard：Gemini CLI 的 ${JSON.stringify(tool)} 输入认不出（${JSON.stringify(args)}），按拦处理`;
  }
  if (tool === 'run_shell_command') {
    const dir = firstString(args, ['dir_path', 'directory']);
    return {
      tool_name: shellToolOn(platform),
      tool_input: { command: args.command, run_in_background: args.is_background === true },
      ...(dir === undefined ? at : { cwd: under(dir, cwd) }),
    };
  }
  if (tool === 'read_file') {
    const file = firstString(args, ['file_path', 'absolute_path', 'path']);
    if (file === undefined) return 'fleet-guard：Gemini CLI 的 read_file 输入里认不出要读的路径，按拦处理';
    return { tool_name: 'Read', tool_input: { file_path: file }, ...at };
  }
  if (tool === 'read_many_files') {
    const list = Array.isArray(args.include) ? args.include : Array.isArray(args.paths) ? args.paths : null;
    if (list === null || list.length === 0 || !list.every((x) => typeof x === 'string')) {
      return 'fleet-guard：Gemini CLI 的 read_many_files 输入里认不出要读的路径（include），按拦处理';
    }
    return { tool_name: 'Read', tool_input: { paths: list }, ...at };
  }
  if (tool === 'grep_search' || tool === 'search_file_content') {
    if (typeof args.pattern !== 'string') {
      return `fleet-guard：Gemini CLI 的 ${tool} 输入里认不出要搜的内容（pattern），按拦处理`;
    }
    const path = firstString(args, ['dir_path', 'path']);
    const glob = firstString(args, ['include_pattern', 'include']);
    return {
      tool_name: 'Grep',
      tool_input: {
        pattern: args.pattern,
        ...(path === undefined ? {} : { path: under(path, cwd) }),
        ...(glob === undefined ? {} : { glob }),
        ...(args.names_only === true ? { output_mode: 'files_with_matches' } : {}),
      },
      ...at,
    };
  }
  return `fleet-guard：Gemini CLI 的钩子输入里认不出工具名（${JSON.stringify(tool)}），按拦处理`;
}

if (isMainModule(import.meta.url)) runVendor(normalizeGemini, 'Gemini CLI', exitCodeReply);
