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
 * 通用段写进哪几份全局文件。Cursor CLI 没有用户级文件、zcode 被 Mirasim 隔离了家目录，做不到全局，只能靠仓里的 AGENTS.md。
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

export interface HookTarget {
  /** 登记钩子的设置文件（JSON，钩子在它的 hooks 里） */
  settings: Place;
  /** 读这份的各家；只要装了其中一家就写 */
  readers: readonly AgentId[];
  /** readers 里借道读这份的 */
  borrowed?: readonly AgentId[];
  hooks: readonly HookSpec[];
}

/**
 * 钩子装到哪。Claude Code 的用户级钩子在 ~/.claude/settings.json 的 hooks 里（code.claude.com/docs/en/hooks）：
 * SessionStart 的输出进会话上下文；PreToolUse 退出码 2 拦下、stderr 给模型看；Stop 平时只提醒（systemMessage），
 * 退出码恒为 0（Stop 上 exit 2 是「不许停」）；只有开了无人值守（agents/hooks/unattended.mjs）才输出 decision:block 挡住收尾。
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
 * 第一组还挂了 Agent、Task、Monitor、Workflow：不是要判它们，是起后台活的这一下要记一笔、自动开一个短的无人值守（agents/hooks/unattended.mjs 的
 * armForBackground，创始人 2026-10-04「选 1」），pretool.mjs 见到这几个名字记完就放行。引擎经 --settings 自带的那条（adapters 的 PRETOOL_MATCHER）不加：引擎会话不靠无人值守兜底。
 * Stop 事件借道的几家支不支持没一一核过：不支持就是从来不触发，装了也无害。
 */
export const HOOK_TARGETS: readonly HookTarget[] = [
  {
    settings: { win32: '.claude\\settings.json', linux: '.claude/settings.json' },
    readers: ['claude', 'grok', 'devin'],
    borrowed: ['grok', 'devin'],
    hooks: [
      { event: 'SessionStart', script: 'session-start.mjs', timeout: 90 },
      {
        event: 'PreToolUse',
        matcher: 'Bash|PowerShell|Read|Grep|Agent|Task|Monitor|Workflow',
        script: 'pretool.mjs',
        timeout: 10,
      },
      { event: 'PreToolUse', matcher: '^(exec|read|grep)$', script: 'pretool.mjs', timeout: 10 },
      { event: 'Stop', script: 'stop.mjs', timeout: 10 },
      // 创始人每条消息一到就原样落盘一份（2026-10-04 他问「丢失我的回复」）。为什么要有它、为什么
      // 绝不 exit 2 / 绝不输出、超时为什么是 30000 这些，写在 agents/hooks/prompt-log.mjs 开头。
      // UserPromptSubmit 不吃 matcher，别写；timeout 按毫秒算，写小了等于钩子从没跑成。
      { event: 'UserPromptSubmit', script: 'prompt-log.mjs', timeout: 30000 },
    ],
  },
];

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
 * 装了、但没装钩子的各家，逐家报一行为什么（不假装装了）。能接的几家接上是 #232。2026-09-26 查的各家文档和本机装的版本：
 * - Codex：~/.codex/hooks.json 和 Claude 同一个格式，可每条非托管的钩子都要人在 Codex 里 /hooks 审过、信任了才跑
 *   （learn.chatgpt.com/docs/hooks）。
 * - Kimi Code：~/.kimi-code/config.toml 的 [[hooks]]（TOML，事件名和 Claude 一样）。
 * - Antigravity：~/.gemini/config/hooks.json，没有开会话事件，调工具前的输入输出是另一套 JSON（antigravity.google/docs/hooks）。
 * - Gemini CLI：~/.gemini/settings.json 的 hooks，调工具前叫 BeforeTool、终端工具叫 run_shell_command（gemini-cli docs/hooks）。
 * - pi：没有配置式钩子，要写成 TypeScript 扩展（pi-coding-agent docs/extensions.md）。
 * - dsh：没有自带的全局钩子，只有要手动挂的桥接插件（deepseek-harness packages/hooks）。
 */
export const HOOK_GAPS: Partial<Record<AgentId, string>> = {
  codex: '它有钩子（~/.codex/hooks.json），可每条都要人在 Codex 里用 /hooks 审过、信任了才跑，本脚本还没接',
  kimi: '它有钩子（~/.kimi-code/config.toml 的 [[hooks]]，TOML），本脚本还没接',
  agy: '它的钩子是另一套（~/.gemini/config/hooks.json：没有开会话事件，调工具前的输入输出是另一种 JSON），本脚本还没接',
  gemini:
    '它的钩子是另一套（~/.gemini/settings.json：调工具前叫 BeforeTool，终端工具叫 run_shell_command），本脚本还没接',
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
