// 过程组目录。加载器按这份把钩子写进订阅了的仓。
// 命令指向这台 ~/.fleet-dao/hooks/ 里同步装上的脚本，不指向别的仓的 agents/hooks/。
// 加一条过程钩子改这里，不改加载器的判断。

/**
 * timeout 按秒。async：后台跑、收尾不等它；asyncRewake：后台跑，以退出码 2 结束时把 stderr 塞给模型并叫醒它
 * （rewakeMessage 是塞的那段的前缀，rewakeSummary 是终端里给人看的一行；Claude Code 2.1.296 起）。后台钩子的 timeout 是它最长能跑多久。
 * @typedef {{
 *   event: string,
 *   script: string,
 *   timeout: number,
 *   async?: boolean,
 *   asyncRewake?: boolean,
 *   rewakeMessage?: string,
 *   rewakeSummary?: string,
 * }} ProcessHook
 */

/** @type {ProcessHook[]} */
export const PROCESS_HOOKS = [
  { event: 'SessionStart', script: 'bootstrap.mjs', timeout: 120 },
  { event: 'SessionStart', script: 'session-start.mjs', timeout: 90 },
  { event: 'PreToolUse', script: 'main-thread.mjs', timeout: 10 },
  { event: 'PostToolUse', script: 'continuation-progress.mjs', timeout: 10 },
  { event: 'Stop', script: 'stop.mjs', timeout: 10 },
  // 收尾后盯账（单 #2488）：盯账进程最多等 3 小时（inbox-watch.mjs 的 WATCH_MAX_MS），超时给到 3 小时 10 分
  {
    event: 'Stop',
    script: 'inbox-watch.mjs',
    timeout: 11_400,
    asyncRewake: true,
    rewakeMessage:
      '盯账钩子（inbox-watch.mjs）：下面是创始人在 Mirasim 发了、但 Mirasim 没送进来的话（你这一轮收尾后、后台子代理还在跑时他发的引导；带北京时间发出时间，原文照贴）。先回他一句，再接着干。只有一行「对账没查成」的是没核成账，不是他的话：',
    rewakeSummary: '创始人有话没送进来，已叫醒主线程',
  },
  // pnpm work run 派出的工人到终态才叫醒派它的会话（单 #2761）：最多等 3 小时（work-watch.mjs 的 WATCH_MAX_MS），超时同上
  {
    event: 'Stop',
    script: 'work-watch.mjs',
    timeout: 11_400,
    asyncRewake: true,
    rewakeMessage:
      '工人钩子（work-watch.mjs）：下面是 pnpm work run 派出去的本机工人到了终态（做完、没做成、或看护进程没了）。给创始人报一行，再按结果接着派下一件、或修、或 pnpm work run <单号> 续：',
    rewakeSummary: '本机工人到终态，已叫醒主线程',
  },
  { event: 'UserPromptSubmit', script: 'prompt-log.mjs', timeout: 30 },
];
