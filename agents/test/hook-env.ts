/** 交互夹具自选 CLI 身份，不继承宿主会话或工人标记；机器/身份用例在隔离后显式覆盖。 */
export function interactiveHookEnv(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const {
    FLEET_HEADLESS: _headless,
    FLEET_WORKER: _worker,
    // mirasim 托管标记跟着启动测试的宿主走，不该让夹具里的会话被当成托管的（#4013）
    MIRASIM_SESSION_KEY: _mirasim,
    CLAUDE_CODE_SESSION_ID: _claude,
    CODEX_THREAD_ID: _thread,
    CODEX_SESSION_ID: _session,
    CODEX_HOME: _codexHome,
    ...env
  } = inherited;
  return env;
}
