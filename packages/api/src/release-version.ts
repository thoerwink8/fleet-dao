// /changelog 页「这一版」和「发布 v<N>」按钮的版本号（#725）。
// 已发布：仓根 CHANGELOG.md 里的 ## [vN] - 日期（splitChangelog 的 released）。发布收尾打的 git tag 不在这里读，
// 页面上的「已发布」列表也是同一份标题，不是 tag 列表。
// 这一版的候选：GitHub 上开着的 v<N> 里程碑里 N 最小的那张（conventions 的 currentVersion，和派活同一条）。
// 候选已经有发布标记：判成已发布，这一版取下一个还没有标记的号（openMilestonesForChangelog），再交给 releaseVersion
// 定里程碑。候选自己没有标记就不动，不按「已发布的最大号 +1」猜。
// pnpm publish:pr 不走这一步：里程碑还开着、标题里却已经有这一版，发起仍然拒绝，指去重跑 release。
// 改这里之前必须知道：
// - 驾驶舱接口别处只读库，这一处现读 GitHub：计划以 GitHub 为准，库里没有里程碑的副本（design 第三节「驾驶舱后端」）。
//   一次一条 GraphQL，只在打开 /changelog、点「发布」时读；限时 READ_TIMEOUT_MS，读不完照「读不到」报。
// - 读不到（这台后端没接上、受管的仓里没有 fleet-dao、GitHub、CHANGELOG.md）一律回 unreadable 带原因；判法不让发
//   （一张版本里程碑都没开、CHANGELOG.md 已经发到比这一版还新）回 blocked 带判法的原话。都不回 v1、不回 0。

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { currentVersion, type MilestoneRef, milestoneVersion, releaseVersion } from '@fleet-dao/conventions';
import { ReleaseVersionResponse, splitChangelog, WebRoutes } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Hono } from 'hono';
import type { z } from 'zod';
import type { Deps } from './deps.ts';
import { reply } from './http.ts';
import type { Logger, Store } from './ports.ts';
import { findSelfRepo, SELF_REPO_NAME } from './self-repo.ts';
import type { CockpitEnv } from './session.ts';

export type ReleaseVersionView = z.infer<typeof ReleaseVersionResponse>;

/** 读里程碑最多等多久：页面在等，GitHub 客户端自己的重试（一次 30 秒、连不上还退避重试）不能全让人干等。 */
export const READ_TIMEOUT_MS = 10_000;

/** 定版本号要的两样（main.ts 装配；测试换替身）。 */
export interface ReleaseSource {
  /** 这个仓此刻还开着的里程碑（GitHub 现读）：读不到、没翻完就抛，不拿「一张都没有」顶。 */
  openMilestones(
    repo: { owner: string; name: string },
    signal: AbortSignal,
  ): Promise<readonly MilestoneRef[]>;
  /** 仓根 CHANGELOG.md 的全文：这台后端是从哪个提交发的，就是那个提交上的那份。读不到就抛。 */
  changelog(): Promise<string>;
}

/** 这台后端自己那份 CHANGELOG.md：发布目录是整仓（deploy/release.sh 用 git archive 取的），仓根在 packages/api/src 上三层。 */
export function repoChangelog(): Promise<string> {
  return readFile(fileURLToPath(new URL('../../../CHANGELOG.md', import.meta.url)), 'utf8');
}

const versionLabel = (n: number) => `v${n}`;

/**
 * 给更新日志定「这一版」之前，先把已经写进 CHANGELOG 的号从候选里拿掉。
 * 开着的 v<N> 里 N 最小的那张若已有发布标记，它算已发布；这一版改成下一个还没有标记的号。
 * 开着的里程碑里有这个号就留那张，没有就补一张同号的（number 用版本号），后面的 releaseVersion 才能定得出。
 * 候选自己没有标记：原样返回。一张版本里程碑都没有：也原样返回，让 releaseVersion 照旧拒绝。
 */
export function openMilestonesForChangelog(
  open: readonly MilestoneRef[],
  released: readonly { version: string }[],
): readonly MilestoneRef[] {
  const current = currentVersion(open);
  if (!current) return open;
  const taken = new Set(released.map((item) => item.version));
  if (!taken.has(versionLabel(current.version))) return open;

  let n = current.version;
  while (taken.has(versionLabel(n))) n += 1;
  const kept = open.filter((milestone) => {
    const parsed = milestoneVersion(milestone.title);
    return parsed === undefined || !taken.has(versionLabel(parsed));
  });
  if (kept.some((milestone) => milestoneVersion(milestone.title) === n)) return kept;
  return [...kept, { number: n, title: versionLabel(n) }];
}

export interface ReadReleaseVersionInput {
  /** 没给 = 这台后端没接上（开发环境、内存样例数据）。 */
  source: ReleaseSource | undefined;
  store: Store;
  log: Logger;
  now: () => Date;
  /** 请求断了就别再等 GitHub。 */
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}

export async function readReleaseVersion(input: ReadReleaseVersionInput): Promise<ReleaseVersionView> {
  const asOf = input.now().toISOString();
  const unreadable = (why: string): ReleaseVersionView => ({ state: 'unreadable', why, asOf });
  const { source } = input;
  if (!source) {
    return unreadable('这台后端没接上 GitHub 里程碑的读取（开发环境、内存样例数据），版本号核不了。');
  }
  const repo = await findSelfRepo(input.store);
  if (!repo) return unreadable(`受管的仓里没有 ${SELF_REPO_NAME}，不知道去哪个仓读里程碑。`);
  const slug = `${repo.owner}/${repo.name}`;

  const timeoutMs = input.timeoutMs ?? READ_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  let open: readonly MilestoneRef[];
  try {
    open = await untilAborted(source.openMilestones({ owner: repo.owner, name: repo.name }, signal), signal);
  } catch (e) {
    const why = timeout.aborted ? `${timeoutMs / 1000} 秒没读完` : errMessage(e);
    input.log.warn('读 GitHub 上开着的里程碑失败（/changelog 的发布版本号）', { repo: slug, error: why });
    return unreadable(`读 ${slug} 开着的里程碑失败：${why}`);
  }

  let released: ReturnType<typeof splitChangelog>['released'];
  try {
    released = splitChangelog(await source.changelog()).released;
  } catch (e) {
    input.log.warn('读不了仓根的 CHANGELOG.md（/changelog 的发布版本号）', { error: errMessage(e) });
    return unreadable(`读不了这台后端上的仓根 CHANGELOG.md（核已发的版本要用）：${errMessage(e)}`);
  }

  try {
    const { version, milestone, others } = releaseVersion(
      openMilestonesForChangelog(open, released),
      released,
    );
    return { state: 'ok', version, milestone, others, asOf };
  } catch (e) {
    return { state: 'blocked', why: errMessage(e), asOf };
  }
}

export function registerReleaseRoutes(app: Hono<CockpitEnv>, deps: Deps): void {
  app.get(WebRoutes.releaseVersion.path, async (c) =>
    reply(
      c,
      ReleaseVersionResponse,
      await readReleaseVersion({
        source: deps.release,
        store: deps.store,
        log: deps.log,
        now: deps.now,
        signal: c.req.raw.signal,
      }),
    ),
  );
}

/** 到时限就不等了：实现不认 signal（不停下来）也照样按读不到报。 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error);
      },
    );
  });
}
