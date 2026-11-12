// 模型专属提示词编译器与战绩自进化引擎（Prompt Compiler & Auto-Evolution Loop）。
// 针对每个工种（Role）× 模型家族/具体型号（Model）动态拼装「三明治提示词」：
//   [1. 工种核心契约 Role Kernel]
// + [2. 模型脾气专属装甲 Model Overlay（含历史栽跟头自动提炼的反模式护栏）]
// + [3. 懒加载模块规矩 & Scout 预热代码切片 Pre-sliced Context]
import type { AgentRole, ModelFamily, ModelSpec } from './matrix.ts';

/** 单个模型在特定任务上的翻车记录（用于触发自进化）。 */
export interface FailureSample {
  id: string;
  modelId: string;
  role: AgentRole;
  category:
    | 'out-of-scope'
    | 'unverified-claim'
    | 'test-regression'
    | 'patch-instead-of-root'
    | 'syntax-or-type';
  summary: string;
  diffSnippet?: string;
  at: string;
}

/** 提炼出的模型专属反模式护栏（Anti-Pattern Rule）。 */
export interface EvolvedRule {
  id: string;
  modelId: string;
  category: FailureSample['category'];
  instruction: string;
  derivedFromSampleIds: string[];
  /** 灰度状态：candidate（小流量验证）| active（已转正固化）| revoked（效果不佳撤回）。 */
  status: 'candidate' | 'active' | 'revoked';
  beforePassRate: number;
  afterPassRate?: number;
}

/** 各工种的基础职责底座（短小精悍，不塞废话）。 */
export const ROLE_KERNELS: Readonly<Record<AgentRole, string>> = {
  commander:
    '你是总指挥官（Commander）。只管对题、拆解无冲突的波次子任务 DAG（标明 writeScope 与机器核对命令）、居中协调黑板消息，绝不亲自下场改业务代码。',
  planner:
    '你是架构规划师（Planner）。只读分析 Scout 给出的代码切片与需求，输出精确到文件与函数名的修改步骤、依赖关系（dependsOn）、写范围（writeScope）和一条确定性的机器验证命令。严禁修改任何文件。',
  'worker-code':
    '你是编码主力工人（Worker-Code）。只在授权的 writeScope 内做最小化、触及根因的修改（删掉出问题的那一层，不打外围补丁）。改完必须亲自跑验证命令并核对退出码为 0 后才准交活。',
  'worker-ui':
    '你是前端与视觉工人（Worker-UI）。使用统一的 shadcn/ui + Tailwind v4 令牌构建高密度、克制工业风界面（正常态只画灰点，异常才上色；数字加 .num tabular-nums）。改完必须验证 1440px 与 390px 双屏无横滚、无错位。',
  scout:
    '你是极速斥候（Scout）。只用只读工具（read/grep/find/codemode）在 20 秒内定位目标代码的精确文件路径、行号区间 [Lstart-Lend] 与核心类型签名，输出结构化浓缩切片供主力模型直接使用。',
  verifier:
    '你是异族独立冷验收员（Verifier）。不听信写码模型的自述，只对照【需求验收条】、【git diff】和【机械测试回执】检查三件事：①验收条是否真达成；②是否破坏已有功能；③有无安全/丢数据隐患。推测性风格意见一律不拦。',
  'ysk-watcher':
    '你是旁路监督员（you-should-know）。你不写代码，只盯着主 agent 刚改出的 git diff。专门挑出：「顺手改了需求外已上线的文案/导航/接口」「漏改了同构实现」「吞掉报错返回空或 0」。正常只回 OK，异常用一句话直指要害。',
};

/**
 * 针对市面上各主流模型的「能力短板与脾气补丁（Builtin Model Overlays）」。
 * 这是让次一级 Claude（如 Kiro）、DeepSeek（CommonCode/OpenCode）、Codex、Grok、Gemini 都能当编码主力的核心秘密。
 */
