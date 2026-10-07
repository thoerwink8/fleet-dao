// 驾驶舱「发布到法国」按钮（#1232，POST /api/france/release）：后端只做三件事——核、记、写请求文件；
// **自己不起任何带 root 的进程**：法国上 root 的 fleet-release-request.path 盯着请求文件，起 fleet-release-request.service 接活
// （deploy/france/release-request/，人工档，装一次要创始人在法国跑 france.sh；规矩见 docs/ops.md「驾驶舱发布按钮」）。
// 改这里之前必须知道：
// - 只收一个参数「提交号」（完整 40 位）；核它等于此刻主线头（GitHub 现读，页面上看到的头在点之前换了就拒，让人重看），
//   主线头 CI 是绿的、法国在用的不是它、没有发版在走（进度记录说在走、或上一份请求还没被接），装了接活的单元。一条不满足就 409 带原因，不写文件。
// - 先记后做：操作记录（谁、哪个提交、原话「驾驶舱点击发布」）写不进就不写请求文件；文件没写成再补一条 ok=false 的记录。
// - 请求文件的样子固定：JSON.stringify({ v: 1, sha, at, by })，键的先后固定，接活的脚本（lib.mjs 的 parseRequest）按同一个样子认；
//   写法是先写临时文件再 link 到 request.json（已有一份就失败，不盖掉别人的）。by 只留字母数字和 _.@ 空格 -，最长 64。
// - 页面上的按钮状态（card.action）和这里用同一份判断（release-card.ts 的 buildReleaseCard 算出来），点的时候重算一遍，不信页面传来的。

import { constants, existsSync } from 'node:fs';
import { link, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RELEASE_REQUEST_ACTION,
  RELEASE_REQUEST_WORD,
  ReleaseRequestBody,
  ReleaseRequestResponse,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Hono } from 'hono';
import type { Deps } from './deps.ts';
import { ApiError, readJson, reply } from './http.ts';
import type { Actor } from './ports.ts';
import { buildReleaseCard } from './release-card.ts';
import type { CockpitEnv } from './session.ts';

export const RELEASE_REQUEST_DIR = '/var/lib/fleet-dao/release-request';
export const REQUEST_NAME = 'request.json';
export const LAST_NAME = 'last-request.json';
/** 法国上接活的单元装在这两处：单元文件和脚本副本都在才算装了（deploy/lib/human-tier.sh 的 setup_release_request）。 */
export const RECEIVER_UNIT = '/etc/systemd/system/fleet-release-request.path';
export const RECEIVER_SCRIPT = '/usr/local/lib/fleet-dao/release-request/fleet-release-request.mjs';

/** 后端和法国上接活单元之间的几个文件操作；main.ts 正式装配给真的，测试换替身。 */
export interface ReleaseRequestPort {
  /** 接活的单元装了没有（人工档）：没装带「缺什么」的原因；读不了抛错。 */
  receiverInstalled(): Promise<{ ok: true } | { ok: false; why: string }>;
  /** 上一份请求还在不在（在 = 还没被接活的单元读走）。 */
  pendingRequest(): Promise<boolean>;
  /** root 写的最近一次请求结果（last-request.json）原文；没有回 null；读不了抛错。 */
  readLast(): Promise<string | null>;
  /** 写请求文件：已经有一份就抛 EEXIST，不盖掉。 */
  writeRequest(text: string): Promise<void>;
}

/** 请求里「谁点的」：只留字母数字和 _.@ 空格 -，最长 64（接活脚本按同一个规则认）；一个字都不剩回 founder。 */
export function requestBy(displayName: string): string {
  const cleaned = displayName
    .replace(/[^\p{L}\p{N}_.@ -]/gu, '')
    .trim()
    .slice(0, 64)
    .trim();
  return cleaned === '' ? 'founder' : cleaned;
}

/** 请求文件的内容：键的先后固定（接活脚本按同一个样子认）。 */
export function requestText(sha: string, at: string, by: string): string {
  return `${JSON.stringify({ v: 1, sha, at, by })}\n`;
}

