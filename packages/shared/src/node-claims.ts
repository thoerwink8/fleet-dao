// 本机租约读口和机器通行证发放的线上协议（#3388）。零依赖（不引 zod、不引别的包），本机脚本（#3389、#3390）直接导入。
//
// GET /api/nodes/claims（请求头 X-Fleet-Node-Token，只认机器通行证）：
//   200 {"claims":[{"repo":"owner/name","issue":123,"claimedBy":"founder-pc","leaseUntil":"2026-10-20T05:00:00.000Z"}]}
//   只返回所有仓 executor = local 且租约未到期的行，只这四个字段；repo 是库里的原样 owner/name。
//   401 通行证缺或不对；503 库读失败（认人读通行证表失败、或读租约失败）。出错的 body 是 {"error":{"code","message"}}。
//
// fleet-api node-key new <编号> [--name 显示名] --json：标准输出只有一行 {"env":"<编号>","token":"<明文>"}，提示走标准错误；
//   编号已存在（库里有效的、或 FLEET_NODE_KEYS 里有）退出非 0、不发新的。

/** 请求头名（和快照、本机会话、领单同一个）。 */
export const NODE_CLAIMS_HEADER = 'X-Fleet-Node-Token';
/** 完整路径（含 /api）。 */
export const NODE_CLAIMS_LIST_PATH = '/api/nodes/claims';

export interface NodeClaimRow {
  repo: string;
  issue: number;
  claimedBy: string;
  /** ISO 时刻。 */
  leaseUntil: string;
}

export interface NodeClaimsResponse {
  claims: NodeClaimRow[];
}

export interface NodeKeyNewJson {
  env: string;
  token: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 认 GET /api/nodes/claims 的 200 body：多字段、少字段、类型不对都抛错，不猜。 */
export function parseNodeClaimsResponse(body: unknown): NodeClaimsResponse {
  if (!isObject(body) || !Array.isArray(body.claims)) throw new Error('租约列表的形状不对：要有 claims 数组');
  const claims = body.claims.map((row, i): NodeClaimRow => {
    if (
      !isObject(row) ||
      typeof row.repo !== 'string' ||
      typeof row.issue !== 'number' ||
      !Number.isInteger(row.issue) ||
      typeof row.claimedBy !== 'string' ||
      typeof row.leaseUntil !== 'string' ||
      Number.isNaN(Date.parse(row.leaseUntil))
    ) {
      throw new Error(`租约列表第 ${i} 项的形状不对`);
    }
    return { repo: row.repo, issue: row.issue, claimedBy: row.claimedBy, leaseUntil: row.leaseUntil };
  });
  return { claims };
}

/** 认 node-key new --json 的标准输出（一行 JSON 文本）。 */
export function parseNodeKeyNewJson(line: string): NodeKeyNewJson {
  let value: unknown;
  try {
    value = JSON.parse(line.trim());
  } catch {
    throw new Error('node-key new --json 的输出不是 JSON');
  }
  if (
    !isObject(value) ||
    typeof value.env !== 'string' ||
    typeof value.token !== 'string' ||
    value.token === ''
  ) {
    throw new Error('node-key new --json 的输出要有 env 和 token 两个字符串');
  }
  return { env: value.env, token: value.token };
}

/** 出错 body 里的错误码：认 {"error":"code"} 和 {"error":{"code":"…"}} 两种写法，认不出是 null。 */
export function nodeErrorCode(body: unknown): string | null {
  if (!isObject(body)) return null;
  const e = body.error;
  if (typeof e === 'string') return e;
  if (isObject(e) && typeof e.code === 'string') return e.code;
  return null;
}