export const FAMILY_OVERLAYS: Readonly<Record<ModelFamily, string>> = {
  claude: [
    '【Claude 专属调优】',
    '- 善用 codemode 一次批处理多个独立文件读取与搜寻，把 5 个回合压成 1 个回合。',
    '- 严禁过度防御（不要加冗余的 fallback 空数组/空字符串兜底，读不到就明确抛错返回失败）。',
    '- 若当前运行在 Haiku 轻档，回复首行必须声明自身完整 model id，并在交活前原样贴出测试命令的终端输出。',
  ].join('\n'),
  deepseek: [
    '【DeepSeek (V4 Pro / V3 / R1) 编码主力调优】',
    '- 严格执行三步走状态机：① 核对预喂的代码切片行号 → ② 精确调用 edit 工具替换（保持 oldText 唯一且最小） → ③ 立即调用 bash 运行验证命令。',
    '- 严禁在未看到验证命令真实退出码 0 的情况下宣称完成；严禁省略代码片段用注释「// ... 其余不变」代替。',
    '- 遇到跨文件类型变更，先调 publish_fact 广播给同波次会话。',
  ].join('\n'),
  gpt: [
    '【GPT / Recodex 专属调优】',
    '- 严禁反问用户或输出长篇前置礼貌套话，直接给结论或调工具。',
    '- 发挥严密逻辑优势：写修复前先构造能复现该 bug 的最小断言，再改实现让测试转绿。',
    '- 严禁触碰任何前端样式与视觉组件（worker-ui 硬禁令）。',
  ].join('\n'),
  grok: [
    '【Grok Heavy 专属调优】',
    '- 专注疑难并发竞态、系统级排障与二轮盲审挑错；给出结论时必须附带精确的 文件:行号 证据。',
    '- 修改代码时保持极度克制，严禁顺手重构无关函数或格式化未授权文件。',
  ].join('\n'),
  gemini: [
    '【Antigravity / Gemini 专属调优】',
    '- 利用超大上下文优势做跨包全链路对齐，但每次 edit 必须只改明确点名的文件，严禁发散修改范围。',
    '- 执行 UI 视觉审查时，逐一比对 1440px 与 390px 截图中的对齐、留白、文字截断与对比度。',
  ].join('\n'),
  swe: [
    '【Devin SWE-2 极速盯梢与斥候调优】',
    '- 保持极高信噪比：做 Scout 时只列「文件路径 + 行号区间 + 关键函数签名」；做 YSK 盯梢时无越界只回 OK，有越界一句话点名改坏了哪处已上线逻辑。',
  ].join('\n'),
  kimi: ['【Kimi 专属调优】', '- 长文本归纳与中文业务语义对齐优先；动手改码后必须逐条核对验收清单。'].join(
    '\n',
  ),
  glm: ['【GLM 专属调优】', '- 快速执行窄范围明确指令；严格按照给定模板格式输出，不自行发挥额外字段。'].join(
    '\n',
  ),
};

export interface CodeSlice {
  file: string;
  startLine: number;
  endLine: number;
  reason: string;
  content: string;
}

export interface CompilePromptInput {
  role: AgentRole;
  model: ModelSpec;
  taskTitle: string;
  mustDo: readonly string[];
  mustNotDo: readonly string[];
  writeScope: readonly string[];
  checkCommand: string;
  /** Scout 预先切好的精准代码片段（省去主模型盲目 grep）。 */
  preSlicedContext?: readonly CodeSlice[];
  /** 按触碰目录懒加载的模块 AGENTS.md 摘要。 */
  lazyModuleRules?: Readonly<Record<string, string>>;
  /** 该模型通过战绩闭环自动进化出的专属反模式规则。 */
  evolvedRules?: readonly EvolvedRule[];
  /** 同波次黑板上的最新共享契约事实。 */
  blackboardFacts?: readonly string[];
}

/**
 * 编译生成最终喂给 Agent 的高密度 System + Task Prompt。
 */
