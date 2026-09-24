// codex exec 的无头参数（codex-cli 0.156.1）。提示词给 `-` 从 stdin 读：超长不 E2BIG，管道关了它才开始跑。
// 续跑是子命令 `exec resume <thread_id>`，它不认 -C 和 -s：工作目录靠起进程时的 cwd，沙箱写成 -c。
// 凭据在 CODEX_HOME 里（每个账号池一个），不走环境变量。
export type CodexSession = { mode: 'new' } | { mode: 'resume'; id: string };

export interface CodexArgsSpec {
  /** 模型 id，来自路由表。codex 的事件流里不回显实际模型，核对不了。 */
  model: string;
  session: CodexSession;
  /** 工作树。 */
  cwd: string;
  /**
   * --dangerously-bypass-approvals-and-sandbox：不问、不进 codex 自己的沙箱。无头会话没人批，写码要它；
   * 放开权限必须是显式决定，前提是执行体用户读不到凭据（会话用户 + scope 就是外面那层沙箱）。
   */
  bypassSandbox: boolean;
  /** -c 覆盖项，例如 { model_provider: '"x"' }。键只许小写字母、数字、_ 和 .；值原样当 TOML 解析。 */
  config?: Readonly<Record<string, string>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CONFIG_KEY = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

export function buildCodexArgs(spec: CodexArgsSpec): string[] {
  if (!MODEL.test(spec.model)) throw new Error(`模型名不合法：${JSON.stringify(spec.model)}`);
  if (spec.session.mode === 'resume' && !UUID.test(spec.session.id)) {
    throw new Error(`会话号必须是 UUID：${JSON.stringify(spec.session.id)}`);
  }
  if (!spec.cwd) throw new Error('没给工作树');
  const config: string[] = [];
  for (const [key, value] of Object.entries(spec.config ?? {})) {
    if (!CONFIG_KEY.test(key) || /[\0\n\r]/.test(value)) throw new Error(`-c 覆盖项不合法：${key}`);
    config.push('-c', `${key}=${value}`);
  }
  if (spec.session.mode === 'resume') {
    return [
      'exec',
      'resume',
      '--json',
      '-m',
      spec.model,
      ...(spec.bypassSandbox
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['-c', 'sandbox_mode="workspace-write"']),
      ...config,
      spec.session.id,
      '-',
    ];
  }
  return [
    'exec',
    '--json',
    '-C',
    spec.cwd,
    '-m',
    spec.model,
    ...(spec.bypassSandbox
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', 'workspace-write']),
    ...config,
    '-',
  ];
}
