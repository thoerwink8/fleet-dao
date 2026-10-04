// 发布收尾（release.yml → release-finalize.ts）每一步「该做、该跳、还是该红」的纯判定，原先是 release.yml 里的 Bash，
// 抠出来配测试（#593）：
//   - decideReleaseMilestone：发 vN 时关哪张里程碑——打 tag 之前核一次、建完 release 关的时候再判一次（同一份判法），
//     版本号对不上里程碑、撞号、找不到都明说，不拿「多半已经关过了」放过去；
//   - extractReleaseBody：从 CHANGELOG.md 拿「## [vN] - 日期」那一段当正文，找不到、是占位符就明说拒绝（不拿
//     Unreleased 段顶替：那里多是占位「还没有」，照抄就会发假 release）；
//   - decideTag：tag 不在就打、在且指着本次发布合并就跳、指着别的提交就红；
//   - decideRelease：Release 不在就建、正文（去掉飞书标记后）对得上就跳、被人改过就改回（标记留着）、名字撞了 tag 不对就红；
//   - 飞书幂等标记、feishuReplyOk（webhook HTTP 200 也可能是业务失败）。
// 编排（谁先谁后、读写 GitHub、发飞书）在 release-finalize.ts；测试在 packages/conventions/test/publish-release-logic.test.ts。
// 改这里之前必须知道：
// - 这些判定是「发了就发出去」（发假 release、关错 milestone），所以每个可失败分支都要有明确失败，不拿静默通过换。
// - 里程碑的版本号怎么认、「当前版本」是哪张，用 labels.ts 的 milestoneVersion / currentVersion：和派活、开单同一条规矩，不另写正则。
// - 飞书幂等：Release 正文末尾的「<!-- fleet-notified: vN -->」是已发信号；发之前先写「<!-- fleet-notify-attempt: vN -->」，
//   发成才换成 notified。发失败 attempt 留着（看得见「试过、没确认」），下一轮照样再发——判「发没发过」只看 notified。
import { isPlaceholderSection } from '@fleet-dao/shared';
import { currentVersion, milestoneVersion } from './labels.ts';

/** 仓根的版本标签：v<N>；版本号不是这个模样的一概认不出。 */
export function isVersionTag(s: string): s is `v${number}` {
  return /^v\d+$/.test(s);
}

/** 一个里程碑此刻的样子（GitHub 上现读；github-api.ts 的 MilestoneDetail 就是这个形状）。 */
export interface MilestoneState {
  number: number;
  title: string;
  state: 'open' | 'closed';
  /** 关掉的时间（ISO）；开着的是 null。 */
  closedAt: string | null;
}

/** 判出来的里程碑就是传进来的那一个（M 是调用方的类型，比如带说明的 MilestoneDetail）。 */
export type MilestoneDecision<M extends MilestoneState = MilestoneState> =
  | { kind: 'close'; milestone: M }
  | { kind: 'already-closed'; milestone: M; why: string }
  | { kind: 'error'; message: string };

const named = (m: { title: string }) => `「${m.title}」`;

/**
 * 发 vN 时该关哪张里程碑。
 * - 开着的里恰好一张是 vN，而且它就是当前版本（开着的 v<N> 里 N 最小的那张）→ close；
 * - 开着的里不止一张是 vN → error（关哪张说不清）；开着的里还有比 N 小的版本 → error（跳版了）；
 * - 开着的里没有 vN：关了的里有 vN、而且是在这张发布 PR 合并之后关的 → already-closed（重跑：上一轮或人手已经关了）；
 *   其余一律 error——vN 那张早在合并之前就关了（版本号贴错：比如开着的是 v3、这次发成了 v1，v1 那张是早就关掉的旧版本），
 *   或者开着的、关了的都没有 vN（被删了、改名了）。只看名字对得上就当「已经关过了」，就会让当前版本那张一直开着、整轮报绿。
 * mergedAt：这张发布 PR 合并的时间（ISO）。只有「开着的里没有 vN」时要用，那时没给、认不出都 error，不猜。
 */
