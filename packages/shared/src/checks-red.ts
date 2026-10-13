/** 等合并时必过检查红了，写进 tasks.doing 的前缀。后面是检查名。卡片和返工都认这一句。 */
export const CHECKS_RED_PREFIX = '检查红了：';

/** doing 以这个前缀开头时，回检查名；否则没有。空的后缀也不算。 */
export function redCheckNames(doing: string | null | undefined): string | undefined {
  if (doing === null || doing === undefined || !doing.startsWith(CHECKS_RED_PREFIX)) return undefined;
  const names = doing.slice(CHECKS_RED_PREFIX.length).trim();
  return names.length > 0 ? names : undefined;
}
