// 会话用户此刻挂的 reclaude 组织（design 第九节「一个会话用户，同一时刻只挂一个组织」）：选路（store-ports 的 pickRoute）、
// 路由探针、每小时对账每次用之前读，读成了的留很短一会儿（SESSION_ORG_TTL_MS）。引擎只读、不切号：切号是整个会话用户的
// 设置，一切这个家目录下在跑的会话全断（自动切号是 #194）。
// 读法（specs/157-拼车自动切换/需求.md）：以会话用户的身份（经 fleet-agent-scope，exec.ts：引擎进不去它的家）跑它家里的
// reclaude org list——带 * 的是现在挂的，类型那一列 team 是拼车、personal 是独享。解析和额度读取器是同一个（adapters 的
// parseOrgList），只留类型和是否当前：组织编号、名字、邮箱一概不往外带，编号不进仓、也不用配文件。前面的「Syncing config…」
// 之类不是组织那一行的，一律跳过。
// 读不到（没跑成、登录失效、封号）、一个组织都认不出、没有带 * 的行、带 * 的不止一行、类型认不出：一律明确失败（ok: false，
// 带白话原因，原因里不带编号、邮箱：它会进库、上驾驶舱），调用方按「会话用户挂的组织认不出」处理——带组织类型的池一律
// 不派、不探，不拿拼车顶。
// reclaude 更新后首跑会先「Syncing config…」上百秒：一次读最多等 SESSION_ORG_TIMEOUT_MS；选路只等 waitMs，没读完回 pending
// （选路按「过一会儿再选」处理），读在后台接着跑完、留下结果。
import { randomUUID } from 'node:crypto';
import { redact, type SessionUser } from '@fleet-dao/adapters';
import { parseOrgList } from '@fleet-dao/adapters/quota';
import type { LiveOrgReading } from '../routing/index.ts';
import type { UserCommandResult, UserExec } from './exec.ts';

/** 读成了的留多久：选路的几次调用、探针一轮里的几条路由共用一次读。读失败的不留，下一次照读。 */
export const SESSION_ORG_TTL_MS = 30_000;
/** 一次读最多等多久：平时 0.3 秒；reclaude 更新后首跑先同步配置，上百秒（和路由探针起会话给的一样长，real/route-probe.ts）。 */
export const SESSION_ORG_TIMEOUT_MS = 150_000;

const LIST = 'reclaude org list';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** reclaude 的报错原文进库之前：凭据、邮箱、IP 抹掉（redact），三位以上的数字也抹掉——组织编号就是这样的数。 */
function scrub(text: string): string {
  return redact(text, 200).replace(/\d{3,}/g, '<数>');
}

export interface SessionOrgDeps {
  exec: UserExec;
  user: SessionUser;
  /** 起 reclaude 的命令（绝对路径）：和会话、探针同一份，装在会话用户自己家里（real/index.ts 的 claudeCommand）。 */
  reclaude: string[];
  now?: () => Date;
  ttlMs?: number;
  timeoutMs?: number;
}

/** 读一次（不留）。没读成一律 ok: false（带原因），不抛。 */
export async function readSessionOrg(deps: SessionOrgDeps): Promise<LiveOrgReading> {
  const what = `以会话用户 ${deps.user} 跑 ${LIST}`;
  const timeoutMs = deps.timeoutMs ?? SESSION_ORG_TIMEOUT_MS;
  let r: UserCommandResult;
  try {
    r = await deps.exec({
      user: deps.user,
      cwd: '/',
      argv: [...deps.reclaude, 'org', 'list'],
      timeoutMs,
      scopeId: `session-org-${randomUUID().slice(0, 8)}`,
    });
  } catch (err) {
    return { ok: false, why: `${what}没跑成：${scrub(message(err))}` };
  }
  if (r.spawnError) return { ok: false, why: `${what}：没起来（${scrub(r.spawnError)}）` };
  if (r.timedOut) return { ok: false, why: `${what}：${Math.round(timeoutMs / 1000)} 秒没回，超时被停` };
  if (r.aborted) return { ok: false, why: `${what}：被叫停` };
  const stdout = r.stdout.toString('utf8');
  if (r.code !== 0) {
    const text = `${r.stderr}\n${stdout}`;
    if (/not logged in|no valid login|device_revoked|unauthori[sz]ed|\b401\b|login required/i.test(text)) {
      return {
        ok: false,
        why: `${what}：reclaude 报登录失效，要在法国上以会话用户重跑 reclaude login（docs/ops.md 第五节）`,
      };
    }
    if (/account_banned|暂不可用|\b403\b/i.test(text)) {
      return { ok: false, why: `${what}：reclaude 报账号不可用（上游封号或组织失效）` };
    }
    const tail = scrub(r.stderr);
    return { ok: false, why: `${what}：退出码 ${r.code ?? '空'}${tail ? `（${tail}）` : ''}` };
  }
  const rows = parseOrgList(stdout);
  if (rows.length === 0) {
    return { ok: false, why: `${what}：输出里一个组织都认不出（没有「编号 名字 类型」那样的行）` };
  }
  const current = rows.filter((row) => row.current);
  if (current.length === 0) return { ok: false, why: `${what}：没有带 * 的行，认不出现在挂的是哪个组织` };
  if (current.length > 1) {
    return { ok: false, why: `${what}：带 * 的有 ${current.length} 行，认不出现在挂的是哪个组织` };
  }
  const kind = current[0]?.kind;
  if (!kind)
    return { ok: false, why: `${what}：现在挂的那个组织类型认不出（只认 team 拼车、personal 独享）` };
  return { ok: true, org: kind };
}

/**
 * 读会话用户此刻挂的组织。waitMs：最多等这么久，没读完回 pending（读在后台接着跑完、留下结果，下一次就用上）；
 * 不给就等到读完（最多 SESSION_ORG_TIMEOUT_MS）。
 */
export type SessionOrgReader = (options?: { waitMs?: number }) => Promise<LiveOrgReading>;

/**
 * 选路、探针、每小时对账共用的读法：读成了的留 ttlMs（默认 30 秒），读失败的不留；同时来的几次共用一次读。不抛。
 */
export function sessionOrgReader(deps: SessionOrgDeps): SessionOrgReader {
  const clock = deps.now ?? (() => new Date());
  const ttl = deps.ttlMs ?? SESSION_ORG_TTL_MS;
  let kept: { at: number; value: LiveOrgReading } | null = null;
  let reading: Promise<LiveOrgReading> | null = null;
  const start = (): Promise<LiveOrgReading> => {
    if (!reading) {
      reading = readSessionOrg(deps)
        .catch(
          (err: unknown): LiveOrgReading => ({ ok: false, why: `读会话用户挂的组织出错：${message(err)}` }),
        )
        .then((value) => {
          kept = value.ok ? { at: clock().getTime(), value } : null;
          reading = null;
          return value;
        });
    }
    return reading;
  };
  return async (options = {}) => {
    const now = clock().getTime();
    if (kept && now >= kept.at && now - kept.at < ttl) return kept.value;
    const read = start();
    const waitMs = options.waitMs;
    if (waitMs === undefined) return read;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<LiveOrgReading>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            pending: true,
            why: `以会话用户跑 ${LIST} 过了 ${Math.round(waitMs / 1000)} 秒还没回（reclaude 更新后首跑先同步配置，要上百秒），读在后台接着跑，读完下一次就用上`,
          }),
        waitMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([read, late]);
    } finally {
      clearTimeout(timer);
    }
  };
}
