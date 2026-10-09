// Codex 的调工具前钩子。agents-sync 登记在 ~/.codex/hooks.json（packages/agents-sync/src/targets.ts 的 HOOK_TARGETS），
// 登记时只挂 Bash 这一个名字。
// Codex 把跑命令的工具一律报成 Bash（learn.chatgpt.com/docs/hooks「Tool names」；codex-rs exec_command.rs 的 pre_tool_use_payload）。
// 输入是 { tool_name, tool_input: { command }, cwd }，和 Claude Code 一样；退出码 2 拦下，stderr 给模型看。
// 和 Claude 只差一处：Windows 上 Codex 用 PowerShell 跑命令，名字却还叫 Bash
// （codex-rs/shell-command/src/shell_detect.rs 的 default_user_shell）。
// 照 bash 判会把 PowerShell 的反引号转义当成命令替换拦下，所以 Windows 上按 PowerShell 判。
// Codex 没有单独读文件、搜内容的工具，读文件、搜内容都走终端，挂 Bash 这一条就管到了。
import { exitCodeReply, isMainModule, isRecord, runVendor, shellToolOn } from './vendor-pretool.mjs';

/** @type {import('./vendor-pretool.mjs').Normalize} */
export function normalizeCodex(input, platform) {
  const tool = input.tool_name;
  if (tool !== 'Bash') {
    return `fleet-guard：Codex 的钩子输入里认不出工具名（${JSON.stringify(tool)}），按拦处理（登记时只挂了 Bash）`;
  }
  const args = input.tool_input;
  if (!isRecord(args)) {
    return `fleet-guard：Codex 的 Bash 输入认不出（${JSON.stringify(args)}），按拦处理`;
  }
  return {
    tool_name: shellToolOn(platform),
    tool_input: args,
    ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
  };
}

if (isMainModule(import.meta.url)) runVendor(normalizeCodex, 'Codex', exitCodeReply);
