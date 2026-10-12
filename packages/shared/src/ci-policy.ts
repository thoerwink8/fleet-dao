// 受管仓的合并方式：强制 CI，或不强制（开完 PR 由引擎直接合并，不等检查、不做冷验收）。

export const CI_POLICIES = ['force', 'off'] as const;
export type CiPolicy = (typeof CI_POLICIES)[number];

/** 认不出就抛：不许把坏值当成「不强制」放行，也不许当成强制把人卡住还假装读到了。 */
export function ciPolicyOf(value: unknown): CiPolicy {
  if (value === 'force' || value === 'off') return value;
  throw new Error(`CI 模式认不出：${String(value)}`);
}
