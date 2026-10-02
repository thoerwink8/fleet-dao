// release.yml 里那几个容易写错的步骤逻辑，从 Bash 里取出来变成纯判定 + 测试（第二意见 2026-10-02）：
//   - pickOpenMilestone：从开放 milestone 列表里挑要关哪一张——版本号按词边界认（v1 不许撞 v10），
//     撞多张、找不到就明说，不拿「第一张」糊弄；
//   - extractReleaseBody：从 CHANGELOG.md 拿「## [vN] - 日期」那一段当正文，找不到、是占位符就明说拒绝（不拿
//     Unreleased 段顶替：那里多是占位「还没有」，照抄就会发假 release）。
// release.yml 的对应步骤只做编排（gh api、jq、读文件），纯逻辑都进这里；测试在 packages/conventions/test/publish-release-logic.test.ts。
// 改这里之前必须知道：
// - 这些判定是「发了就发出去」（发假 release、关错 milestone），所以每个可失败分支都要有明确失败，不拿静默通过换。
// - 飞书幂等：本仓 Release 正文里写 last line「<!-- fleet-notified: vN -->」当已发信号，防止这一轮和上一轮都发一遍。
//   读 release 正文、加一行标签、写回，都是 release.yml 编排那边做的事；本文件只判定「是不是已发过」。

/** 仓根的版本标签：v<N>；版本号不是这个模样的一概认不出。 */
export function isVersionTag(s: string): s is `v${number}` {
  return /^v\d+$/.test(s);
}

export interface OpenMilestone {
  number: number;
  title: string;
}

export type MilestonePick =
  | { kind: 'found'; milestone: OpenMilestone }
  | { kind: 'none'; why: string }
  | { kind: 'ambiguous'; message: string; candidates: OpenMilestone[] };

/**
 * 从开放 milestone 列表里挑这一版对应的那一张。
 * 版本号按词边界认：^v<N>([^0-9]|$)——v1 撞上 v1 <空格>… 要放，撞上 v10 不放（第二意见 2026-10-02）。
 * 撞很多张（不只是撞 vN+ 数字、也包括「v1 xxx」和「v1 yyy」都开着）→ ambiguous，发起人要看一眼，不拿「第一张」糊弄。
 */
export function pickOpenMilestone(list: OpenMilestone[], version: `v${number}`): MilestonePick {
  if (!isVersionTag(version)) throw new Error(`版本号不是 v<N> 的模样：「${version}」`);
  const re = new RegExp(`^${version}([^0-9]|$)`);
  const hits = list.filter((m) => re.test(m.title));
  if (hits.length === 0) {
    return {
      kind: 'none',
      why: `开放 milestone 里没找到以 ${version} 开头的；多半已经被关过了，跳。`,
    };
  }
  if (hits.length > 1) {
    return {
      kind: 'ambiguous',
      message: `开放 milestone 里有 ${hits.length} 张都以 ${version} 开头（词边界匹配也分不清）——发起人要看一眼要关哪一张、手动 gh api 补上；不瞎猜。`,
      candidates: hits,
    };
  }
  const [first] = hits;
  if (!first) throw new Error('不该到这：hits.length > 1 已在上面挡过');
  return { kind: 'found', milestone: first };
}

/** CHANGELOG.md 里找「## [$VERSION] - 日期」那一段的占位符（发起前没写正文）。 */
const PLACEHOLDER_HEADING_MARKS = ['还没有', '没有内容', '无'];

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
  const heading = `## [${version}] - `;
  const start = lines.findIndex((l) => l.trim().startsWith(heading));
  if (start === -1) {
    return {
      kind: 'missing-heading',
      message:
        `CHANGELOG.md 里没有「${heading}…」这一版：发起人没把 Unreleased 段收进标题，或 write_dispatch 的 version 写错了。` +
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
  // 只把「整段就是占位」或「整行就是占位」当占位——用户写一句「新增无障碍模式」里带「无」不能误伤（第二意见 2026-10-02 小毛病）。
  const sectionIsPlaceholder = PLACEHOLDER_HEADING_MARKS.some((m) => section === m || section === `${m}\n`);
  const everyLineIsPlaceholder =
    section.length > 0 &&
    section
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .every((l) => PLACEHOLDER_HEADING_MARKS.some((m) => l === m));
  if (sectionIsPlaceholder || everyLineIsPlaceholder) {
    return {
      kind: 'placeholder',
      message: `CHANGELOG.md 这一版（${version}）正文只剩占位「${section.slice(0, 20)}…」：发起前要把话写进 Unreleased 段。`,
    };
  }
  return { kind: 'ok', body: section };
}

/** 飞书已发标记：会写进 Release 正文末尾，下次先读出来比对（幂等，第二意见 2026-10-02）。 */
export const FEISHU_NOTIFIED_PREFIX = '<!-- fleet-notified: ';
export const feishuNotifiedMark = (version: `v${number}`) => `${FEISHU_NOTIFIED_PREFIX}${version} -->`;

/** 看 release 正文里有没有「已发过飞书 @ vN」；返回 true 表示已走过通知这步（跳这步，不重发）。 */
export function feishuAlreadyNotified(releaseBody: string, version: `v${number}`): boolean {
  if (!isVersionTag(version)) throw new Error(`版本号不是 v<N> 的模样：「${version}」`);
  return releaseBody.includes(feishuNotifiedMark(version));
}

/** 把「已发过飞书 @ vN」标记追加到 Release 正文末尾；Release 正文读不到时由 release.yml 拒绝继续。 */
export function appendFeishuNotifiedMark(releaseBody: string, version: `v${number}`): string {
  if (!isVersionTag(version)) throw new Error(`版本号不是 v<N> 的模样：「${version}」`);
  if (feishuAlreadyNotified(releaseBody, version)) return releaseBody;
  const tail = releaseBody.endsWith('\n') || releaseBody.length === 0 ? '' : '\n\n';
  return `${releaseBody}${tail}${feishuNotifiedMark(version)}\n`;
}
