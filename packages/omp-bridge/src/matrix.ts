// 四维路由矩阵（工种 Role × 渠道 Channel × 模型 Model × 账号池 Account）与防封双引擎分发器（方案 2）。
// 铁律：
// 1. reclaude 渠道一律走 'native-reclaude-stream'（官方 Claude Code 客户端本体常驻双向流），严禁任何 HTTP 反代（防 non_cc_client 上报封号）；
//    多个 reclaude 账号必须按宿主/系统用户物理隔离（一号一环境），Magpie 只用只读 rck_ 接口读 5h 美元窗做任务派发。
// 2. recodex、kiro、commoncode/opencode、devin、grok、antigravity、中转站走 'pi-api-stream'（omp 常驻流 + 本地回环网关，真密钥锁在 Rust 内核内存）。
/** 七大核心工种（Role）。 */
export const AGENT_ROLES = [
  'commander', // 帅位：拆解波次 DAG、拍板与全局调度
  'planner', // 架构设计：只读分析，输出子任务 DAG 与机器核对命令
  'worker-code', // 编码主力：在隔离 worktree 内动手写码并跑过本地检查
  'worker-ui', // 界面主力：负责前端组件、视觉排版与双屏截图自检（禁派纯 GPT）
  'scout', // 斥候：秒级扫描代码库，产出精准行号切片（Pre-sliced Context）
  'verifier', // 异族冷验收：不看 Worker 借口，只看 git diff 与验收条做独立盲审
  'ysk-watcher', // 旁路盯梢（you-should-know）：只看别人做事，抓越界修改与遗漏（默认用免费 swe-2）
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** 模型家族。 */
export const MODEL_FAMILIES = ['claude', 'gpt', 'deepseek', 'grok', 'gemini', 'swe', 'kimi', 'glm'] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

/**
 * 方案 2 双引擎运行模式：
 * - native-reclaude-stream：拉起官方 reclaude -> claude 本体（--input-format stream-json --output-format stream-json），绝不经网关反代 HTTP
 * - pi-api-stream：拉起小而美的 pi (omp) 常驻流，经 Rust Magpie 本地回环代理调兼容 API
 * - native-cli-stream：其他绑定设备指纹的专属 CLI 本体常驻流（如 grok / agy / devin 原生 CLI 模式）
 */
export const ENGINE_RUNNERS = ['native-reclaude-stream', 'pi-api-stream', 'native-cli-stream'] as const;
export type EngineRunner = (typeof ENGINE_RUNNERS)[number];

/** 渠道定义。 */
export interface ChannelSpec {
  id: string;
  name: string;
  runner: EngineRunner;
  protocol: 'anthropic' | 'openai-completions' | 'native-cli' | 'gemini';
  baseUrl?: string;
  /** 密钥在宿主/内核配置中的引用名（绝不存明文密钥）。 */
  secretEnvKey?: string;
  /** 是否严格绑定单设备单系统用户（reclaude 为 true，禁止同环境混登或 HTTP 反代）。 */
  strictNativeClient: boolean;
}

/** 模型能力画像。 */
export interface ModelSpec {
  id: string;
  displayName: string;
  family: ModelFamily;
  tier: 'flagship' | 'workhorse' | 'fast' | 'free';
  contextWindow: number;
  supportsVision: boolean;
  /** 硬禁令：例如 GPT 系不做 worker-ui。 */
  forbiddenRoles: readonly AgentRole[];
}

/** 账号池与 Magpie 实时额度快照。 */
export interface AccountPoolSnapshot {
  accountId: string;
  channelId: string;
  /** 物理隔离的宿主与系统用户（reclaude 一号一环境必填，如 "vps-france:fleet-agent-carpool"）。 */
  isolatedHostUser?: string;
  enabled: boolean;
  /** 剩余额度（美元或百分比归一化 0..1），null 表示按量或免费不限。 */
  remainingRatio: number | null;
  /** 5 小时窗口已用美元（如 reclaude 拼车窗）。 */
  windowUsedUsd?: number;
  windowLimitUsd?: number;
  /** 窗口清零时间戳（毫秒）：快清零且有余量的优先烧满。 */
  resetsAtMs?: number;
  /** 是否处于限流冷却中。 */
  cooldownUntilMs?: number;
}

/** 四维路由候选单元格（Role × Channel × Model × Account）。 */
export interface RouteCell {
  role: AgentRole;
  channel: ChannelSpec;
  model: ModelSpec;
  account: AccountPoolSnapshot;
  /** 该模型在该工种上的近期 Wilson 95% 置信下界胜率（0..1，默认 0.8）。 */
  wilsonLowerBound: number;
  /** 综合得分（由选路器计算）。 */
  score: number;
  /** 选路理由（可解释、写进事件流供驾驶舱展示）。 */
  reason: string;
}

/** 预置的 7 大套餐渠道目录（不含任何明文密钥）。 */
export const BUILTIN_CHANNELS: readonly ChannelSpec[] = [
  {
    id: 'reclaude',
    name: 'Reclaude (官方 Claude 本体直通)',
    runner: 'native-reclaude-stream',
    protocol: 'native-cli',
    strictNativeClient: true,
  },
  {
    id: 'recodex',
    name: 'Recodex API',
    runner: 'pi-api-stream',
    protocol: 'openai-completions',
    baseUrl: 'https://api.recodex.dev/v1',
    secretEnvKey: 'RECODEX_API_KEY',
    strictNativeClient: false,
  },
  {
    id: 'kiro',
    name: 'Kiro 编码主力池',
    runner: 'pi-api-stream',
    protocol: 'anthropic',
    secretEnvKey: 'KIRO_API_KEY',
    strictNativeClient: false,
  },
  {
    id: 'commoncode',
    name: 'CommonCode / OpenCode 主力池',
    runner: 'pi-api-stream',
    protocol: 'openai-completions',
    secretEnvKey: 'COMMONCODE_API_KEY',
    strictNativeClient: false,
  },
  {
    id: 'devin',
    name: 'Devin (含免费 SWE-2 盯梢池)',
    runner: 'pi-api-stream',
    protocol: 'openai-completions',
    secretEnvKey: 'DEVIN_API_KEY',
    strictNativeClient: false,
  },
  {
    id: 'grok-heavy',
    name: 'Grok Heavy',
    runner: 'native-cli-stream',
    protocol: 'native-cli',
    strictNativeClient: false,
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    runner: 'pi-api-stream',
    protocol: 'gemini',
    secretEnvKey: 'ANTIGRAVITY_API_KEY',
    strictNativeClient: false,
  },
  {
    id: 'magpie-relay',
    name: 'Magpie 统一中转站聚合口',
    runner: 'pi-api-stream',
    protocol: 'openai-completions',
    secretEnvKey: 'MAGPIE_RELAY_KEY',
    strictNativeClient: false,
  },
];

/** 预置的主力模型库。 */
export const BUILTIN_MODELS: readonly ModelSpec[] = [
  {
    id: 'claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    family: 'claude',
    tier: 'flagship',
    contextWindow: 200_000,
    supportsVision: true,
    forbiddenRoles: [],
  },
  {
    id: 'claude-sonnet-5-5',
    displayName: 'Claude Sonnet 5.5',
    family: 'claude',
    tier: 'workhorse',
    contextWindow: 200_000,
    supportsVision: true,
    forbiddenRoles: [],
  },
  {
    id: 'kiro-claude-sonnet',
    displayName: 'Kiro Claude Sonnet (编码主力)',
    family: 'claude',
    tier: 'workhorse',
    contextWindow: 200_000,
    supportsVision: true,
    forbiddenRoles: [],
  },
  {
    id: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro (CommonCode/OpenCode 主力)',
    family: 'deepseek',
    tier: 'workhorse',
    contextWindow: 128_000,
    supportsVision: false,
    forbiddenRoles: [],
  },
  {
    id: 'gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex (Recodex)',
    family: 'gpt',
    tier: 'flagship',
    contextWindow: 200_000,
    supportsVision: true,
    forbiddenRoles: ['worker-ui'], // 铁律：GPT 系不做界面活
  },
  {
    id: 'grok-4.7-heavy',
    displayName: 'Grok 4.7 Heavy',
    family: 'grok',
    tier: 'flagship',
    contextWindow: 256_000,
    supportsVision: false,
    forbiddenRoles: ['worker-ui'],
  },
  {
    id: 'gemini-3.1-pro',
    displayName: 'Antigravity Gemini 3.1 Pro',
    family: 'gemini',
    tier: 'flagship',
    contextWindow: 1_000_000,
    supportsVision: true,
    forbiddenRoles: [],
  },
  {
    id: 'claude-haiku-5-5',
    displayName: 'Claude Haiku 5.5',
    family: 'claude',
    tier: 'fast',
    contextWindow: 200_000,
    supportsVision: false,
    forbiddenRoles: ['commander', 'planner'],
  },
  {
    id: 'devin-swe-2',
    displayName: 'Devin SWE-2 (Free 旁路盯梢 & 斥候)',
    family: 'swe',
    tier: 'free',
    contextWindow: 128_000,
    supportsVision: false,
    forbiddenRoles: ['commander', 'worker-ui'],
  },
];

/**
 * 防封安全校验：任何时候试图把 strictNativeClient (reclaude) 配成 HTTP 反代、或者缺少宿主用户隔离，当场抛错拦截。
 */
export function assertAntiBanSafety(channel: ChannelSpec, account: AccountPoolSnapshot): void {
  if (channel.strictNativeClient || channel.id === 'reclaude') {
    if (channel.runner !== 'native-reclaude-stream') {
      throw new Error(
        `防封拦截：渠道 ${channel.id} 必须走 native-reclaude-stream 官方本体常驻流，严禁使用 ${channel.runner} 反代以免触发 non_cc_client 上报`,
      );
    }
    if (!account.isolatedHostUser?.includes(':')) {
      throw new Error(
        `防封拦截：reclaude 账号 ${account.accountId} 必须绑定独立的「宿主:系统用户」（isolatedHostUser），严禁同环境混登多账号`,
      );
    }
  }
}

export interface SelectRouteInput {
  role: AgentRole;
  candidates: ReadonlyArray<{
    channel: ChannelSpec;
    model: ModelSpec;
    account: AccountPoolSnapshot;
    wilsonLowerBound?: number;
  }>;
  /** 异族冷验收时：禁止与写码模型同族。 */
  excludeFamily?: ModelFamily;
  /** 是否窄改动 + 有明确机器核对命令 + 规矩写全（满足时允许降档到 fast/free）。 */
  narrowAndCheckable?: boolean;
  nowMs?: number;
}

/**
 * 四维选路算法：
 * 1. 过滤硬禁令（forbiddenRoles、冷却中、停用、异族约束、reclaude 防封校验、非窄改动禁派轻档做编码）；
 * 2. 旁路盯梢（ysk-watcher）与斥候（scout）优先选 free 档（如 devin-swe-2）；
 * 3. 结合 Magpie 5h 窗口紧迫度（快清零且有余量的拼车窗加权优先烧满）× 模型战绩 Wilson 下界排序。
 */
export function selectBestRoute(input: SelectRouteInput): RouteCell {
  const now = input.nowMs ?? Date.now();
  const valid: RouteCell[] = [];

  for (const c of input.candidates) {
    const { channel, model, account } = c;
    if (!account.enabled) continue;
    if (account.cooldownUntilMs && account.cooldownUntilMs > now) continue;
    if (model.forbiddenRoles.includes(input.role)) continue;
    if (input.excludeFamily && model.family === input.excludeFamily) continue;

    // 编码主力未满足窄改动三条时，不派 fast/free 档
    if (
      (input.role === 'worker-code' || input.role === 'worker-ui') &&
      !input.narrowAndCheckable &&
      (model.tier === 'fast' || model.tier === 'free')
    ) {
      continue;
    }

    // 校验 reclaude 防封约束
    assertAntiBanSafety(channel, account);

    // 计算剩余额度比例
    let rem = account.remainingRatio ?? 1.0;
    if (account.windowLimitUsd && account.windowUsedUsd !== undefined) {
      rem = Math.max(0, (account.windowLimitUsd - account.windowUsedUsd) / account.windowLimitUsd);
    }
    if (rem <= 0.02) continue; // 额度已见底（留 2% 安全垫）

    // 窗口清零紧迫度加分：如果 2 小时内就要清零且还有不少额度，优先烧它（防浪费，决定 0120）
    let urgencyBoost = 1.0;
    if (account.resetsAtMs && account.resetsAtMs > now) {
      const hoursLeft = (account.resetsAtMs - now) / 3_600_000;
      if (hoursLeft <= 2.5 && rem >= 0.15) {
        urgencyBoost = 1.35 + (2.5 - hoursLeft) * 0.15;
      }
    }

    // 工种档位匹配度
    let tierScore = 1.0;
    if (input.role === 'ysk-watcher' || input.role === 'scout') {
      tierScore = model.tier === 'free' ? 2.0 : model.tier === 'fast' ? 1.5 : 0.6;
    } else if (input.role === 'commander' || input.role === 'planner') {
      tierScore = model.tier === 'flagship' ? 1.6 : model.tier === 'workhorse' ? 1.1 : 0.4;
    } else if (input.role === 'worker-code' || input.role === 'worker-ui') {
      tierScore =
        input.narrowAndCheckable && model.tier === 'fast'
          ? 1.45
          : model.tier === 'workhorse'
            ? 1.4
            : model.tier === 'flagship'
              ? 1.25
              : 0.7;
    }

    const wilson = c.wilsonLowerBound ?? 0.85;
    const score = Number((tierScore * urgencyBoost * (0.5 + 0.5 * rem) * wilson).toFixed(4));
    const runnerTag = channel.runner === 'native-reclaude-stream' ? '官方本体直通' : 'pi常驻流';
    valid.push({
      role: input.role,
      channel,
      model,
      account,
      wilsonLowerBound: wilson,
      score,
      reason: `[${runnerTag}] ${channel.name} · ${model.displayName} (账号 ${account.accountId}, 胜率下界 ${Math.round(wilson * 100)}%, 评分 ${score})`,
    });
  }

  if (valid.length === 0) {
    throw new Error(`没有找到符合工种 [${input.role}] 的可用路由（已过滤禁令、额度耗尽与同族约束）`);
  }

  valid.sort((a, b) => b.score - a.score);
  const best = valid[0];
  if (!best) throw new Error('选路结果为空');
  return best;
}
