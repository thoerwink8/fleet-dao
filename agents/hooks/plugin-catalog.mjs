// 过程组目录（决定 0085）。加载器按这份把钩子写进订阅了的仓。
// 命令指向这台 ~/.fleet-dao/hooks/ 里同步装上的脚本，不指向别的仓的 agents/hooks/。
// 加一条过程钩子改这里，不改加载器的判断。

/** @typedef {{ event: string, script: string, timeout: number }} ProcessHook */

/** @type {ProcessHook[]} */
export const PROCESS_HOOKS = [
  { event: 'SessionStart', script: 'bootstrap.mjs', timeout: 120 },
  { event: 'SessionStart', script: 'session-start.mjs', timeout: 90 },
  { event: 'PreToolUse', script: 'main-thread.mjs', timeout: 10 },
  { event: 'Stop', script: 'stop.mjs', timeout: 10 },
  { event: 'UserPromptSubmit', script: 'prompt-log.mjs', timeout: 30000 },
];
