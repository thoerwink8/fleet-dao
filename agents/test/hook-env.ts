/** CLI 外壳默认验证交互路径，不继承无头工人的提前退出标记；无头用例可在其后显式覆盖。 */
export function interactiveHookEnv(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { FLEET_HEADLESS: _headless, ...env } = inherited;
  return env;
}
