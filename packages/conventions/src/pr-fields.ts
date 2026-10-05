// 只剩 GitHub Actions 的报错注解 annotation。
// #654 前这里还管「PR 必填栏」（类别标签、里程碑、对应计划、specs、档位、这个 PR 做完就关单）的提醒：全是只提醒不挡合并，
// 填的人 8 成写「无」或「不适用」，删了；#1066 又删了「对应计划」栏的核对（checkPlanValue、PLAN_DOC：docs/plan.md 早已不在仓里，
// 非测试代码 0 处调用）。

/** GitHub Actions 的注解（报错、提醒、说明，在检查页上直接显示）；% 和换行要转义。 */
export function annotation(text: string, level: 'error' | 'warning' | 'notice' = 'error'): string {
  return `::${level}::${text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`;
}
