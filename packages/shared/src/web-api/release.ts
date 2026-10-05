// 驾驶舱接口约定（web-api）：发布：/changelog 页的「发布 v<N>」。
// 入口是 ../web-api.ts（只有 export *），拆分说明见 specs/901-项目瘦身与提速/重构方案.md 第 2 节；内容是从原来一个文件里原样搬来的。
import { z } from 'zod';
import { Time } from './internal.ts';

// —— 发布：/changelog 页的「发布 v<N>」（#725）——

const MilestoneRefSchema = z.object({ number: z.number().int().positive(), title: z.string() });

/**
 * 这一版发出去叫什么：后端现读 GitHub 上开着的里程碑，照 `pnpm publish:pr` 同一份判法定（conventions 的 releaseVersion：
 * 当前版本里程碑＝开着的 v<N> 里 N 最小的那张，再拿仓根 CHANGELOG.md 已发的版本核一遍）。三种结果分开，都不拿「上一版 +1」顶：
 * - ok：定得出。
 * - blocked：读到了，判法不让发（一张版本里程碑都没开、CHANGELOG.md 已经有这一版或比它新的）；why 是判法的原话，
 *   这时跑 publish:pr 也一样被拒。
 * - unreadable：没读成（GitHub、CHANGELOG.md、这台后端没接上），why 写为什么。
 */
export const ReleaseVersionResponse = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    /** v<N>：当前版本里程碑的版本号。 */
    version: z.string().regex(/^v\d+$/),
    /** 这一版的里程碑：发布 PR 合并之后 release.yml 关的就是它。 */
    milestone: MilestoneRefSchema,
    /** 还开着的别的版本里程碑（发布 PR 正文里也列）：这次不发它们。 */
    others: z.array(MilestoneRefSchema),
    /** 读 GitHub 的时刻。 */
    asOf: Time,
  }),
  z.object({ state: z.literal('blocked'), why: z.string().min(1), asOf: Time }),
  z.object({ state: z.literal('unreadable'), why: z.string().min(1), asOf: Time }),
]);
