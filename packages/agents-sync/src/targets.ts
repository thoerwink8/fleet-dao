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
}

export const AGENTS = {
  claude: { name: 'Claude Code', bins: ['claude', 'reclaude'] },
  grok: { name: 'Grok', bins: ['grok'] },
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
