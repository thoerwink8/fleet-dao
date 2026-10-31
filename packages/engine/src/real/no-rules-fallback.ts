// 主线读不出必过检查的仓（免费私有仓不支持分支规则，branchRules 回空规则）：不能让 waitCi / mergePr 因
// NO_REQUIRED_CHECKS 停死。仓档案 mergeSignals 写明了这个仓合并前看哪些检查（fleet-dao 标准是 merge-gate、cold-verify），
// 这里把它当作必过名单的替身：
// - mergePr：没人指定检查名时，用 mergeSignals 做合并前的 CI 复核（零条仍不当绿：档案也没写就照旧抛）；
// - waitCi：等 CI 不等合并闸和冷验收（它们排在这一步之后），所以主线没有必过检查时没有东西可等，直接回绿，
//   真正的把关是后面的冷验收和合并闸。档案没写 mergeSignals 的仓照旧抛。
// 主线有必过检查的仓一律不走这里。
import type { GitHub, RepoRef } from '@fleet-dao/github';

async function rulesAreEmpty(
  gh: Pick<GitHub, 'deps'>,
  repo: RepoRef,
  signal?: AbortSignal,
): Promise<boolean> {
  const facts = await gh.deps.facts.get(repo, 'engine', signal);
  const rules = await gh.deps.facts.branchRules(repo, facts.defaultBranch, 'engine', signal);
  return rules.requiredChecks.length === 0;
}

export function withNoRulesFallback(
  gh: GitHub,
  mergeSignalsOf: (repo: RepoRef) => Promise<readonly string[]>,
): GitHub {
  return {
    ...gh,
    async waitCi(input, ctx) {
      if (!input.checks?.length && (await rulesAreEmpty(gh, input.repo, ctx?.signal))) {
        if ((await mergeSignalsOf(input.repo)).length > 0) {
          return { state: 'green', head: input.head, checks: [] };
        }
      }
      return gh.waitCi(input, ctx);
    },
    async mergePr(input, ctx) {
      if (!input.checks?.length && input.requireCi !== false && !input.onlyBook) {
        if (await rulesAreEmpty(gh, input.repo, ctx?.signal)) {
          const signals = await mergeSignalsOf(input.repo);
          if (signals.length > 0) return gh.mergePr({ ...input, checks: [...signals] }, ctx);
        }
      }
      return gh.mergePr(input, ctx);
    },
  };
}