export function decideReleaseMilestone<M extends MilestoneState>(opts: {
  version: `v${number}`;
  milestones: readonly M[];
  mergedAt?: string | undefined;
}): MilestoneDecision<M> {
  const { version, milestones, mergedAt } = opts;
  if (!isVersionTag(version)) throw new Error(`版本号不是 v<N> 的模样：「${version}」`);
  const n = Number(version.slice(1));
  const open = milestones.filter((m) => m.state === 'open');
  const current = currentVersion(open);
  const openHits = open.filter((m) => milestoneVersion(m.title) === n);
  if (openHits.length > 1) {
    return {
      kind: 'error',
      message: `开着的里程碑里有 ${openHits.length} 张都是 ${version}（${openHits.map(named).join('、')}）：关哪一张说不清，不瞎猜。先在 GitHub 上把多的那张改名或关掉，再重跑。`,
    };
  }
  const [hit] = openHits;
  if (hit) {
    if (current && current.version < n) {
      return {
        kind: 'error',
        message:
          `这次发的是 ${version}，可当前版本是 v${current.version}（${named(current.milestone)}还开着；当前版本＝开着的 v<N> 里 N 最小的那张，和派活同一条规矩）：版本跳了。` +
          `先发 v${current.version}；v${current.version} 不发了的话，先把那张里程碑里的单挪走、关掉它，再发 ${version}。`,
      };
    }
    return { kind: 'close', milestone: hit };
  }

  const openVersions = open.filter((m) => milestoneVersion(m.title) !== undefined);
  const openPart =
    openVersions.length > 0
      ? `开着的版本里程碑是${openVersions.map(named).join('、')}${current ? `（当前版本 v${current.version}）` : ''}`
      : '开着的版本里程碑一张都没有';
  const mergedText = mergedAt?.trim() ?? '';
  const merged = mergedText === '' ? Number.NaN : Date.parse(mergedText);
  if (Number.isNaN(merged)) {
    return {
      kind: 'error',
      message:
        `开着的里程碑里没有 ${version} 的（${openPart}）。要核关了的那张是不是这次发布关的，得有这张发布 PR 合并的时间，` +
        `可${mergedText === '' ? '没拿到' : `认不出（「${mergedText}」）`}：不猜，不当成已经关过了。`,
    };
  }
  const closedHits = milestones.filter((m) => m.state === 'closed' && milestoneVersion(m.title) === n);
  const closedAfter = closedHits.filter((m) => m.closedAt !== null && Date.parse(m.closedAt) >= merged);
  const [latest] = [...closedAfter].sort(
    (a, b) => Date.parse(b.closedAt ?? '') - Date.parse(a.closedAt ?? ''),
  );
  if (latest) {
    return {
      kind: 'already-closed',
      milestone: latest,
      why: `开着的里程碑里没有 ${version} 的；${named(latest)}在 ${latest.closedAt} 关的，晚于这次发布合并（${mergedText}）：上一轮（或人手）已经关过了，不再动它。`,
    };
  }
  const closedPart =
    closedHits.length > 0
      ? `${version} 的里程碑${closedHits.map((m) => `${named(m)}在 ${m.closedAt ?? '（没有关掉的时间）'} 就关了`).join('、')}，早于这次发布合并（${mergedText}），不是这次发布关的`
      : `关了的里程碑里也没有 ${version} 的（被删了或改名了）`;
  return {
    kind: 'error',
    message: `这次发的是 ${version}，开着的里程碑里没有 ${version} 的：${openPart}；${closedPart}。版本号和版本里程碑对不上（里程碑＝版本），不当成「已经关过了」放过去。`,
  };
}

export type ReleaseBodyPick =
  | { kind: 'ok'; body: string }
  | { kind: 'missing-heading'; message: string }
  | { kind: 'empty'; message: string }
  | { kind: 'placeholder'; message: string };

/**
 * 从 CHANGELOG.md 拿「## [$VERSION] - 日期」那一段的原文当 release 正文。找不到标题、正文是空、
 * 或正文只剩占位符（只剩「还没有」之类）都明确拒绝——不回退到 Unreleased 段（那里多是占位，照抄就发了假 release）。
 */
export function extractReleaseBody(changelog: string, version: `v${number}`): ReleaseBodyPick {
  if (!isVersionTag(version)) throw new Error(`版本号不是 v<N> 的模样：「${version}」`);
  const lines = changelog.replace(/\r\n?/g, '\n').split('\n');
  // 「## [vN] - YYYY-MM-DD」整行都得对得上：「## [v2] - nonsense」不能让过（Keep a Changelog 钉死的格式，
  // shared/changelog.ts 的 HEADING_LINE 同一套；第二意见 2026-10-02）。
  const headingRe = new RegExp(`^## \\[${version}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`);
  const headingDisplay = `## [${version}] - <YYYY-MM-DD>`;
  const start = lines.findIndex((l) => headingRe.test(l.trim()));
  if (start === -1) {
    return {
      kind: 'missing-heading',
      message:
        `CHANGELOG.md 里没有「${headingDisplay}」这一版（标题要 YYYY-MM-DD）：发起人没把 Unreleased 段收进标题，或 workflow_dispatch 手动补跑填的 version 写错了。` +
        `先把正文写进 Unreleased 段、重跑发布流程（不拿 Unreleased 顶：那里多是占位「还没有」，发了就是假 release）。`,
    };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## \[/.test(lines[i]?.trim() ?? '')) {
      end = i;
      break;
    }
  }
  const section = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  if (!section) {
    return {
      kind: 'empty',
      message: `CHANGELOG.md 这一版（${version}）正文是空的：发起前要把话写进 Unreleased 段。`,
    };
  }
  // 只把「每一行都恰好是占位」当占位——用户写一句「新增无障碍模式」里带「无」不能误伤（第二意见 2026-10-02 小毛病）；
  // 判法和 Unreleased 段的 hasContent 同一份（shared/changelog.ts 的 isPlaceholderSection）。
  if (isPlaceholderSection(section)) {
    return {
      kind: 'placeholder',
      message: `CHANGELOG.md 这一版（${version}）正文只剩占位「${section.slice(0, 20)}…」：发起前要把话写进 Unreleased 段。`,
    };
  }
  return { kind: 'ok', body: section };
}

