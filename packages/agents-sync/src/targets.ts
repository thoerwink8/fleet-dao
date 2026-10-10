// 各家 AI 从哪读全局说明、从哪读 skill。每个落点 Windows、Linux 各写一列（相对家目录），按平台选。
// 依据：各家的官方文档或源码（下面逐条注明）；改之前先查那一家现在的读法，别凭印象加落点。
// 环境变量改过位置的（CODEX_HOME、PI_CODING_AGENT_DIR、KIMI_CODE_HOME、DSH_HOME、CLAUDE_CONFIG_DIR 等）一概不跟：
// 跟了就会随调用者的环境写到别处（测试拿临时家目录跑，也会被带到真家目录去）。

export type Platform = 'win32' | 'linux';

export interface Agent {
  /** 给人看的名字 */
  name: string;
  /** PATH 或家目录的 .local/bin 里找得到其中一个，就算这台装了 */
  bins: readonly string[];
  /** 另外还在家目录下的这几处找（官方安装脚本装在自己目录、不进 PATH 的） */
  homeDirs?: readonly Place[];
}

export const AGENTS = {
  claude: { name: 'Claude Code', bins: ['claude', 'reclaude'] },
  // 官方安装脚本装在 ~/.grok/bin/grok；法国装的时候故意不让它往 ~/.local/bin 链（deploy/lib/grok.sh 开头），不在 PATH 上
  grok: { name: 'Grok', bins: ['grok'], homeDirs: [{ win32: '.grok\\bin', linux: '.grok/bin' }] },
  devin: { name: 'Devin CLI', bins: ['devin'] },
  codex: { name: 'Codex', bins: ['codex'] },
  pi: { name: 'pi', bins: ['pi'] },
  kimi: { name: 'Kimi Code', bins: ['kimi'] },
  dsh: { name: 'dsh', bins: ['dsh'] },
  agy: { name: 'Antigravity', bins: ['agy'] },
  gemini: { name: 'Gemini CLI', bins: ['gemini'] },
} as const satisfies Record<string, Agent>;

export type AgentId = keyof typeof AGENTS;

/** 一个落点在两个平台上的相对路径（相对家目录） */
export interface Place {
  win32: string;
  linux: string;
}

export interface RulesTarget {
  file: Place;
  /** 读这份的各家；只要装了其中一家就写 */
  readers: readonly AgentId[];
  /** readers 里借道读这份的（它们自己的全局文件不另放，放了会读到两遍） */
  borrowed?: readonly AgentId[];
  /** 这些文件在的话，那一家只读它、不读这份 */
  shadowedBy?: readonly Place[];
}

export interface SkillTarget {
  dir: Place;
  readers: readonly AgentId[];
  borrowed?: readonly AgentId[];
}

/**
 * 通用段写进哪几份全局文件。Cursor CLI 没有用户级文件、zcode 被 Mirasim 隔离了家目录，做不到全局，只能靠仓里的 AGENTS.md（fleet-dao 的仓根 AGENTS.md 顶上一行指到 agents/shared-rules.md）。
 * - Claude Code 只认 ~/.claude/CLAUDE.md（不读用户级 AGENTS.md）；Grok、Devin CLI 默认也读这份、都不认 @ 导入，
 *   所以这里放全文，它们俩不另放（~/.grok/AGENTS.md、Devin 的 AGENTS.md 再放一份就读两遍）。
 * - Codex：~/.codex/ 下 AGENTS.override.md 在就只读它（codex-rs/codex-home/src/instructions/mod.rs）。
 * - pi：~/.pi/agent/ 下按 AGENTS.override.md、AGENTS.md… 取第一份（dist/core/resource-loader.js）。
 * - Kimi Code：~/.kimi-code/AGENTS.md 和 ~/.agents/AGENTS.md 两处都读，只放前一处。
 * - Antigravity：~/.gemini/ 下 AGENTS.md、GEMINI.md 都读，只放 GEMINI.md（Gemini CLI 也读它）。
 */
