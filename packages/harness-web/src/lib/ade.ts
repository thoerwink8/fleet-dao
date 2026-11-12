// ADE 全局状态与操作客户端（Workspaces 工作区、Models 模型池、Routes 四维路由、Session 新建与操控、Waves 波次编排、Decisions 拍板）。
// 使用 API_BASE 自适应云端驾驶舱 (/next/api) 与本机桌面软件 (/api)。
import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from './api';

export interface AdeWorkspace {
  id: string;
  name: string;
  path: string;
  gitUrl: string;
  defaultBranch: string;
  checkCmd: string;
  hostId: string;
  repoKind: 'self' | 'external';
}

export interface AdeModelOption {
  id: string;
  label: string;
  runner: 'native-reclaude-stream' | 'pi-api-stream' | 'native-cli';
  family: 'claude' | 'deepseek' | 'gpt' | 'gemini' | 'grok' | 'swe2';
  quotaNote: string;
}

export interface AdeRouteConfig {
  role: string;
  roleLabel: string;
  primary: string;
  secondary: string;
  effort: 'low' | 'medium' | 'high' | 'max';
  maxConcurrency: number;
  wilson: string;
  overlayNote: string;
}

export interface AdeSessionMeta {
  sessionId: string;
  title: string;
  workspaceId: string;
  role: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'max';
  hostId: string;
  writeScope: string;
  yskEnabled: boolean;
  branch: string;
  statusOverride?: 'running' | 'paused' | 'stopped' | 'done';
  updatedAt: string;
}

export interface AdeWaveSubtask {
  id: string;
  wave: 1 | 2 | 3;
  title: string;
  role: string;
  runnerBadge: string;
  modelName: string;
  accountTag: string;
  writeScope: string;
  status: 'verified' | 'running' | 'ready' | 'rework';
  sessionId: string;
  funnelStep: string;
  savedTokens: string;
}

export interface AdeBlackboardFact {
  id: string;
  at: string;
  from: string;
  scope: string;
  text: string;
}

export interface AdeStateSnapshot {
  workspaces: AdeWorkspace[];
  activeWorkspaceId: string;
  models: AdeModelOption[];
  routes: AdeRouteConfig[];
  overlays: Record<string, { title: string; evolvedCount: number; rules: string[] }>;
  sessionMeta: Record<string, AdeSessionMeta>;
  waveNodes: AdeWaveSubtask[];
  blackboardFacts: AdeBlackboardFact[];
  decisionsResolved: Record<string, 'approved' | 'rejected'>;
}