export function compileAgentPrompt(input: CompilePromptInput): string {
  const sections: string[] = [];

  // 1. 工种核心契约
  sections.push(`# 角色与铁律\n${ROLE_KERNELS[input.role]}`);

  // 2. 模型家族专属调优补丁
  const overlay = FAMILY_OVERLAYS[input.model.family];
  if (overlay) sections.push(overlay);

  // 3. 战绩自进化沉淀的该模型专属反模式护栏（只加载 active 和 candidate）
  const activeEvolved = (input.evolvedRules ?? []).filter(
    (r) => r.modelId === input.model.id && (r.status === 'active' || r.status === 'candidate'),
  );
  if (activeEvolved.length > 0) {
    sections.push(
      [
        `【${input.model.displayName} 历史翻车自进化护栏（必守）】`,
        ...activeEvolved.map((r) => `- [${r.category}] ${r.instruction}`),
      ].join('\n'),
    );
  }

  // 4. 任务边界与机器验收命令
  sections.push(
    [
      `# 当前任务：${input.taskTitle}`,
      `- 允许写范围（writeScope）：${input.writeScope.length > 0 ? input.writeScope.join(', ') : '只读（禁止写任何文件）'}`,
      `- 必做：${input.mustDo.join('；')}`,
      `- 严禁（不做什么）：${input.mustNotDo.join('；')}`,
      `- 机器核对命令（必跑且退出码为 0）：\`${input.checkCommand}\``,
    ].join('\n'),
  );

  // 5. 同波次黑板实时契约广播
  if (input.blackboardFacts && input.blackboardFacts.length > 0) {
    sections.push(
      ['# 同波次并行会话共享黑板（实时接口/事实同步）', ...input.blackboardFacts.map((f) => `- ${f}`)].join(
        '\n',
      ),
    );
  }

  // 6. 懒加载模块规矩
  if (input.lazyModuleRules && Object.keys(input.lazyModuleRules).length > 0) {
    const rules = Object.entries(input.lazyModuleRules).map(([dir, text]) => `### ${dir}\n${text.trim()}`);
    sections.push(['# 关联模块局部不变量（按路径懒加载）', ...rules].join('\n\n'));
  }

  // 7. Scout 预切片代码（直接省掉前 5 轮盲搜）
  if (input.preSlicedContext && input.preSlicedContext.length > 0) {
    const slices = input.preSlicedContext.map(
      (s) =>
        `### ${s.file} (L${s.startLine}-L${s.endLine}) — ${s.reason}\n\`\`\`ts\n${s.content.trim()}\n\`\`\``,
    );
    sections.push(['# Scout 预定位代码切片（已核实，可直接基于此行号修改）', ...slices].join('\n\n'));
  }

  return sections.join('\n\n');
}

/**
 * 提示词自进化闭环（Auto-Evolution）：
 * 当某款模型在同一失败类别（category）上栽满 threshold（默认 3）次时，自动提炼生成一条针对性的反模式护栏。
 */
export function evolvePromptRules(
  samples: readonly FailureSample[],
  existing: readonly EvolvedRule[],
  threshold = 3,
): EvolvedRule[] {
  const grouped = new Map<string, FailureSample[]>();
  for (const s of samples) {
    const key = `${s.modelId}::${s.category}`;
    const list = grouped.get(key) ?? [];
    list.push(s);
    grouped.set(key, list);
  }

  const nextRules = [...existing];
  const templates: Record<FailureSample['category'], string> = {
    'out-of-scope':
      '严禁顺手修改 writeScope 以外或需求未点名的已上线文案、导航与导出接口；每次提交前核对 git diff --name-only。',
    'unverified-claim': '严禁在未运行核对命令或测试退出码非 0 时宣称完成；交活必须附带真实终端退出码。',
    'test-regression': '修改公共函数后必须连带运行同包关联单测，不得删除或放宽已有 expect 断言凑绿。',
    'patch-instead-of-root':
      '禁止在外围叠 if/try-catch 兜底补丁；必须定位产生错误的数据源或必经步骤并删掉问题层。',
    'syntax-or-type': '每次 edit 后立即运行 tsc -b 与 biome check，确保相对导入带扩展名且类型完全对齐。',
  };

  for (const [key, list] of grouped.entries()) {
    if (list.length < threshold) continue;
    const [modelId, category] = key.split('::') as [string, FailureSample['category']];
    const already = nextRules.find(
      (r) => r.modelId === modelId && r.category === category && r.status !== 'revoked',
    );
    if (already) continue;

    nextRules.push({
      id: `evo-${modelId}-${category}-${list.length}`,
      modelId,
      category,
      instruction: `${templates[category]}（基于近期 ${list.length} 次真实退回自动提炼：${list[0]?.summary ?? ''}）`,
      derivedFromSampleIds: list.map((x) => x.id),
      status: 'candidate',
      beforePassRate: 0.65,
    });
  }

  return nextRules;
}