export const RULES_TARGETS: readonly RulesTarget[] = [
  {
    file: { win32: '.claude\\CLAUDE.md', linux: '.claude/CLAUDE.md' },
    readers: ['claude', 'grok', 'devin'],
    borrowed: ['grok', 'devin'],
  },
  {
    file: { win32: '.codex\\AGENTS.md', linux: '.codex/AGENTS.md' },
    readers: ['codex'],
    shadowedBy: [{ win32: '.codex\\AGENTS.override.md', linux: '.codex/AGENTS.override.md' }],
  },
  {
    file: { win32: '.pi\\agent\\AGENTS.md', linux: '.pi/agent/AGENTS.md' },
    readers: ['pi'],
    shadowedBy: [{ win32: '.pi\\agent\\AGENTS.override.md', linux: '.pi/agent/AGENTS.override.md' }],
  },
  { file: { win32: '.kimi-code\\AGENTS.md', linux: '.kimi-code/AGENTS.md' }, readers: ['kimi'] },
  { file: { win32: '.dsh\\AGENTS.md', linux: '.dsh/AGENTS.md' }, readers: ['dsh'] },
  { file: { win32: '.gemini\\GEMINI.md', linux: '.gemini/GEMINI.md' }, readers: ['agy', 'gemini'] },
];

/**
 * skill 拷到哪几个目录。
 * - ~/.claude/skills：Claude Code；Grok 的 Claude 兼容默认也扫这里（~/.grok/docs/user-guide/08-skills.md）。
 * - ~/.agents/skills：Codex（developers.openai.com/codex/skills 的 USER 一档）、Kimi Code（用户级通用 skill）、
 *   Devin CLI（docs.devin.ai/cli/extensibility/skills/overview）、Grok（每一档都扫 .agents/skills）、
 *   pi 0.87 起也扫（dist/core/package-manager.js 的 userAgentsSkillsDir）。
 *   所以 ~/.pi/agent/skills 不另放：两处各一份拷贝，pi 会逐个报「name collision」。
 *   Devin 不扫 ~/.claude/skills（它借 Claude 的只有项目里的 .claude/skills），Grok 两处都扫、同名去重。
 * - ~/.gemini/config/skills：Antigravity 命令行的全局 skill。官方网页写的是 ~/.gemini/antigravity-cli/skills，
 *   agy 1.2.11 程序里却只认 ~/.gemini/config/skills（和桌面版共用的全局配置目录，2026-09-25 本机核过）。
 */
export const SKILL_TARGETS: readonly SkillTarget[] = [
  {
    dir: { win32: '.claude\\skills', linux: '.claude/skills' },
    readers: ['claude', 'grok'],
    borrowed: ['grok'],
  },
  {
    dir: { win32: '.agents\\skills', linux: '.agents/skills' },
    readers: ['codex', 'pi', 'kimi', 'devin', 'grok'],
  },
  {
    dir: { win32: '.gemini\\config\\skills', linux: '.gemini/config/skills' },
    readers: ['agy'],
  },
];

export interface SubagentTarget {
  dir: Place;
  readers: readonly AgentId[];
  /** 只装这几份（文件名，原件在仓里 agents/subagents/ 下同名）；不扫目录 */
  files: readonly string[];
}

/**
 * 用户级子代理定义装到哪、装哪几份。Claude Code 的用户级子代理在 ~/.claude/agents/<名>.md（code.claude.com/docs/en/sub-agents
 * 的 User-level 一档：这台上所有项目里都能用）。
 * - 只装 files 列的几份，不扫目录：~/.claude/agents/ 里机器上手写的（把内置子代理钉到别名模型的 Explore.md、Plan.md 这类）
 *   一律不碰、不删；仓里 .claude/agents/ 的 fleet-* 是本仓项目级的（决定 0036），随 git 走，不往家里装。
 * - haiku55.md：别名 haiku 在本机指向 Haiku 4.5，要真 5.5 只能靠写死完整 id 的自定义子代理（决定 0035，#1393）。
 *   别的仓、别的机器没有 fleet-* 那批定义，靠它派 Haiku 5.5。
 * - 只给 Claude Code：Grok、Devin 借道读 ~/.claude 的规矩和钩子，认不认这里的子代理定义没核过，不算它们的。
 * 同名文件内容不同就先整份备份再换成仓里的、报出来（这几份归仓里管）。从 files 里去掉的，清单记着是本脚本装的才撤（先备份）。
 * 加减一份是改标准；agents/test/rules/subagent-model.rules.test.ts 钉着 haiku55.md 在列。
 */
