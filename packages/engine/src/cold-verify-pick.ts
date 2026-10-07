// #555-2 装配侧：给 verifier-invoke 的 `ChooseModelForFamily` 一份**生产实现**。
//
// #555-1 把「按 0006 的家族顺序跳开作者族挑一家」做成了注入的接口；到 555-2 还只有测试里的 fake——那样收工等于
// 「接口有了、没接上」，正好是通用段说的「没验证过不说完成」。这一份把它接到主线上现成的选路/模型目录上。
//
// **不在这一层写选路的判法**：挡谁、放行谁、什么时候等得来，全在 `routing/choose.ts` 那一份（纯函数、可测）。
// 这一份只做三件事：
// 1. 按家族问一次「这个族此刻有没有能派的路由」，并给选路喂上「避开这一切别的族」；
// 2. 选了就回它的 modelId（渠道不给——one-shot 只认 modelId 和可选 channel，池的细节交给会起进程的那一侧）；
// 3. 没有就回 undefined，**绝不拿默认模型顶上**（0006 + specs/555：挑不出 = 没讨论成，明确失败）。
//
// 冷调用按 0006 的顺序一族一族问「这一族此刻派不派得出」，问到就停。喂 `avoid.families` 保证不问重复的族。
// 不把「给开 PR 前验证留一家」塞进 chooseRoute：那是 Fusion 的选路分支，没有生产调用，已删。
//
// **问不出来和派不出来是两回事**（通用段底线第三条）：
// - 读库读不到 → **抛**（调用方判「没查成」；抛出去的那条经 invokeVerifier → 没讨论成 → failure 状态）；
// - 读到了、这一族确实没候选 → 回 undefined（换下一个族是对的，不是失败）。

import { SEGMENT_STAGE } from '@fleet-dao/shared/flow-purposes';
import type { PickRouteInput, PickRouteResult, RouteChoice } from './ports.ts';

/** 这一层从选路拿到的「一个族此刻能不能派」的答案；`undefined` = 这个族没有能派的路由。 */
export interface FamilyPickDeps {
  /**
   * 按族挑一条路由。**注入**：生产给下面 `familyPicker` 的实现，测试给 fake。
   * 返回 undefined = 这一族此刻派不出（没候选、都被挡着等）；
   * **抛错 = 没查成**（读库读不到），调用方必须原样抛出去，不许当成「这个族没有」。
   */
  pickRouteForFamily: (family: string) => Promise<RouteChoice | undefined>;
}

export interface FamilyPickResult {
  modelId: string;
  /** 这一族（调用方写进 notes，给人看是哪一家验的）。 */
  family: string;
  /** 渠道（poolId / routeId 的渠道段）；选路没给就不带。 */
  channel?: string;
}

/**
 * 按 0006 的顺序（gpt → grok → claude → deepseek → kimi）、跳过 `avoid`，挑第一家能派的路由。
 *
 * `order` 必须由调用方从 `verifier-invoke.ts` 的 `FAMILY_ORDER` 传进来（这里不 import 那一份：这一层不该知道
 * 「冷调用的家族顺序」这个约定，它只按给它的顺序问）。
 *
 * 一家都挑不出 → 回 undefined（**不抛**）：那是 verifier-invoke 该判的「没讨论成」，不是这一层的读不成。
 */
export async function pickFamilyModel(
  order: readonly string[],
  avoid: string,
  deps: FamilyPickDeps,
): Promise<FamilyPickResult | undefined> {
  const skip = avoid.trim().toLowerCase();
  for (const raw of order) {
    const family = raw.trim();
    if (!family) continue;
    if (family.toLowerCase() === skip) continue; // 0006：跳过写这张单的族
    const route = await deps.pickRouteForFamily(family);
    if (route === undefined) continue;
    return {
      modelId: route.modelId,
      family: route.family,
      ...(route.poolId ? { channel: route.poolId } : {}),
    };
  }
  return undefined;
}

/**
 * 生产装配用的一份：把「按族挑一条路由」接到引擎现成的 `pickRoute` 端口上（`EnginePorts.pickRoute`）。
 *
 * `stage` 用页面上叫「验收」的那一格（shared 的 `SEGMENT_STAGE.verify`，就是 `verify`）。骨架里给 verify 排的顺序因此
 * 真被验收用上。不另用 `review`：那一格已经不在路由页上。
 *
 * 语义（三条，和 routing 那一份不重复）：
 * - 避开**除了这一族以外的全部**家族：选路按族挡，不避开的话每次都会挑回同一族（顺序里排最前的那一族），
 *   0006 的顺序就没了意义。
 * - 选路回 `ok: false` → 这一族此刻派不出，回 undefined，让 `pickFamilyModel` 问下一族（等空位/等额度也是
 *   「此刻派不出」——冷调用那一步不该为一次验收卡在等一下午上，卡住由调用方报人）。
 * - 选路回的族和问的不是同一族（渠道自己挑模型的、配置写串了）→ 也回 undefined，**不替它改名**：这一层认不出
 *   那次调用到底是哪一家在答，而「换家族」正是这一整套的意义所在（specs/555 第 2 条）。
 *
 * 回的是**工厂**而不是 `FamilyPickDeps`：`pickRoute` 的输入要 `taskId`（选路按任务记账、按任务查暂停的池），
 * 而 taskId 是调用方手里才有的东西。让调用方给一次，别在这里编一个假 id 混进选路的账里。
 */
export function familyPickerFrom(
  pickRoute: (input: PickRouteInput) => Promise<PickRouteResult>,
  order: readonly string[],
  stage: PickRouteInput['stage'] = SEGMENT_STAGE.verify,
  /**
   * 某一族派不出时（选路回 ok: false）告诉调用方原因：等空位、等额度的和一条路由都没有的要分得开——前者过一会儿再来就行，
   * 后者才是做不出来。pickRouteForFamily 只回 undefined，这个信息不然就丢了。
   */
  onNotPicked?: (family: string, why: Extract<PickRouteResult, { ok: false }>) => void,
  /**
   * 这张单是界面活（改到了页面代码，或没认出是不是）：每次问选路都带上 `uiWork`，硬禁令 gpt-no-ui 起作用，
   * GPT 族回「没有能派的」、顺序往下问下一家。不带 = 非界面单，照旧。
   */
  uiWork = false,
): (taskId: string) => FamilyPickDeps {
  const all = order.map((f) => f.trim()).filter((f) => f !== '');
  return (taskId) => ({
    async pickRouteForFamily(family) {
      const want = family.trim().toLowerCase();
      const got = await pickRoute({
        taskId,
        stage,
        avoidFamilies: all.filter((f) => f.toLowerCase() !== want),
        // 只按族挑一条：这些字段都是「这一步要什么」的其余部分，冷调用这一遍不挑它们（空 = 不管）。
        avoidRouteIds: [],
        avoidPoolIds: [],
        avoidModelIds: [],
        ...(uiWork ? { uiWork: true } : {}),
      });
      if (!got.ok) {
        onNotPicked?.(want, got);
        return undefined;
      }
      if (got.route.family.trim().toLowerCase() !== want) return undefined;
      return got.route;
    },
  });
}
