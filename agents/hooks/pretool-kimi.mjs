// Kimi Code 的调工具前钩子。agents-sync 登记在 ~/.kimi-code/config.toml 的 [[hooks]]
// （packages/agents-sync/src/targets.ts 的 HOOK_TARGETS）。
// 输入和 Claude 一样是 snake_case 的 { tool_name, tool_input, cwd, … }，工具名也是 Bash、Read、Grep
// （github.com/MoonshotAI/kimi-code docs/en/customization/hooks.md；packages/agent-core-v2/src/agent/tools/os/）。
// 退出码 2 拦下，stderr 是理由。别的退出码、超时它一律放行（fail-open），所以这里认不出的也退出 2，不能抛出去。
// 参数和 Claude 不一样的几处，这里翻过来：
// - Bash：timeout 按秒（Claude 是毫秒），cwd 可以在参数里另给。Windows 上也是 Git Bash（packages/kaos/src/environment.ts）。
// - Read：要读的路径叫 path（Claude 叫 file_path）。
// - Grep：output_mode 不写时默认 files_with_matches（Claude 的 Grep 不写时也只列文件名，可 decide 不写按打内容算），
//   只数个数叫 count_matches（Claude 叫 count）。
import { exitCodeReply, isMainModule, isRecord, runVendor } from './vendor-pretool.mjs';

/** @type {import('./vendor-pretool.mjs').Normalize} */
export function normalizeKimi(input) {
  const tool = input.tool_name;
  const args = input.tool_input;
  const sessionCwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  if (!isRecord(args)) {
    return `fleet-guard：Kimi Code 的 ${JSON.stringify(tool)} 输入认不出（${JSON.stringify(args)}），按拦处理`;
  }
  const at = sessionCwd === undefined ? {} : { cwd: sessionCwd };
  if (tool === 'Bash') {
    const cwd = typeof args.cwd === 'string' && args.cwd !== '' ? args.cwd : sessionCwd;
    return {
      tool_name: 'Bash',
      tool_input: {
        command: args.command,
        run_in_background: args.run_in_background === true,
        ...(typeof args.timeout === 'number' ? { timeout: args.timeout * 1000 } : {}),
      },
      ...(cwd === undefined ? {} : { cwd }),
    };
  }
  if (tool === 'Read') {
    const file = typeof args.path === 'string' ? args.path : args.file_path;
    if (typeof file !== 'string')
      return 'fleet-guard：Kimi Code 的 Read 输入里认不出要读的路径（path），按拦处理';
    return { tool_name: 'Read', tool_input: { file_path: file }, ...at };
  }
  if (tool === 'Grep') {
    if (typeof args.pattern !== 'string') {
      return 'fleet-guard：Kimi Code 的 Grep 输入里认不出要搜的内容（pattern），按拦处理';
    }
    const mode = args.output_mode ?? 'files_with_matches';
    return {
      tool_name: 'Grep',
      tool_input: {
        pattern: args.pattern,
        ...(typeof args.path === 'string' ? { path: args.path } : {}),
        ...(typeof args.glob === 'string' ? { glob: args.glob } : {}),
        ...(typeof args.type === 'string' ? { type: args.type } : {}),
        output_mode: mode === 'count_matches' ? 'count' : mode,
      },
      ...at,
    };
  }
  return `fleet-guard：Kimi Code 的钩子输入里认不出工具名（${JSON.stringify(tool)}），按拦处理`;
}

if (isMainModule(import.meta.url)) runVendor(normalizeKimi, 'Kimi Code', exitCodeReply);