export const SUBAGENT_TARGET: SubagentTarget = {
  dir: { win32: '.claude\\agents', linux: '.claude/agents' },
  readers: ['claude'],
  files: ['haiku55.md'],
};

/** agents/hooks/ 下的脚本整份拷到这里（相对家目录）；各家设置里登记的命令指向这里。整个目录归本脚本管 */
export const HOOKS_DIR: Place = { win32: '.fleet-dao\\hooks', linux: '.fleet-dao/hooks' };

/** 一条钩子：什么事件、匹配哪些工具、跑 agents/hooks/ 下的哪个脚本、最多等几秒 */
export interface HookSpec {
  event: string;
  /** 不写 = 这个事件全都跑 */
  matcher?: string;
  script: string;
  timeout: number;
}

/**
 * 钩子设置文件的写法：
 * - claude：JSON，hooks 下按事件名各一个数组，每项 { matcher?, hooks: [{ type: 'command', command, timeout }] }；
 *   顶层 disableAllHooks 开着就一条都不跑。
 * - codex：和 claude 同一个写法（~/.codex/hooks.json 顶层只许 description、hooks 两个键）；每条非托管的钩子要信任了才跑，
 *   信任记在 ~/.codex/config.toml（hooks-codex.ts）。
 * - gemini：和 claude 同一个写法（~/.gemini/settings.json 的 hooks），timeout 按毫秒算；
 *   hooksConfig.enabled 是 false 就一条都不跑，hooksConfig.disabled 里列了的那条不跑。
 * - agy：JSON，顶层每一项是一个起了名字的钩子，{ enabled?, <事件>: [{ matcher, hooks: [{ type, command, timeout }] }] }；
 *   本脚本只管名字叫 name（fleet-dao）的那一项，整项归它；那一项 enabled 是 false 就不跑。
 * - kimi：TOML，[[hooks]] 一条一张表，只许 event、matcher、command、timeout 四个键（多一个整份配置读不起来）。
 *   本脚本的几条写在文件末尾一块托管块里（两行注释圈起来，hooks-kimi.ts），块外一个字不碰。
 */
export type HookFormat = 'claude' | 'codex' | 'gemini' | 'agy' | 'kimi';

export interface HookTarget {
  /** 登记钩子的设置文件（JSON，钩子在它的 hooks 里） */
  settings: Place;
  format: HookFormat;
  /**
   * Windows 上命令也写 node 加引号，不用不带控制台的启动器：这家在 Windows 上用 PowerShell 跑钩子命令。
   * PowerShell 起不带控制台的程序不等它退出，$LASTEXITCODE 拿不到退出码 2，拦下就变成放行
   * （2026-10-09 本机试过：同一个启动器 cmd /C 下退出码 2，PowerShell 下 0）。
   */
  nodeOnWindows?: true;
  /** agy 写法里本脚本那一项的名字（顶层的键） */
  name?: string;
  /** 这家有、但没登记的那类钩子和为什么（每次查、写都报一行，不假装装了） */
  lacks?: { what: string; why: string };
  /** 读这份的各家；只要装了其中一家就写 */
  readers: readonly AgentId[];
  /** readers 里借道读这份的 */
  borrowed?: readonly AgentId[];
  hooks: readonly HookSpec[];
}