export const DEFAULT_ADE_STATE: AdeStateSnapshot = {
  activeWorkspaceId: 'ws-fleet-dao',
  workspaces: [
    {
      id: 'ws-fleet-dao',
      name: 'fleet-dao (核心研发流水线)',
      path: 'D:/frank/fleet-dao',
      gitUrl: 'https://github.com/thoerwink8/fleet-dao',
      defaultBranch: 'main',
      checkCmd: 'pnpm check',
      hostId: 'desktop-win',
      repoKind: 'self',
    },
    {
      id: 'ws-corp-intranet',
      name: 'corp-payment-core (内网核心仓)',
      path: '/home/dev/corp-payment-core',
      gitUrl: 'ssh://git@gitlab.corp.internal/core/payment.git',
      defaultBranch: 'develop',
      checkCmd: 'cargo test --workspace',
      hostId: 'corp-intranet-01',
      repoKind: 'external',
    },
    {
      id: 'ws-cloud-runner',
      name: 'fleet-cloud-infra (VPS 部署栈)',
      path: '/srv/fleet-dao',
      gitUrl: 'https://github.com/thoerwink8/fleet-dao',
      defaultBranch: 'main',
      checkCmd: 'npx vitest run',
      hostId: 'vps-france',
      repoKind: 'self',
    },
  ],
  models: [
    {
      id: 'reclaude::claude-opus-5-5',
      label: '[官方直通] reclaude · Claude Opus 5.5',
      runner: 'native-reclaude-stream',
      family: 'claude',
      quotaNote: '$61.60 / $80.00 (独享池)',
    },
    {
      id: 'reclaude::claude-sonnet-5-5',
      label: '[官方直通] reclaude · Claude Sonnet 5.5',
      runner: 'native-reclaude-stream',
      family: 'claude',
      quotaNote: '$27.90 / $80.00 (拼车 5h 窗)',
    },
    {
      id: 'kiro::kiro-claude-sonnet',
      label: '[pi常驻流] Kiro · Claude Sonnet (主力)',
      runner: 'pi-api-stream',
      family: 'claude',
      quotaNote: '充足 (91%)',
    },
    {
      id: 'commoncode::deepseek-v4-pro',
      label: '[pi常驻流] CommonCode · DeepSeek V4 Pro',
      runner: 'pi-api-stream',
      family: 'deepseek',
      quotaNote: '充足 (94%)',
    },
    {
      id: 'recodex::gpt-5.3-codex',
      label: '[pi常驻流] Recodex · GPT-5.3 Codex',
      runner: 'pi-api-stream',
      family: 'gpt',
      quotaNote: '充足 (95%)',
    },
    {
      id: 'grok-heavy::grok-4.7-heavy',
      label: '[原生CLI] Grok 4.7 Heavy',
      runner: 'native-cli',
      family: 'grok',
      quotaNote: '充足 (88%)',
    },
    {
      id: 'antigravity::gemini-3.1-pro',
      label: '[pi常驻流] Antigravity · Gemini 3.1 Pro',
      runner: 'pi-api-stream',
      family: 'gemini',
      quotaNote: '充足 (92%)',
    },
    {
      id: 'devin::devin-swe-2',
      label: '[免费盯梢] Devin · SWE-2 (Free)',
      runner: 'pi-api-stream',
      family: 'swe2',
      quotaNote: '免费无限',
    },
  ],
  routes: [
    {
      role: 'commander',
      roleLabel: 'commander / planner (帅位与架构拆解)',
      primary: '[官方直通] reclaude · Claude Opus 5.5',
      secondary: '[pi常驻流] Recodex · GPT-5.3 Codex / Grok 4.7 Heavy',
      effort: 'high',
      maxConcurrency: 2,
      wilson: '94.2%',
      overlayNote: '只输出无写冲突的波次 DAG、writeScope 与确定性核验命令，不亲自下场写码',
    },
    {
      role: 'worker-code',
      roleLabel: 'worker-code (编码主力 · 复杂/跨文件)',
      primary: '[pi常驻流] Kiro · Claude Sonnet / CommonCode · DeepSeek V4 Pro',
      secondary: '[官方直通] reclaude · Claude Sonnet 5.5 (拼车窗临近清零时自动提权)',
      effort: 'high',
      maxConcurrency: 6,
      wilson: '92.8%',
      overlayNote: '注入 DeepSeek 三步状态机与 Kiro 反过度防御补丁；读 Scout 预切片免盲搜',
    },
    {
      role: 'worker-ui',
      roleLabel: 'worker-ui (前端与视觉组件 · 禁派 GPT)',
      primary: '[pi常驻流] Kiro · Claude Sonnet / Antigravity · Gemini 3.1 Pro',
      secondary: '[官方直通] reclaude · Claude Opus 5.5',
      effort: 'medium',
      maxConcurrency: 3,
      wilson: '91.4%',
      overlayNote: '强制 shadcn/ui + Tailwind v4 令牌、.num 等宽数字、1440px/390px 双屏截图零横滚核对',
    },
    {
      role: 'ysk-watcher',
      roleLabel: 'ysk-watcher (you-should-know 实时旁路盯梢)',
      primary: '[pi常驻流 · 免费] Devin · SWE-2 (devin/swe-2)',
      secondary: '[pi常驻流] Claude Haiku 5.5',
      effort: 'low',
      maxConcurrency: 12,
      wilson: '96.5%',
      overlayNote: '不写代码只盯 git diff：抓顺手改已上线文案/导航、删 expect 断言、空 catch 吞错',
    },
    {
      role: 'scout',
      roleLabel: 'scout (20 秒极速代码切片斥候)',
      primary: '[pi常驻流 · 免费] Devin · SWE-2 / Claude Haiku 5.5',
      secondary: '[pi常驻流] CommonCode · DeepSeek Fast',
      effort: 'low',
      maxConcurrency: 8,
      wilson: '95.1%',
      overlayNote: '只输出 文件路径 + [Lstart-Lend] 行号区间 + 核心类型签名，替主力模型省 70% 读文件 Token',
    },
    {
      role: 'verifier',
      roleLabel: 'verifier (异族独立冷验收)',
      primary: 'Claude 写的派 GPT-5.3 Codex / Grok 4.7；DeepSeek 写的派 Claude / GPT',
      secondary: '[pi常驻流] Antigravity · Gemini 3.1 Pro (视觉双屏复核)',
      effort: 'high',
      maxConcurrency: 4,
      wilson: '93.7%',
      overlayNote: '硬锁 excludeFamily 异族盲审；只查验收条达成、回归破坏与安全隐患，不挑代码风格',
    },
  ],
  overlays: {
    deepseek: {
      title: 'CommonCode / OpenCode · DeepSeek V4 Pro 编码主力装甲',
      evolvedCount: 3,
      rules: [
        '严格执行三步走状态机：① 核对 Scout 预喂的代码切片行号 → ② 最小唯一 oldText 调用 edit → ③ 立即运行核对命令看真实退出码。',
        '[自进化已转正] 严禁顺手修改 writeScope 以外或需求未点名的已上线文案、导航与导出接口。',
        '[自进化已转正] 严禁省略代码片段用「// ... 其余不变」注释代替；跨文件改类型立即调 publish_fact 广播。',
      ],
    },
    kiro: {
      title: 'Kiro · 次一级 Claude 编码主力装甲',
      evolvedCount: 2,
      rules: [
        '使用 codemode 一次批处理多个独立文件读取，将 5 个回合压成 1 个回合。',
        '[自进化已转正] 严禁过度防御（不加无意义的空数组/空字符串 fallback 掩盖错误，读不到就明确返回失败）。',
        '修改公共函数后必须连带跑同包单测，确保 passedTestsCount >= baseline。',
      ],
    },
    recodex: {
      title: 'Recodex · GPT-5.3 Codex 逻辑与异族盲审装甲',
      evolvedCount: 2,
      rules: [
        '硬禁令：禁止承接 worker-ui 界面样式活。',
        '写修复前先构造最小复现断言，再改根因层让测试转绿；零礼貌套话直接给结论。',
      ],
    },
    swe2: {
      title: 'Devin · SWE-2 (Free) YSK 旁路盯梢与斥候装甲',
      evolvedCount: 1,
      rules: [
        '旁路盯梢只回答「主 agent 有没有顺手改坏范围外已上线逻辑或漏做必做项」，正常只回 OK，异常一句话 (<55字) 直指要害。',
      ],
    },
  },
  sessionMeta: {
    'cmd-demo-login-fix': {
      sessionId: 'cmd-demo-login-fix',
      title: '修复登录 Cookie 过期重连与会话状态同步',
      workspaceId: 'ws-fleet-dao',
      role: 'worker-code',
      model: 'reclaude::claude-opus-5-5',
      effort: 'high',
      hostId: 'vps-france',
      writeScope: 'packages/harness-api/**',
      yskEnabled: true,
      branch: 'wave/3851-login-fix',
      updatedAt: '2026-11-12T03:00:00.000Z',
    },
    'cmd-demo-flaky-ci': {
      sessionId: 'cmd-demo-flaky-ci',
      title: '排查并收敛 CI 偶发超时用例',
      workspaceId: 'ws-fleet-dao',
      role: 'worker-code',
      model: 'commoncode::deepseek-v4-pro',
      effort: 'high',
      hostId: 'vps-france',
      writeScope: 'packages/harness-store/**',
      yskEnabled: true,
      branch: 'wave/3851-flaky-ci',
      updatedAt: '2026-11-12T03:00:00.000Z',
    },
  },
  waveNodes: [
    {
      id: 'W1-S1',
      wave: 1,
      title: 'Scout 预切片：定位路由矩阵与防封边界行号',
      role: 'scout',
      runnerBadge: 'pi常驻流',
      modelName: 'Devin SWE-2 (Free)',
      accountTag: 'devin-free',
      writeScope: '只读 (Pre-sliced Context)',
      status: 'verified',
      sessionId: 'worker-d12-a1',
      funnelStep: '耗时 9s · 产出 4 处精准行号切片',
      savedTokens: '省 18.4k Tokens',
    },
    {
      id: 'W1-S2',
      wave: 1,
      title: 'Rust 核心原语：fleet-core 四维路由与波次 DAG 状态机',
      role: 'worker-code',
      runnerBadge: '官方本体直通',
      modelName: 'Claude Opus 5.5',
      accountTag: 'france:fleet-agent-carpool',
      writeScope: 'crates/fleet-core/**',
      status: 'verified',
      sessionId: 'cmd-demo-login-fix',
      funnelStep: 'Gate 1~4 全绿 · cargo test 4/4 通过',
      savedTokens: '省 11.2k Tokens',
    },
    {
      id: 'W2-S1',
      wave: 2,
      title: 'omp-bridge 扩展：模型专属 Prompt 编译器与 SWE-2 YSK 盯梢器',
      role: 'worker-code',
      runnerBadge: 'pi常驻流',
      modelName: 'Kiro · Claude Sonnet',
      accountTag: 'kiro-pool-01',
      writeScope: 'packages/omp-bridge/**',
      status: 'verified',
      sessionId: 'cmd-demo-migration',
      funnelStep: '异族盲审 (GPT-5.3 Codex) 通过',
      savedTokens: '省 14.9k Tokens',
    },
    {
      id: 'W2-S2',
      wave: 2,
      title: '公司内网穿透：fleet-hostd SSH 反向模型隧道与 Worktree 隔离',
      role: 'worker-code',
      runnerBadge: 'pi常驻流',
      modelName: 'CommonCode · DeepSeek V4 Pro',
      accountTag: 'cc-deepseek-02',
      writeScope: 'crates/fleet-hostd/**',
      status: 'running',
      sessionId: 'cmd-demo-test-run',
      funnelStep: 'Gate 1 (YSK 0越界) · 正在跑增量单测',
      savedTokens: '省 9.6k Tokens',
    },
    {
      id: 'W3-S1',
      wave: 3,
      title: '驾驶舱高密度工作台：波次图、四道验收卡、运维与四维矩阵',
      role: 'worker-ui',
      runnerBadge: 'pi常驻流',
      modelName: 'Antigravity · Gemini 3.1 Pro',
      accountTag: 'agy-pro-01',
      writeScope: 'packages/harness-web/**',
      status: 'ready',
      sessionId: 'cmd-demo-docs-sweep',
      funnelStep: '等待 W2-S2 合流后触发双屏 1440/390 视觉自检',
      savedTokens: '预计省 16k Tokens',
    },
  ],
  blackboardFacts: [
    {
      id: 'bf-1',
      at: '03:02',
      from: 'W1-S2 (Claude Opus 5.5)',
      scope: 'crates/fleet-core/src/lib.rs',
      text: '已固化 verify_anti_ban()：reclaude 渠道若非 NativeReclaudeStream 或缺宿主隔离直接返回 Err。',
    },
    {
      id: 'bf-2',
      at: '03:04',
      from: 'W2-S1 (Kiro · Claude Sonnet)',
      scope: 'packages/omp-bridge/src/ysk-watcher.ts',
      text: 'YSK 旁路警报徽章统一为「✦ Heads up · 主 agent」，触发越界时自动向会话 Steer 邮箱投递回滚指令。',
    },
    {
      id: 'bf-3',
      at: '03:05',
      from: 'W2-S2 (CommonCode · DeepSeek V4 Pro)',
      scope: 'crates/fleet-hostd/src/lib.rs',
      text: '公司内网 SSH 反向隧道端口定为 127.0.0.1:19820，内网机器零 API Key 落盘。',
    },
  ],
  decisionsResolved: {},
};

