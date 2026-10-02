// Mirasim 的流量账本：~/.mirasim/traffic/<会话 uuid>/index-*.ndjson，每次上游调用一行。
// 判「这次到底走的哪条上游」只认它（MS-27：route=auto 时服务端按额度窗自己选，会话成功了不说明走了哪条）；
// 中转路由还要起针之后有 2xx 行才算真干了活。行里还有账号、设备这类字段：只挑路由相关的几个，别的一概不读出来。
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { num, optional, rec, str } from '../stream-kit.ts';

/**
 * 读账本目录、读账本文件怎么做：默认直接读本机文件（开发机、测试）。账本在别的系统用户家里、调用方（引擎）进不去那个
 * 家目录时换成这个——例如经 fleet-agent-scope 以那个会话用户的身份读（real/index.ts 的生产装配）。readdir 找不到目录
 * 要抛一个 code 是 'ENOENT' 的错（和 node:fs 一样），不然「没有这个会话的目录」和「读不了账本」这两种没法分开报。
 */
export interface LedgerFs {
  readdir(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

const nodeLedgerFs: LedgerFs = {
  readdir: (dir) => readdir(dir),
  readFile: (path) => readFile(path, 'utf8'),
};

export interface LedgerRow {
  /** 毫秒时间戳。 */
  at?: number;
  status?: number;
  upstreamHost?: string;
  viaRelay?: boolean;
  model?: string;
  /** 用于区分计费模型调用与本地 count_tokens / models 辅助请求。 */
  path?: string;
}

/** 三态：读到了（可能是 0 行）/ 没查成。没有目录、读不了、格式认不出都是「没查成」，不当成「没有调用」。 */
export type LedgerReading =
  | { state: 'read'; rows: LedgerRow[]; unparsed: number }
  | { state: 'unknown'; detail: string };

export interface LedgerRouting {
  calls: number;
  ok: number;
  viaRelay: number;
  hosts: string[];
  models: string[];
}

export async function readMirasimLedger(
  dir: string,
  sessionKey: string,
  since?: number,
  fs: LedgerFs = nodeLedgerFs,
): Promise<LedgerReading> {
  const uuid = sessionKey.slice(sessionKey.indexOf(':') + 1);
  if (!/^[0-9a-f-]{36}$/i.test(uuid)) return { state: 'unknown', detail: `会话号认不出：${sessionKey}` };
  const folder = join(dir, uuid);
  let names: string[];
  try {
    names = (await fs.readdir(folder)).filter((n) => n.startsWith('index-') && n.endsWith('.ndjson'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      state: 'unknown',
      detail:
        code === 'ENOENT'
          ? '账本里没有这个会话的目录（可能一次上游调用都没有，也可能账本换了地方）'
          : `读不了账本：${code}`,
    };
  }
  if (names.length === 0) return { state: 'unknown', detail: '账本目录里没有 index 文件' };
  const rows: LedgerRow[] = [];
  let unparsed = 0;
  for (const name of names.sort()) {
    let text: string;
    try {
      text = await fs.readFile(join(folder, name));
    } catch (err) {
      return { state: 'unknown', detail: `读不了账本文件 ${name}：${(err as NodeJS.ErrnoException).code}` };
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row: Record<string, unknown> | undefined;
      try {
        row = rec(JSON.parse(line));
      } catch {
        row = undefined;
      }
      if (!row) {
        unparsed++;
        continue;
      }
      const at = typeof row.ts === 'string' ? Date.parse(row.ts) : num(row.ts);
      if (since !== undefined && (at === undefined || !Number.isFinite(at)))
        return { state: 'unknown', detail: `账本 ${name} 有时间认不出的行，无法确认属于本次调用` };
      if (since !== undefined && at !== undefined && Number.isFinite(at) && at < since) continue;
      rows.push({
        ...optional('at', at !== undefined && Number.isFinite(at) ? at : undefined),
        ...optional('status', num(row.status)),
        ...optional('upstreamHost', str(row.upstreamHost)),
        ...optional('viaRelay', typeof row.viaRelay === 'boolean' ? row.viaRelay : undefined),
        ...optional('model', str(row.model)),
        ...optional('path', str(row.path)),
      });
    }
  }
  return { state: 'read', rows, unparsed };
}

export function ledgerRouting(rows: readonly LedgerRow[]): LedgerRouting {
  return {
    calls: rows.length,
    ok: rows.filter((r) => r.status !== undefined && r.status >= 200 && r.status < 300).length,
    viaRelay: rows.filter((r) => r.viaRelay === true).length,
    hosts: [...new Set(rows.map((r) => r.upstreamHost).filter((h): h is string => Boolean(h)))],
    models: [...new Set(rows.map((r) => r.model).filter((m): m is string => Boolean(m)))],
  };
}