/**
 * 钩子装到哪。Claude Code 的用户级钩子在 ~/.claude/settings.json 的 hooks 里（code.claude.com/docs/en/hooks）：
 * SessionStart 的输出进会话上下文；PreToolUse 退出码 2 拦下、stderr 给模型看；Stop 平时只提醒（systemMessage），
 * 退出码恒为 0（Stop 上 exit 2 是「不许停」）。没开无人值守时 Stop 不输出 decision:block；只有这个会话自己跑了 unattended.mjs on 才挡收尾（决定 0028，推翻 0026 的「收尾不拦」；起后台活不自动开仍是 0026）。
 * 开会话那条要取远端、快进、跑一遍同步，给足 90 秒。
 * 借道读这份的：Grok 默认扫 ~/.claude/settings.json 的钩子（~/.grok/docs/user-guide/10-hooks.md「Hook Locations」，
 * 输入是 camelCase、终端工具叫 run_terminal_command，开会话钩子的输出不进上下文）；Devin CLI 默认 read_config_from.claude
 * （docs.devin.ai/cli/extensibility/hooks/overview，终端工具叫 exec）。Cursor 的命令行默认也读（cursor.com/docs/reference/third-party-hooks，
 * Bash 对应它的 Shell），它不在本脚本分发的各家里。脚本按这几种输入都认得（agents/hooks/pretool.mjs 的 SHELL_TOOLS）。
 * 调工具前那条还挂在读文件、搜内容的 Read、Grep 上：会话用它们把密钥文件读进对话的也拦（2026-09-27 用命令读漏过一回，
 * 只拦命令等于没拦）。Glob 只列路径、和 ls 一样放行，不挂。借道的几家怎么对上：Claude Code 的 matcher 只含字母和 | 时
 * 按工具名逐个全等比（code.claude.com/docs/en/hooks「Matcher patterns」）；Grok 把 Bash、Read、Grep 换成它的
 * run_terminal_command、read_file、grep 再匹配（~/.grok/docs/user-guide/10-hooks.md「Tool Name Aliases」）；Cursor 把 Bash
 * 换成 Shell，Read、Grep 照原名（cursor.com/docs/reference/third-party-hooks「Tool Name Mapping」）。Devin 不换名字，
 * matcher 是不锚定的正则、对它自己的小写工具名（docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks「Tool names you can
 * match」）：第一组它一个都匹配不上，所以另登记锚定的一组 ^(exec|read|grep)$（不锚定的 read 会连 notebook_read、
 * read_subagent、mcp_read_resource 一起匹配上，脚本认不得那些名字就会把它们全拦下；这组在 Claude Code、Cursor 里匹配不到
 * 任何工具，在 Grok 里只多匹配一次它的 grep）。脚本认得的名字：agents/hooks/pretool.mjs 的 SHELL_TOOLS、READ_TOOLS。
 * 第一组还挂了 Agent、Task、Monitor、Workflow：不是要判它们。决定 0026 删掉了「起后台活自动开无人值守」，
 * pretool.mjs 见到这几个名字记完就放行（decide 不认识它们的名字，不放行会被拦）。
 * mcp__mirasim__deliver_artifact、PushNotification 同理：decide 不认识这两个名字，不放行会被拦，所以登记上、见到就放行（pretool.mjs 的 DELIVERY_TOOLS，两边一起改）。决定 0027 起不再为它们记账。引擎经 --settings 自带的那条（adapters 的 PRETOOL_MATCHER）不加：引擎会话不靠这条放行。
 * Stop 事件借道的几家支不支持没一一核过：不支持就是从来不触发，装了也无害。
 *
 * 各家自己的钩子（#232；拦命令、开会话同步两条，别的不装）。调工具前那条各家跑自己的入口 pretool-<家>.mjs：
 * 先把那家的输入翻成 Claude 的写法，再交给 pretool.mjs 同一份判断（agents/hooks/vendor-pretool.mjs）。
 * - Codex：~/.codex/hooks.json，写法和 Claude 一样（learn.chatgpt.com/docs/hooks）。跑命令的工具一律叫 Bash，
 *   Codex 没有单独读文件、搜内容的工具，都走终端；matcher 是正则，锚定成 ^Bash$。开会话那条的输出
 *   （hookSpecificOutput.additionalContext）进会话上下文；timeout 按秒算。每条非托管的钩子要信任了才跑：
 *   信任记在 ~/.codex/config.toml 的 [hooks.state."<hooks.json 路径>:<事件>:<组>:<条>"] trusted_hash 里，
 *   同步替本脚本登记的这几条记上（和在 Codex 里 /hooks 点信任一样），见 hooks-codex.ts。
 *   Windows 上 Codex 用 cmd /C 跑钩子命令（codex-rs/hooks/src/engine/command_runner.rs 的 build_command），启动器照用。
 * - Gemini CLI：~/.gemini/settings.json 的 hooks（github.com/google-gemini/gemini-cli docs/hooks/reference.md）。
 *   调工具前的事件叫 BeforeTool，timeout 按毫秒算；退出码 2 拦下、stderr 是理由；stdout 只能是 JSON，空着就是没意见。
 *   matcher 是正则，锚定成 ^(…)$：run_shell_command 跑命令，read_file、read_many_files 读文件，
 *   grep_search 搜内容（旧名 search_file_content）（docs/reference/tools.md）。glob、list_directory 只列路径，不挂。
 *   开会话叫 SessionStart，输出的 hookSpecificOutput.additionalContext 进会话上下文。用户级的钩子不用信任，项目级的才要。
 *   Windows 上 Gemini CLI 用 PowerShell 跑钩子命令（packages/core/src/hooks/hookRunner.ts），所以命令写 node（nodeOnWindows）。
 * - Antigravity：~/.gemini/config/hooks.json，命令行、桌面版共用（antigravity.google/docs/hooks；agy 1.3.2 程序里带的
 *   「Lifecycle Hooks (hooks.json)」一页）。顶层每项是一个起了名字的钩子，本脚本那一项叫 fleet-dao。
 *   只有 PreToolUse、PostToolUse、PreInvocation、PostInvocation、Stop，没有开会话事件，开会话那条不登记（lacks）。
 *   调工具前的输入是 camelCase：{ toolCall: { name, args }, workspacePaths, … }，没有会话目录；回话是 stdout 一份 JSON：
 *   拦下 { decision: 'deny', reason }，没意见回 {}（decision 是空的按没意见处理，agy 的更新说明写过这一条；
 *   不回 allow：allow 是「不问人直接放行」，会绕过它自己的审批）。命令在 Windows 上经 cmd /c 跑，启动器照用；timeout 按秒算。
 *   matcher 是正则，锚定成 ^(…)$：run_command 跑命令，view_file 读文件，grep_search 搜内容。
 * - Kimi Code：~/.kimi-code/config.toml 的 [[hooks]]（github.com/MoonshotAI/kimi-code docs/en/customization/hooks.md）。
 *   事件名、输入（tool_name、tool_input、cwd）和 Claude 一样，退出码 2 拦下、stderr 是理由；别的退出码、超时一律放行（它的
 *   fail-open，所以钩子脚本自己出错时要按拦处理并退出 2）。工具名就是 Bash、Read、Grep，matcher 锚定成 ^(Bash|Read|Grep)$。
 *   Bash 在 Windows 上也是 Git Bash（packages/kaos/src/environment.ts）；钩子命令经 Node 的 shell: true 跑，Windows 上是
 *   cmd（packages/agent-core-v2/src/features/externalHooks/internal/runHook.ts），启动器照用。timeout 按秒算。
 *   开会话那条（SessionStart）只看不拦，输出不保证进会话上下文，登记它是为了开会话就同步规矩。
 */