let cachedState: AdeStateSnapshot = structuredClone(DEFAULT_ADE_STATE);
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export async function refreshAdeState(): Promise<AdeStateSnapshot> {
  try {
    const r = await fetch(`${API_BASE}/ade/state`, { credentials: 'same-origin' });
    if (r.ok) {
      const data = (await r.json()) as Partial<AdeStateSnapshot>;
      cachedState = {
        ...cachedState,
        ...data,
      };
      notify();
    }
  } catch {
    // 离线单测环境下使用默认快照
  }
  return cachedState;
}

export function useAdeState() {
  const [state, setState] = useState<AdeStateSnapshot>(() => cachedState);

  useEffect(() => {
    const l = () => setState({ ...cachedState });
    listeners.add(l);
    void refreshAdeState();
    return () => {
      listeners.delete(l);
    };
  }, []);

  const addWorkspace = useCallback(
    async (input: {
      name: string;
      path: string;
      gitUrl?: string;
      defaultBranch?: string;
      checkCmd?: string;
      hostId?: string;
      repoKind?: 'self' | 'external';
    }) => {
      const newWs: AdeWorkspace = {
        id: `ws-${Date.now().toString().slice(-5)}`,
        name: input.name,
        path: input.path,
        gitUrl: input.gitUrl ?? input.path,
        defaultBranch: input.defaultBranch ?? 'main',
        checkCmd: input.checkCmd ?? 'pnpm check',
        hostId: input.hostId ?? 'desktop-win',
        repoKind: input.repoKind ?? 'self',
      };
      cachedState = {
        ...cachedState,
        workspaces: [...cachedState.workspaces, newWs],
        activeWorkspaceId: newWs.id,
      };
      notify();
      try {
        const r = await fetch(`${API_BASE}/ade/workspaces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'add', ...newWs }),
        });
        if (r.ok) await refreshAdeState();
      } catch {
        // 离线单测保留本地更新
      }
      return newWs;
    },
    [],
  );

  const selectWorkspace = useCallback(async (workspaceId: string) => {
    cachedState = { ...cachedState, activeWorkspaceId: workspaceId };
    notify();
    try {
      await fetch(`${API_BASE}/ade/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'select', workspaceId }),
      });
    } catch {
      // ignore
    }
  }, []);

  const createSession = useCallback(
    async (input: {
      prompt: string;
      workspaceId: string;
      role: string;
      model: string;
      effort: 'low' | 'medium' | 'high' | 'max';
      hostId: string;
      writeScope: string;
      yskEnabled: boolean;
      branch?: string;
    }): Promise<string> => {
      const fallbackId = `worker-ade-${Date.now().toString().slice(-6)}`;
      try {
        const r = await fetch(`${API_BASE}/ade/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (r.ok) {
          const data = (await r.json()) as { sessionId?: string; meta?: AdeSessionMeta };
          if (data.sessionId && data.meta) {
            cachedState = {
              ...cachedState,
              sessionMeta: { ...cachedState.sessionMeta, [data.sessionId]: data.meta },
            };
            notify();
            return data.sessionId;
          }
        }
      } catch {
        // 离线回退
      }
      cachedState = {
        ...cachedState,
        sessionMeta: {
          ...cachedState.sessionMeta,
          [fallbackId]: {
            sessionId: fallbackId,
            title: input.prompt.slice(0, 72),
            workspaceId: input.workspaceId,
            role: input.role,
            model: input.model,
            effort: input.effort,
            hostId: input.hostId,
            writeScope: input.writeScope,
            yskEnabled: input.yskEnabled,
            branch: input.branch ?? `feat/${fallbackId}`,
            statusOverride: 'running',
            updatedAt: new Date().toISOString(),
          },
        },
      };
      notify();
      return fallbackId;
    },
    [],
  );

  const controlSession = useCallback(
    async (
      sessionId: string,
      payload: {
        action: 'switch-config' | 'pause' | 'stop' | 'resume' | 'retry' | 'complete' | 'fork';
        model?: string;
        effort?: 'low' | 'medium' | 'high' | 'max';
        workspaceId?: string;
        hostId?: string;
        writeScope?: string;
        role?: string;
        prompt?: string;
      },
    ): Promise<{ forkedSessionId?: string }> => {
      const existing = cachedState.sessionMeta[sessionId] ?? {
        sessionId,
        title: sessionId,
        workspaceId: cachedState.activeWorkspaceId,
        role: 'worker-code',
        model: 'reclaude::claude-opus-5-5',
        effort: 'high' as const,
        hostId: 'desktop-win',
        writeScope: 'packages/**',
        yskEnabled: true,
        branch: `work/${sessionId}`,
        updatedAt: new Date().toISOString(),
      };
      const updated: AdeSessionMeta = {
        ...existing,
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.effort ? { effort: payload.effort } : {}),
        ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
        ...(payload.hostId ? { hostId: payload.hostId } : {}),
        ...(payload.writeScope ? { writeScope: payload.writeScope } : {}),
        ...(payload.role ? { role: payload.role } : {}),
        ...(payload.action === 'pause'
          ? { statusOverride: 'paused' }
          : payload.action === 'stop'
            ? { statusOverride: 'stopped' }
            : payload.action === 'resume' || payload.action === 'retry'
              ? { statusOverride: 'running' }
              : payload.action === 'complete'
                ? { statusOverride: 'done' }
                : {}),
        updatedAt: new Date().toISOString(),
      };
      cachedState = {
        ...cachedState,
        sessionMeta: { ...cachedState.sessionMeta, [sessionId]: updated },
      };
      notify();

      try {
        const r = await fetch(`${API_BASE}/ade/sessions/${encodeURIComponent(sessionId)}/control`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (r.ok) {
          const data = (await r.json()) as { forkedSessionId?: string; meta?: AdeSessionMeta };
          await refreshAdeState();
          return { ...(data.forkedSessionId ? { forkedSessionId: data.forkedSessionId } : {}) };
        }
      } catch {
        // ignore
      }
      return {};
    },
    [],
  );

  const updateRoute = useCallback(
    async (input: {
      role: string;
      primary?: string;
      secondary?: string;
      effort?: 'low' | 'medium' | 'high' | 'max';
      maxConcurrency?: number;
      overlayNote?: string;
    }) => {
      cachedState = {
        ...cachedState,
        routes: cachedState.routes.map((r) =>
          r.role === input.role || r.roleLabel === input.role ? { ...r, ...input } : r,
        ),
      };
      notify();
      try {
        await fetch(`${API_BASE}/ade/routing`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'update-route', ...input }),
        });
      } catch {
        // ignore
      }
    },
    [],
  );

  const addModel = useCallback(
    async (input: {
      id: string;
      label: string;
      runner: 'native-reclaude-stream' | 'pi-api-stream' | 'native-cli';
      family: AdeModelOption['family'];
      quotaNote?: string;
    }) => {
      const m: AdeModelOption = {
        id: input.id,
        label: input.label,
        runner: input.runner,
        family: input.family,
        quotaNote: input.quotaNote ?? '充足 (自定义接入)',
      };
      if (!cachedState.models.some((x) => x.id === m.id)) {
        cachedState = { ...cachedState, models: [...cachedState.models, m] };
        notify();
      }
      try {
        await fetch(`${API_BASE}/ade/routing`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'add-model', ...m }),
        });
      } catch {
        // ignore
      }
    },
    [],
  );

  const addOverlayRule = useCallback(async (family: string, rule: string) => {
    const existing = cachedState.overlays[family];
    if (existing) {
      cachedState = {
        ...cachedState,
        overlays: {
          ...cachedState.overlays,
          [family]: {
            ...existing,
            evolvedCount: existing.evolvedCount + 1,
            rules: [...existing.rules, `[手动新增] ${rule}`],
          },
        },
      };
      notify();
    }
    try {
      await fetch(`${API_BASE}/ade/routing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'add-overlay-rule', family, rule }),
      });
    } catch {
      // ignore
    }
  }, []);

  const createWaveSubtask = useCallback(
    async (input: {
      title: string;
      wave: 1 | 2 | 3;
      role: string;
      modelName: string;
      writeScope: string;
      accountTag?: string;
    }) => {
      const nodeId = `W${input.wave}-S${cachedState.waveNodes.filter((n) => n.wave === input.wave).length + 1}`;
      const sessionId = `worker-w${input.wave}-${Date.now().toString().slice(-4)}`;
      const localNode: AdeWaveSubtask = {
        id: nodeId,
        wave: input.wave,
        title: input.title,
        role: input.role,
        runnerBadge: input.modelName.includes('reclaude') ? '官方本体直通' : 'pi常驻流',
        modelName: input.modelName,
        accountTag: input.accountTag ?? 'auto-pool',
        writeScope: input.writeScope,
        status: 'running',
        sessionId,
        funnelStep: 'Gate 1 (YSK 盯梢已挂载) · 已派发执行',
        savedTokens: '预计省 12.5k Tokens',
      };
      const localFact: AdeBlackboardFact = {
        id: `bf-${Date.now()}`,
        at: '刚刚',
        from: `${nodeId} (${input.modelName})`,
        scope: input.writeScope,
        text: `[新波次节点启动] 已锁定写范围 ${input.writeScope}，开始执行「${input.title}」，同波次会话实时共享契约。`,
      };
      cachedState = {
        ...cachedState,
        waveNodes: [...cachedState.waveNodes, localNode],
        blackboardFacts: [localFact, ...cachedState.blackboardFacts],
      };
      notify();
      try {
        const r = await fetch(`${API_BASE}/ade/waves`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'create-wave', ...input }),
        });
        if (r.ok) await refreshAdeState();
      } catch {
        // ignore
      }
    },
    [],
  );

  const advanceWaveNode = useCallback(async (nodeId: string, modelName?: string) => {
    cachedState = {
      ...cachedState,
      waveNodes: cachedState.waveNodes.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              ...(modelName ? { modelName } : {}),
              status: n.status === 'ready' ? 'running' : 'verified',
              funnelStep:
                n.status === 'ready'
                  ? `已换模型 ${modelName ?? n.modelName} 重新拉起执行`
                  : 'Gate 1~4 全绿 · 已合入波次分支',
            }
          : n,
      ),
    };
    notify();
    try {
      await fetch(`${API_BASE}/ade/waves`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'advance-node', nodeId, modelName }),
      });
    } catch {
      // ignore
    }
  }, []);

  const resolveDecision = useCallback(async (id: string, verdict: 'approved' | 'rejected') => {
    cachedState = {
      ...cachedState,
      decisionsResolved: { ...cachedState.decisionsResolved, [id]: verdict },
    };
    notify();
    try {
      await fetch(`${API_BASE}/ade/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, verdict }),
      });
    } catch {
      // ignore
    }
  }, []);

  return {
    state,
    addWorkspace,
    selectWorkspace,
    createSession,
    controlSession,
    updateRoute,
    addModel,
    addOverlayRule,
    createWaveSubtask,
    advanceWaveNode,
    resolveDecision,
  };
}
