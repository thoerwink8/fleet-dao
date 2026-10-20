// pnpm machine join|issue|list|revoke：一条命令把新机器接入本机会话上报和领单（#3390，母单 #3353）。
// 通行证明文只活在内存里：经 ssh 从法国标准输出接住（或从标准输入读），交给本机安装时只走子进程环境变量
// FLEET_NODE_TOKEN，不进命令行参数、不打屏、不写日志；所有对外文字出口都先过 redact。
// 三态：任何一步没成都返回非 0 和原因，不拿 0 冒充；join --ssh 发了钥匙却没装成时经同一别名自动作废这把（#3397），
// 作废也没成才写明「先 revoke 再重来」。--token-stdin 的钥匙不是本命令发的，不动它。

export const NODE_ID_RE = /^[a-z][a-z0-9-]*$/;
const REMOTE_BIN = 'sudo -n bash /srv/fleet-dao-releases/current/packages/api/bin/fleet-api node-key';

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface MachineDeps {
  /** 经 ssh 别名在法国跑一条远程命令（整条命令是一个字符串）。 */
  ssh(alias: string, remoteCommand: string): Promise<RunResult>;
  /** 跑本机安装；通行证只经 env 传，args 里没有它。 */
  install(args: string[], env: Record<string, string>): Promise<RunResult>;
  /** 带头的 GET；网络失败抛错。 */
  get(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }>;
  readStdin(): Promise<string>;
  out(line: string): void;
  err(line: string): void;
}

export interface MachineArgs {
  cmd: 'join' | 'issue' | 'list' | 'revoke';
  id?: string;
  name?: string;
  url?: string;
  ssh?: string;
  tokenStdin: boolean;
}

export const USAGE = [
  '用法：',
  '  pnpm machine join <编号> [--name 显示名] --url <法国看板地址> (--ssh <主机别名> | --token-stdin)',
  '  pnpm machine issue <编号> [--name 显示名] --ssh <主机别名>',
  '  pnpm machine list --ssh <主机别名>',
  '  pnpm machine revoke <编号> --ssh <主机别名>',
].join('\n');

/** 把输出里的通行证明文抹掉（含 JSON/URL 转义后的常见形态）。 */
export function redact(text: string, token: string | undefined): string {
  if (!token) return text;
  let out = text.split(token).join('[已隐去]');
  const enc = encodeURIComponent(token);
  if (enc !== token) out = out.split(enc).join('[已隐去]');
  return out;
}

/** 单引号包一层，给远程 shell 用。 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function checkId(id: string | undefined): string | undefined {
  if (!id) return '缺环境编号';
  if (!NODE_ID_RE.test(id)) return `环境编号 ${id} 不合规：只许小写字母开头、小写字母数字短横线`;
  return undefined;
}

function checkName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (name.trim() === '' || name.length > 60 || /[\r\n\0]/.test(name))
    return '--name 不能为空、不能换行、不超过 60 字';
  return undefined;
}

/** 从标准输入文本里拿通行证：整段就是明文，或一行 {"env","token"}（issue --json 的形态）。 */
export function parseTokenInput(text: string, id: string): { token: string } | { error: string } {
  const t = text.trim();
  if (!t) return { error: '标准输入里没有通行证' };
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as { env?: unknown; token?: unknown };
      if (typeof j.token !== 'string' || !j.token) return { error: '标准输入的 JSON 里没有 token' };
      if (j.env !== undefined && j.env !== id)
        return { error: `标准输入的通行证属于另一个环境编号，不是 ${id}，拒绝使用` };
      return { token: j.token };
    } catch {
      return { error: '标准输入像 JSON 却解析不了' };
    }
  }
  if (/\s/.test(t)) return { error: '标准输入的通行证不该含空白，只放一整段明文' };
  return { token: t };
}

function sshReason(r: RunResult, token?: string): string {
  const e = redact(r.stderr.trim(), token);
  return `${e || '（无标准错误）'}（退出码 ${r.status ?? '无'}）`;
}

/** 在法国发钥匙，返回明文（只在内存）。 */
async function issueKey(
  deps: MachineDeps,
  alias: string,
  id: string,
  name: string | undefined,
): Promise<{ token: string } | { error: string }> {
  const cmd = `${REMOTE_BIN} new ${id}${name !== undefined ? ` --name ${shq(name)}` : ''} --json`;
  let r: RunResult;
  try {
    r = await deps.ssh(alias, cmd);
  } catch (e) {
    return { error: `ssh ${alias} 没连上：${e instanceof Error ? e.message : String(e)}` };
  }
  if (r.status !== 0) return { error: `法国发钥匙没成：${sshReason(r)}` };
  let parsed: { env?: unknown; token?: unknown };
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch {
    return { error: '法国发钥匙的输出不是一行 JSON，无法接住通行证（不会把原输出打出来）' };
  }
  if (parsed.env !== id) return { error: `法国回的环境编号 ${String(parsed.env)} 和要的 ${id} 对不上` };
  if (typeof parsed.token !== 'string' || !parsed.token) return { error: '法国回的 JSON 里没有 token' };
  return { token: parsed.token };
}

/** 作废 join 刚发的那把；原因里的明文抹掉。 */
async function revokeIssued(
  deps: MachineDeps,
  alias: string,
  id: string,
  token: string,
): Promise<{ ok: true } | { ok: false; why: string }> {
  try {
    const r = await deps.ssh(alias, `${REMOTE_BIN} revoke ${id}`);
    return r.status === 0 ? { ok: true } : { ok: false, why: sshReason(r, token) };
  } catch (e) {
    return {
      ok: false,
      why: `ssh ${alias} 没连上：${redact(e instanceof Error ? e.message : String(e), token)}`,
    };
  }
}