export function registerReleaseRequestRoutes(
  app: Hono<CockpitEnv>,
  deps: Deps,
  actorOf: (c: import('hono').Context<CockpitEnv>) => Actor,
): void {
  app.post('/france/release', async (c) => {
    const body = await readJson(c, ReleaseRequestBody);
    const port = deps.releaseRequest;
    if (!port) {
      throw new ApiError(
        503,
        'release_not_wired',
        '这台后端没接上发布请求（开发、内存版）：到法国那台的驾驶舱点',
      );
    }
    const card = await buildReleaseCard({
      port: deps.releaseCard,
      request: port,
      franceRelease: deps.franceRelease,
      store: deps.store,
      now: deps.now,
      signal: c.req.raw.signal,
    });
    // 页面上看到的头在点之前换了：拒，让人重看新的（不替人改发另一个）
    if (card.mainline.state !== 'ok') {
      throw new ApiError(409, 'head_unreadable', `主线头没读到，不发：${card.mainline.why}`);
    }
    if (card.mainline.commit.sha !== body.sha) {
      throw new ApiError(
        409,
        'not_head',
        `主线头已经不是 ${body.sha.slice(0, 12)} 了（现在是 ${card.mainline.commit.short}）：刷新页面重新看一遍再点`,
      );
    }
    if (card.action.state !== 'ready') {
      throw new ApiError(
        409,
        card.action.installed ? 'release_blocked' : 'receiver_missing',
        card.action.reasons.join('；') || '现在不能发',
      );
    }
    const actor = actorOf(c);
    const user = c.get('user');
    const at = deps.now().toISOString();
    const by = requestBy(user.displayName);
    const entry = {
      actor,
      action: RELEASE_REQUEST_ACTION,
      target: `commit:${body.sha.slice(0, 12)}`,
      after: { sha: body.sha, title: card.mainline.commit.title, by },
      reason: `${RELEASE_REQUEST_WORD}（创始人）`,
      via: c.get('via'),
    } as const;
    // 先记后做：记录写不进就不写请求文件
    await deps.store.appendAudit({ ...entry, ok: true });
    try {
      await port.writeRequest(requestText(body.sha, at, by));
    } catch (err) {
      const exists = (err as { code?: string }).code === 'EEXIST';
      const error = exists ? 'request_pending' : errMessage(err);
      try {
        await deps.store.appendAudit({ ...entry, ok: false, error });
      } catch (auditErr) {
        deps.log.error('发布请求没写成，这条失败记录也没写进去', { error, auditError: errMessage(auditErr) });
      }
      if (exists) {
        throw new ApiError(409, 'request_pending', '上一份发布请求还没被法国接走，等它接了再点');
      }
      deps.log.error('发布请求文件没写成', { error });
      throw new ApiError(502, 'request_not_written', `发布请求没写出去：${error}`);
    }
    return reply(c, ReleaseRequestResponse, { requested: true, sha: body.sha, at });
  });
}

// —— 生产装配（main.ts 挂）用到的真实现 ——

/** 真 port：请求目录是 RELEASE_REQUEST_DIR（fleet 能写，fleet-api.service 的 ReadWritePaths 放行）；进度目录 root 的、只读。 */
export function liveReleaseRequestPort(
  dir: string = RELEASE_REQUEST_DIR,
  trainDir = '/srv/fleet-dao-releases/.train',
  receiver: { unit: string; script: string } = { unit: RECEIVER_UNIT, script: RECEIVER_SCRIPT },
): ReleaseRequestPort {
  return {
    async receiverInstalled() {
      const missing = [
        existsSync(receiver.unit) ? null : receiver.unit,
        existsSync(receiver.script) ? null : receiver.script,
        existsSync(dir) ? null : dir,
      ].filter((m): m is string => m !== null);
      if (missing.length > 0) {
        return {
          ok: false,
          why: `法国还没装发版接活单元（缺 ${missing.join('、')}；要在法国以 root 跑一次不带参数的 france.sh）`,
        };
      }
      return { ok: true };
    },
    async pendingRequest() {
      return existsSync(join(dir, REQUEST_NAME));
    },
    async readLast() {
      try {
        return await readFile(join(trainDir, LAST_NAME), 'utf8');
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOENT') return null;
        throw e;
      }
    },
    async writeRequest(text) {
      const target = join(dir, REQUEST_NAME);
      const tmp = join(dir, `.request.${process.pid}.${Date.now()}.tmp`);
      // 先写临时文件（O_EXCL 不盖别人的），再 link 到 request.json：已经有一份就 EEXIST，不盖掉
      const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        await fh.writeFile(text);
        await fh.sync();
      } finally {
        await fh.close();
      }
      try {
        await link(tmp, target);
      } finally {
        await unlink(tmp).catch(() => undefined);
      }
    },
  };
}