export const HOOK_TARGETS: readonly HookTarget[] = [
  {
    settings: { win32: '.claude\\settings.json', linux: '.claude/settings.json' },
    format: 'claude',
    readers: ['claude', 'grok', 'devin'],
    borrowed: ['grok', 'devin'],
    hooks: [
      { event: 'SessionStart', script: 'session-start.mjs', timeout: 90 },
      {
        event: 'PreToolUse',
        matcher:
          'Bash|PowerShell|Read|Grep|Agent|Task|Monitor|Workflow|mcp__mirasim__deliver_artifact|PushNotification',
        script: 'pretool.mjs',
        timeout: 10,
      },
      { event: 'PreToolUse', matcher: '^(exec|read|grep)$', script: 'pretool.mjs', timeout: 10 },
      // 主对话的两条（决定 0078）：引导先回、子代理一律后台跑。不写 matcher，每次工具调用都过；
      // 判断、为什么、Grok 借道时怎么办写在 agents/hooks/main-thread.mjs 开头。
      { event: 'PreToolUse', script: 'main-thread.mjs', timeout: 10 },
      { event: 'Stop', script: 'stop.mjs', timeout: 10 },
      // 创始人每条消息一到就原样落盘一份（2026-10-04 他问「丢失我的回复」）。为什么要有它、为什么
      // 绝不 exit 2 / 绝不输出、超时为什么是 30000 这些，写在 agents/hooks/prompt-log.mjs 开头。
      // UserPromptSubmit 不吃 matcher，别写；timeout 按毫秒算，写小了等于钩子从没跑成。
      { event: 'UserPromptSubmit', script: 'prompt-log.mjs', timeout: 30000 },
    ],
  },
  {
    settings: { win32: '.codex\\hooks.json', linux: '.codex/hooks.json' },
    format: 'codex',
    readers: ['codex'],
    hooks: [
      { event: 'SessionStart', script: 'session-start.mjs', timeout: 90 },
      { event: 'PreToolUse', matcher: '^Bash$', script: 'pretool-codex.mjs', timeout: 10 },
    ],
  },
  {
    settings: { win32: '.gemini\\settings.json', linux: '.gemini/settings.json' },
    format: 'gemini',
    nodeOnWindows: true,
    readers: ['gemini'],
    hooks: [
      { event: 'SessionStart', script: 'session-start.mjs', timeout: 90_000 },
      {
        event: 'BeforeTool',
        matcher: '^(run_shell_command|read_file|read_many_files|grep_search|search_file_content)$',
        script: 'pretool-gemini.mjs',
        timeout: 10_000,
      },
    ],
  },
  {
    settings: { win32: '.gemini\\config\\hooks.json', linux: '.gemini/config/hooks.json' },
    format: 'agy',
    name: 'fleet-dao',
    lacks: {
      what: '开会话钩子',
      why: 'Antigravity 没有开会话事件（只有 PreToolUse、PostToolUse、PreInvocation、PostInvocation、Stop），没登记；这台的规矩靠别家开会话、或手动跑 pnpm agents:sync 同步',
    },
    readers: ['agy'],
    hooks: [
      {
        event: 'PreToolUse',
        matcher: '^(run_command|view_file|grep_search)$',
        script: 'pretool-agy.mjs',
        timeout: 10,
      },
    ],
  },
  {
    settings: { win32: '.kimi-code\\config.toml', linux: '.kimi-code/config.toml' },
    format: 'kimi',
    readers: ['kimi'],
    hooks: [
      { event: 'SessionStart', script: 'session-start.mjs', timeout: 90 },
      { event: 'PreToolUse', matcher: '^(Bash|Read|Grep)$', script: 'pretool-kimi.mjs', timeout: 10 },
    ],
  },
];

