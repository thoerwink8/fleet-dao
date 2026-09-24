// cursor-agent 的无头参数（-p --output-format stream-json；2026.09.23 版在法国 VPS 上实跑）。
// 提示词走 stdin（实测可用），不进参数：超长会 E2BIG（CU-05）。
export type CursorSession = { mode: 'new' } | { mode: 'resume'; id: string };

export interface CursorArgsSpec {
  /**
   * 模型，来自路由表。auto = Cursor 自己挑，吃订阅里的 Auto 额度；点具体模型扣另一个桶（按月美元额度）。
   * 流里只回显界面名（Auto、Grok 4.6 High Fast……），核对不了实际模型。
   */
  model: string;
  /** 新会话的会话号由 cursor 自己起（init 帧里给），续跑时给回它。 */
  session: CursorSession;
  /** 工作树。 */
  workspace: string;
  /**
   * --force：命令一律放行（除非明确拒）。不带的话无头会话里的命令没人批准。放开权限必须是显式决定，
   * 前提是执行体用户读不到机器人私钥之类的凭据。
   */
  force: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:=,[\]-]*$/;

export function buildCursorArgs(spec: CursorArgsSpec): string[] {
  if (!MODEL.test(spec.model)) throw new Error(`模型名不合法：${JSON.stringify(spec.model)}`);
  if (spec.session.mode === 'resume' && !UUID.test(spec.session.id)) {
    throw new Error(`会话号必须是 UUID：${JSON.stringify(spec.session.id)}`);
  }
  if (!spec.workspace) throw new Error('没给工作树');
  return [
    '-p',
    '--output-format',
    'stream-json',
    // 新工作树不带它会被 Workspace Trust 拦下（CU-01）
    '--trust',
    '--workspace',
    spec.workspace,
    '--model',
    spec.model,
    ...(spec.force ? ['--force'] : []),
    ...(spec.session.mode === 'resume' ? ['--resume', spec.session.id] : []),
  ];
}