/** 试读租约：200 且 {"claims":[...]} 才算成。 */
export async function probeClaims(
  deps: MachineDeps,
  url: string,
  token: string,
): Promise<{ ok: true; count: number } | { ok: false; why: string }> {
  const base = url.replace(/\/+$/, '');
  try {
    const r = await deps.get(`${base}/api/nodes/claims`, { 'X-Fleet-Node-Token': token });
    if (r.status !== 200) return { ok: false, why: `读租约回了 HTTP ${r.status}` };
    let j: { claims?: unknown };
    try {
      j = JSON.parse(r.body);
    } catch {
      return { ok: false, why: '读租约回的不是 JSON' };
    }
    if (!Array.isArray(j.claims)) return { ok: false, why: '读租约回的 JSON 里没有 claims 数组' };
    return { ok: true, count: j.claims.length };
  } catch (e) {
    return { ok: false, why: `读租约没连上：${redact(e instanceof Error ? e.message : String(e), token)}` };
  }
}

async function join(a: MachineArgs, deps: MachineDeps): Promise<number> {
  const id = a.id as string;
  if (!a.url || !/^https?:\/\//.test(a.url)) {
    deps.err('join 要 --url <法国看板地址>（http(s):// 开头）');
    return 1;
  }
  if (a.tokenStdin === Boolean(a.ssh)) {
    deps.err('join 要且只要 --ssh <主机别名> 或 --token-stdin 其中一个');
    return 1;
  }
  let token: string;
  if (a.ssh) {
    const got = await issueKey(deps, a.ssh, id, a.name);
    if ('error' in got) {
      deps.err(`${got.error}\n编号已存在时不会覆盖：要重装先 pnpm machine revoke ${id} --ssh ${a.ssh}`);
      return 1;
    }
    token = got.token;
  } else {
    const got = parseTokenInput(await deps.readStdin(), id);
    if ('error' in got) {
      deps.err(got.error);
      return 1;
    }
    token = got.token;
  }
  const ssh = a.ssh;
  /** 发完钥匙之后、报「装好了」之前没成：--ssh 时作废刚发的这把，作废也没成就写明手动作废。 */
  const fail = async (why: string): Promise<number> => {
    if (!ssh) {
      deps.err(why);
      return 1;
    }
    const rv = await revokeIssued(deps, ssh, id, token);
    deps.err(
      rv.ok
        ? `${why}\n刚在法国发的通行证已作废，可直接重跑 join`
        : `${why}\n自动作废没成：${rv.why}\n通行证还有效，先 pnpm machine revoke ${id} --ssh ${ssh} 再重跑 join`,
    );
    return 1;
  };
  let inst: RunResult;
  try {
    inst = await deps.install(['install', '--url', a.url, '--machine', a.name ?? id], {
      FLEET_NODE_TOKEN: token,
    });
  } catch (e) {
    return fail(`本机安装没跑起来：${redact(e instanceof Error ? e.message : String(e), token)}`);
  }
  const instOut = redact(inst.stdout, token).trimEnd();
  if (instOut) deps.out(instOut);
  if (inst.status !== 0) {
    const e = redact(inst.stderr, token).trim();
    return fail(`本机安装/试推没成（退出码 ${inst.status ?? '无'}）${e ? `：${e}` : ''}`);
  }
  const probe = await probeClaims(deps, a.url, token);
  if (!probe.ok) return fail(`装好了但试读租约没成：${probe.why}\n不能算接入完成。`);
  deps.out(`试读租约成：GET /api/nodes/claims 回 200，现有 ${probe.count} 条`);
  deps.out(
    `装好了：${id} 已接入本机会话上报，试推和试读租约都成了。新开的会话才有心跳；领单用 pnpm work claim <单号>`,
  );
  return 0;
}

async function forward(a: MachineArgs, deps: MachineDeps, remote: string): Promise<number> {
  if (!a.ssh) {
    deps.err(`${a.cmd} 要 --ssh <主机别名>`);
    return 1;
  }
  let r: RunResult;
  try {
    r = await deps.ssh(a.ssh, remote);
  } catch (e) {
    deps.err(`ssh ${a.ssh} 没连上：${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  // list / revoke 原样转发法国输出（格式由 #3388 定）
  if (r.stdout.trim()) deps.out(r.stdout.trimEnd());
  if (r.status !== 0) {
    deps.err(`法国 node-key ${a.cmd} 没成：${sshReason(r)}`);
    return 1;
  }
  return 0;
}

async function issue(a: MachineArgs, deps: MachineDeps): Promise<number> {
  if (!a.ssh) {
    deps.err('issue 要 --ssh <主机别名>');
    return 1;
  }
  const got = await issueKey(deps, a.ssh, a.id as string, a.name);
  if ('error' in got) {
    deps.err(got.error);
    return 1;
  }
  deps.err(
    '通行证只显示这一次：别进聊天、仓库、日志。交给新机器：pnpm machine join <编号> --url <地址> --token-stdin',
  );
  deps.out(got.token);
  return 0;
}

export async function runMachine(a: MachineArgs, deps: MachineDeps): Promise<number> {
  if (a.cmd === 'list') return forward(a, deps, `${REMOTE_BIN} list`);
  const bad = checkId(a.id) ?? checkName(a.name);
  if (bad) {
    deps.err(`${bad}\n${USAGE}`);
    return 1;
  }
  if (a.cmd === 'join') return join(a, deps);
  if (a.cmd === 'issue') return issue(a, deps);
  return forward(a, deps, `${REMOTE_BIN} revoke ${a.id}`);
}