/** Codex 记钩子信任的地方：~/.codex/config.toml 的 [hooks.state."…"]（hooks-codex.ts） */
export const CODEX_CONFIG: Place = { win32: '.codex\\config.toml', linux: '.codex/config.toml' };

/**
 * 权限装到哪：Claude Code 的用户级权限在 ~/.claude/settings.json 的 permissions 里（code.claude.com/docs/en/permissions），
 * defaultMode 只认用户级和 --settings 的（项目级的 auto 它会忽略）。内容来自仓里 agents/config/claude-permissions.json。
 * 只给 Claude Code：别家的权限不是这个格式，Grok、Devin 借道读钩子那份设置文件，不代表它们按这个格式认 permissions。
 */
export const PERMISSIONS_TARGET: { settings: Place; readers: readonly AgentId[] } = {
  settings: { win32: '.claude\\settings.json', linux: '.claude/settings.json' },
  readers: ['claude'],
};

/**
 * 其他几家的权限（2026-09-30 逐家核过文档、能装的在本机实测；写法各不相同，都不读 Claude 的 permissions，Grok 除外）：
 * - Kimi Code：~/.kimi-code/config.toml 的顶层 default_permission_mode（manual / yolo / auto）和 [[permission.rules]]
 *   （decision、pattern，先匹配的生效，所以拒绝排在放行前面；moonshotai.github.io/kimi-code/en/configuration/config-files.md）。
 *   同步用 auto（不打断、自动判断）：创始人 2026-09-30 要最宽松，他有时在图形界面里起 CLI、没法切模式也没人点确认；
 *   yolo 是「日常自动、危险的仍问」，会在没人点的界面里卡住。
 * - Codex：~/.codex/rules/default.rules 里的 prefix_rule(pattern=["git"], decision="allow" | "forbidden")，只按命令前缀、
 *   不支持通配符，几条同时命中取最严的；本机用 codex execpolicy check 核过写法（learn.chatgpt.com/docs/agent-configuration/rules）。
 * - Devin：Windows %APPDATA%\devin\config.json、Linux ~/.config/devin/config.json 的 permissions.allow/deny（Exec(git)、Read(**)、
 *   Write(**)），不读 Claude 的权限；默认模式的键文档没说清在不在 config.json 里，不同步（docs.devin.ai/cli/reference/permissions，
 *   本机没装、没实测）。
 */