/** 飞书已发标记：会写进 Release 正文末尾，下次先读出来比对（幂等，第二意见 2026-10-02）。
 * 发之前用「尝试标记」<!-- fleet-notify-attempt: vN --> 占住位置，发成功才换成「已确认标记」<!-- fleet-notified: vN -->——
 * runner 崩在「尝试标记写完、发送还没出去」之间时，下一次读到的是 attempt 而不是 notified，会再发一次（不重不漏）。 */
export const FEISHU_NOTIFIED_PREFIX = '<!-- fleet-notified: ';
export const FEISHU_ATTEMPT_PREFIX = '<!-- fleet-notify-attempt: ';
export const feishuNotifiedMark = (version: `v${number}`) => `${FEISHU_NOTIFIED_PREFIX}${version} -->`;
export const feishuAttemptMark = (version: `v${number}`) => `${FEISHU_ATTEMPT_PREFIX}${version} -->`;

/** 看 release 正文末尾有没有「已发过飞书 @ vN」的确认标记（只看末尾几行；正文中间出现同样注释不算，第二意见 2026-10-02）。 */
export function feishuAlreadyNotified(releaseBody: string, version: `v${number}`): boolean {
  if (!isVersionTag(version)) throw new Error(`版本号不是 v<N> 的模样：「${version}」`);
  const mark = `${feishuNotifiedMark(version)}`;
  const lines = releaseBody.replace(/\r\n?/g, '\n').split('\n');
  // 只认末尾 5 行里独立成行的标记
  const tail = lines.slice(Math.max(0, lines.length - 5));
  return tail.some((l) => l.trim() === mark);
}

/** 「尝试过」标记：写在 Release 正文末尾；下一次再跑看到它（没确认）就再发一次。 */
export function feishuAttemptWritten(releaseBody: string, version: `v${number}`): boolean {
  if (!isVersionTag(version)) throw new Error(`版本号不是 v<N> 的模样：「${version}」`);
  const mark = `${feishuAttemptMark(version)}`;
  const lines = releaseBody.replace(/\r\n?/g, '\n').split('\n');
  const tail = lines.slice(Math.max(0, lines.length - 5));
  return tail.some((l) => l.trim() === mark);
}

/** 发之前写「尝试标记」（已有确认标记、已有同版本尝试标记都幂等不动）。 */
export function appendFeishuAttemptMark(releaseBody: string, version: `v${number}`): string {
  if (!isVersionTag(version)) throw new Error(`版本号不是 v<N> 的模样：「${version}」`);
  if (feishuAlreadyNotified(releaseBody, version)) return releaseBody;
  if (feishuAttemptWritten(releaseBody, version)) return releaseBody;
  const tail = releaseBody.endsWith('\n') || releaseBody.length === 0 ? '' : '\n\n';
  return `${releaseBody}${tail}${feishuAttemptMark(version)}\n`;
}

/** 发成功之后把「尝试标记」换成「已确认标记」。 */
export function promoteFeishuAttemptToNotified(releaseBody: string, version: `v${number}`): string {
  if (!isVersionTag(version)) throw new Error(`版本号不是 v<N> 的模样：「${version}」`);
  if (feishuAlreadyNotified(releaseBody, version)) return releaseBody;
  const attempt = feishuAttemptMark(version);
  const confirmed = feishuNotifiedMark(version);
  const lines = releaseBody.replace(/\r\n?/g, '\n').split('\n');
  const idx = lines.findLastIndex((l) => l.trim() === attempt);
  if (idx === -1) {
    const tail = releaseBody.endsWith('\n') || releaseBody.length === 0 ? '' : '\n\n';
    return `${releaseBody}${tail}${confirmed}\n`;
  }
  lines[idx] = confirmed;
  return lines.join('\n');
}

const SHA = /^[0-9a-f]{40}$/;

export type TagDecision =
  | { kind: 'create' }
  | { kind: 'skip'; note: string }
  | { kind: 'error'; message: string };

/**
 * 打 tag 这一步怎么走。existing：这个 tag 现在指的提交（不在是 undefined）；mergeSha：本次发布合进 main 的那个提交。
 * 在且指着本次合并 → 跳（重跑）；在但指着别的 → 红（撞名的 tag 不当成这一版，也不挪它）；不在 → 打。
 */
