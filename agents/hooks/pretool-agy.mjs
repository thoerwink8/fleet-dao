// Antigravity 的调工具前钩子。agents-sync 登记在 ~/.gemini/config/hooks.json 名叫 fleet-dao 的那一项
// （packages/agents-sync/src/targets.ts 的 HOOK_TARGETS）。命令行、桌面版共用这份。
// 协议见 antigravity.google/docs/hooks 和 agy 1.3.2 程序里带的「Lifecycle Hooks (hooks.json)」一页：
// - 输入是 camelCase：{ toolCall: { name, args }, stepIdx, conversationId, workspacePaths, … }，没有 cwd。
//   会话目录取 workspacePaths 的第一个；run_command 自己带 Cwd 的用它。
// - 回话是 stdout 一份 JSON，退出码 0：拦下回 { decision: 'deny', reason }。没意见回 {}。
//   decision 空着按没意见处理（agy 的更新说明：「safely handling empty decision strings returned by pre-tool hooks」）。
//   不回 allow：allow 是「不问人直接放行」，会绕过 Antigravity 自己的审批。
// 挂的几个工具和参数（同一页的工具名表；参数名照 agy 程序里的字段名）：
// - run_command：CommandLine、Cwd。
// - view_file：AbsolutePath。
// - grep_search：SearchPath、Query（要搜的正则）、Includes（文件通配，数组）、MatchPerLine（true 才打出匹配的那几行）。
// 跑命令按哪种终端判：Windows 上按 PowerShell（程序里认 powershell.exe、pwsh.exe），别处按 bash。
import { isMainModule, isRecord, runVendor, shellToolOn } from './vendor-pretool.mjs';

/** @typedef {import('./vendor-pretool.mjs').Verdict} Verdict */

/** @type {import('./vendor-pretool.mjs').Normalize} */
export function normalizeAgy(input, platform) {
  const call = input.toolCall;
  if (!isRecord(call)) {
    return `fleet-guard：Antigravity 的钩子输入里认不出 toolCall（${JSON.stringify(call)}），按拦处理`;
  }
  const tool = call.name;
  const args = call.args;
  if (!isRecord(args)) {
    return `fleet-guard：Antigravity 的 ${JSON.stringify(tool)} 输入认不出（${JSON.stringify(args)}），按拦处理`;
  }
  const roots = Array.isArray(input.workspacePaths) ? input.workspacePaths : [];
  const root = typeof roots[0] === 'string' && roots[0] !== '' ? roots[0] : undefined;
  const at = root === undefined ? {} : { cwd: root };
  if (tool === 'run_command') {
    const dir = typeof args.Cwd === 'string' && args.Cwd !== '' ? args.Cwd : root;
    return {
      tool_name: shellToolOn(platform),
      tool_input: { command: args.CommandLine },
      ...(dir === undefined ? {} : { cwd: dir }),
    };
  }
  if (tool === 'view_file') {
    if (typeof args.AbsolutePath !== 'string') {
      return 'fleet-guard：Antigravity 的 view_file 输入里认不出要读的路径（AbsolutePath），按拦处理';
    }
    return { tool_name: 'Read', tool_input: { file_path: args.AbsolutePath }, ...at };
  }
  if (tool === 'grep_search') {
    if (typeof args.Query !== 'string') {
      return 'fleet-guard：Antigravity 的 grep_search 输入里认不出要搜的内容（Query），按拦处理';
    }
    const includes = Array.isArray(args.Includes) ? args.Includes.filter((x) => typeof x === 'string') : [];
    return {
      tool_name: 'Grep',
      tool_input: {
        pattern: args.Query,
        ...(typeof args.SearchPath === 'string' ? { path: args.SearchPath } : {}),
        // 只有一个通配时当 glob 用（限定了文件类型就不算从上层往下乱搜）；几个的都当路径看一遍
        ...(includes.length === 1 ? { glob: includes[0] } : includes.length > 1 ? { includes } : {}),
        // 写明 false 才算只列文件名；没写的按打内容算（宁可多拦）
        ...(args.MatchPerLine === false ? { output_mode: 'files_with_matches' } : {}),
      },
      ...at,
    };
  }
  return `fleet-guard：Antigravity 的钩子输入里认不出工具名（${JSON.stringify(tool)}），按拦处理`;
}

/**
 * Antigravity 的回话：stdout 一份 JSON，退出码 0
 * @param {Verdict} v
 * @returns {string}
 */
export const agyReply = (v) => JSON.stringify(v.code === 0 ? {} : { decision: 'deny', reason: v.message });

if (isMainModule(import.meta.url)) {
  runVendor(normalizeAgy, 'Antigravity', (v) => {
    process.stdout.write(`${agyReply(v)}\n`);
    process.exit(0);
  });
}