export const KIMI_PERMISSIONS: { file: Place; readers: readonly AgentId[] } = {
  file: { win32: '.kimi-code\\config.toml', linux: '.kimi-code/config.toml' },
  readers: ['kimi'],
};
export const CODEX_PERMISSIONS: { file: Place; readers: readonly AgentId[] } = {
  file: { win32: '.codex\\rules\\default.rules', linux: '.codex/rules/default.rules' },
  readers: ['codex'],
};
export const DEVIN_PERMISSIONS: { file: Place; readers: readonly AgentId[] } = {
  file: { win32: 'AppData\\Roaming\\devin\\config.json', linux: '.config/devin/config.json' },
  readers: ['devin'],
};

/**
 * 装了、但权限没接的各家，逐家报一行为什么（不假装装了）。
 * - Grok：直接读 ~/.claude/settings.json 的 permissions（含 defaultMode），随 Claude 那份生效，不另写
 *   （~/.grok/docs/user-guide/22-permissions-and-safety.md 第 3 节）；它不认的工具（NotebookEdit、PowerShell 这类）开会话时跳过并警告。
 */
export const PERMISSION_GAPS: Partial<Record<AgentId, string>> = {
  grok: '没另写——它直接读 ~/.claude/settings.json 的 permissions（含 defaultMode），随上面 Claude 那份生效（本机 grok inspect 实测：读到 34 条，跳过 9 条它不认的 NotebookEdit 和 PowerShell(…)，开会话时警告，不影响别的）',
  pi: '没接——它没有审批功能（默认全放行），只能靠扩展，本脚本不做',
  dsh: '没接——它只有 ask / never 两档，不能按命令写规则，没法照 Claude 的清单翻译',
  agy: '没接——写法（settings.json 的 permissions、command(git)）只来自博客，官方 issue #548 说无头模式会忽略 allow，装上实测后再接',
  gemini: '没接——规则要写在 ~/.gemini/policies/*.toml，还没实测，装上核过后再接',
};

/**
 * 装了、但没装钩子的各家，逐家报一行为什么（不假装装了）。有自己钩子的四家（Codex、Gemini CLI、Antigravity、Kimi Code）
 * #232 都接上了，在上面的 HOOK_TARGETS；剩下这两家没有配置式的钩子接口（2026-09-26 查的各家文档和本机装的版本）：
 * - pi：没有配置式钩子，要写成 TypeScript 扩展（pi-coding-agent docs/extensions.md）。
 * - dsh：没有自带的全局钩子，只有要手动挂的桥接插件（deepseek-harness packages/hooks）。
 */