export function decideTag(
  version: `v${number}`,
  existing: string | undefined,
  mergeSha: string,
): TagDecision {
  if (!isVersionTag(version)) throw new Error(`版本号不是 v<N> 的模样：「${version}」`);
  if (!SHA.test(mergeSha)) {
    return { kind: 'error', message: `本次发布合并的提交认不出（「${mergeSha}」）：不知道该打在哪，不打。` };
  }
  if (existing === undefined) return { kind: 'create' };
  if (existing === mergeSha)
    return {
      kind: 'skip',
      note: `tag ${version} 已经在、指着本次发布合并 ${mergeSha.slice(0, 7)}（重跑，跳）。`,
    };
  return {
    kind: 'error',
    message:
      `tag ${version} 已经在，但指的是 ${existing.slice(0, 7)}，不是本次发布合并 ${mergeSha.slice(0, 7)}：撞名的 tag 不当成这一版、也不挪它。` +
      `人先看一眼那个 tag 是谁打的；确认是错的，删掉（gh api -X DELETE repos/<仓>/git/refs/tags/${version}）再手动补跑这条工作流。`,
  };
}

const MARK_LINE = /^<!-- fleet-(?:notified|notify-attempt): v\d+ -->$/;

/** Release 正文去掉飞书标记行、统一换行、去掉行尾空白和末尾空行：拿它和 CHANGELOG.md 那一段比「是不是同一份」。 */
export function releaseBodyCore(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !MARK_LINE.test(l.trim()))
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

/** Release 正文里的飞书标记行（照原先后）：改回正文时要原样留着，别把「发过飞书」的证据一起抹了。 */
export function releaseMarks(body: string): string[] {
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => MARK_LINE.test(l));
}

export type ReleaseDecision =
  | { kind: 'create'; body: string }
  | { kind: 'skip'; note: string }
  | { kind: 'update'; body: string; note: string }
  | { kind: 'error'; message: string };

/**
 * 建 Release 这一步怎么走。want：CHANGELOG.md 里这一版那一段（extractReleaseBody 拿的）。
 * 不在 → 建；在但挂的 tag 不是 vN → 红；正文（去掉飞书标记）对得上 → 跳；对不上（被人手改过）→ 改回，飞书标记原样留在末尾。
 */
export function decideRelease(
  version: `v${number}`,
  existing: { tagName: string; body: string } | undefined,
  want: string,
): ReleaseDecision {
  if (!isVersionTag(version)) throw new Error(`版本号不是 v<N> 的模样：「${version}」`);
  if (existing === undefined) return { kind: 'create', body: want };
  if (existing.tagName !== version) {
    return {
      kind: 'error',
      message: `Release「${version}」在，但挂的 tag 是「${existing.tagName}」：名字撞了、指着别的，不接着走。人先看一眼是谁建的。`,
    };
  }
  if (releaseBodyCore(existing.body) === releaseBodyCore(want)) {
    return { kind: 'skip', note: `Release ${version} 已经在、正文和 CHANGELOG.md 对得上（重跑，跳）。` };
  }
  const marks = releaseMarks(existing.body);
  const body = marks.length > 0 ? `${want.trimEnd()}\n\n${marks.join('\n')}\n` : want;
  return {
    kind: 'update',
    body,
    note: `Release ${version} 已经在，正文和 CHANGELOG.md 对不上（被人手改过）：改回 CHANGELOG.md 那一段${marks.length > 0 ? '，飞书标记留着' : ''}。`,
  };
}

/**
 * 飞书自定义机器人 webhook 的回包算不算发成：HTTP 200 也会用 code != 0 表示业务失败（关键词、签名、频率不对）。
 * 现在的格式 { code: 0, msg: 'success' }；老格式 { StatusCode: 0, StatusMessage: 'success' }。别的、认不出的都算没发成。
 */
export function feishuReplyOk(reply: unknown): { ok: true } | { ok: false; message: string } {
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) {
    return { ok: false, message: '飞书回包认不出（不是 JSON 对象）' };
  }
  const r = reply as Record<string, unknown>;
  if ('code' in r) {
    if (r.code === 0) return { ok: true };
    return {
      ok: false,
      message: `飞书回的业务码不是 0（code=${String(r.code)}，msg=${String(r.msg ?? '')}）`,
    };
  }
  if ('StatusCode' in r) {
    if (r.StatusCode === 0) return { ok: true };
    return {
      ok: false,
      message: `飞书回的业务码不是 0（StatusCode=${String(r.StatusCode)}，StatusMessage=${String(r.StatusMessage ?? '')}）`,
    };
  }
  return { ok: false, message: '飞书回包里没有 code，认不出算没发成' };
}