export const HOOK_GAPS: Partial<Record<AgentId, string>> = {
  pi: '它没有配置式的钩子（要写成 TypeScript 扩展）',
  dsh: '它没有自带的全局钩子（只有要手动挂的桥接插件）',
};

/** 配置文件里本脚本管的一个开关：TOML 里 [table] 下的 key = value（value 照 TOML 字面量写，比如 false） */
export interface ConfigKey {
  table: string;
  key: string;
  value: string;
  /** 为什么要它：写进文件里那一项上面的注释，查出不对时也报这句 */
  why: string;
}

export interface ConfigKeyTarget {
  /** TOML 配置文件 */
  file: Place;
  readers: readonly AgentId[];
  keys: readonly ConfigKey[];
}

/**
 * 各家配置文件里本脚本管的开关：只动这里列的几项，文件里别的内容一行不碰；读不懂（多行字符串、表重复、
 * 用点号或内联表写在别处）就不动、报出来，不猜。
 * - Grok（~/.grok/config.toml）：免确认（permission_mode = "always-approve"）只管工具权限，管不到下面两张卡，
 *   无人值守和 Mirasim 经 grok agent stdio 起的会话都会卡着等人（docs/reference/adapters.md GK-12）。
 *   folder_trust.enabled 在 grok inspect 里报「unrecognized」，1.0.41 实测照样生效（没信任过的新目录照读 AGENTS.md）；
 *   计划模式没有配置开关（只有 grok -p 的 --no-plan），这里管不了。
 */
export const CONFIG_KEY_TARGETS: readonly ConfigKeyTarget[] = [
  {
    file: { win32: '.grok\\config.toml', linux: '.grok/config.toml' },
    readers: ['grok'],
    keys: [
      {
        table: 'folder_trust',
        key: 'enabled',
        value: 'false',
        why: '不弹「信不信这个目录」：没信任的目录 grok 不加载 AGENTS.md、项目钩子和技能，每个新工作树都是',
      },
      {
        table: 'features',
        key: 'ask_user_question',
        value: 'false',
        why: '不给模型反问选择题的工具：无人值守、Mirasim 里没人答会干等',
      },
    ],
  },
];

/** --retire-old 在这些 skill 目录里找指向旧仓的链接（各家的都扫，不只本脚本分发的那几个） */
export const RETIRE_SKILL_DIRS: readonly Place[] = [
  ...SKILL_TARGETS.map((t) => t.dir),
  { win32: '.pi\\agent\\skills', linux: '.pi/agent/skills' },
  { win32: '.codex\\skills', linux: '.codex/skills' },
  { win32: '.grok\\skills', linux: '.grok/skills' },
  { win32: '.kimi-code\\skills', linux: '.kimi-code/skills' },
  { win32: 'AppData\\Roaming\\devin\\skills', linux: '.config/devin/skills' },
  { win32: '.cursor\\skills', linux: '.cursor/skills' },
];

/** --retire-old 撤掉的两个旧仓子代理（dao-scout、dao-fixer 留着） */
export const RETIRE_FILES: readonly Place[] = [
  { win32: '.claude\\agents\\dao-vps-readback.md', linux: '.claude/agents/dao-vps-readback.md' },
  { win32: '.claude\\agents\\dao-chain-diagnoser.md', linux: '.claude/agents/dao-chain-diagnoser.md' },
];

/** 清单和备份都放这里（相对家目录）；各家都不扫它 */
export const STATE_DIR: Place = { win32: '.fleet-dao', linux: '.fleet-dao' };

/** 这个落点在本平台上的相对路径 */
export function placeOn(place: Place, platform: Platform): string {
  return place[platform];
}

/** 给人看、也当清单里的键：一律用 / 分隔 */
export function slashed(rel: string): string {
  return rel.replaceAll('\\', '/');
}

export function agentNames(ids: readonly AgentId[], borrowed: readonly AgentId[] = []): string {
  return ids.map((id) => `${AGENTS[id].name}${borrowed.includes(id) ? '（借道）' : ''}`).join('、');
}
