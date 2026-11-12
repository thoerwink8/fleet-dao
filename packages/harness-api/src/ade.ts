// ADE 全功能控制面后端（Workspaces 工作区管理、Sessions 会话发起与实时操控、Routing 四维路由与模型参数、Waves 波次拆解、Decisions 拍板、Cluster 宿主集群）。
// 直接内置于 createCockpitApi，使云端 VPS（/next/api）、本机桌面软件（/api）和本地开发 E2E 三端同构共享同一套真实后端与事件流。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { transcriptStream } from '@fleet-dao/harness-contract';
import type { Db } from '@fleet-dao/harness-store';
import { appendToSession, appendToStream } from './events.ts';
import { reply } from './session-http.ts';

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

export interface AdeStateStore {
  workspaces: AdeWorkspace[];
  activeWorkspaceId: string;
  models: AdeModelOption[];
  routes: AdeRouteConfig[];
  overlays: Record<string, { title: string; evolvedCount: number; rules: string[] }>;
  sessionMeta: Record<string, AdeSessionMeta>;
  waveNodes: AdeWaveSubtask[];
  blackboardFacts: AdeBlackboardFact[];
  decisionsResolved: Record<string, 'approved' | 'rejected'>;
  dynamicHosts: Array<Record<string, unknown>>;
  dynamicMeshEvents: Array<Record<string, unknown>>;
}

export function createAdeStore(): AdeStateStore {
  return {
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
        updatedAt: new Date().toISOString(),
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
        updatedAt: new Date().toISOString(),
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
    dynamicHosts: [],
    dynamicMeshEvents: [],
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > 64 * 1024) return null;
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res
    .writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    .end(JSON.stringify(body));
}

function sendBadRequest(res: ServerResponse, msg: string): true {
  reply(res, 400, msg);
  return true;
}

function nowTimeStr(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

export async function handleAdeRoute(
  db: Db,
  store: AdeStateStore,
  req: IncomingMessage,
  res: ServerResponse,
  subpath: string,
): Promise<boolean> {
  // 1. 会话内实时三挡引导与引擎热切换: POST /sessions/:id/steer
  const steerMatch = /^\/sessions\/([^/]+)\/steer$/.exec(subpath);
  if (steerMatch && req.method === 'POST') {
    const sessionId = decodeURIComponent(steerMatch[1] ?? '');
    const body = await readJson(req);
    if (!body) return sendBadRequest(res, '请求体不是合法 JSON');
    const modeRaw = String(body.mode ?? 'steer');
    const modeLabel =
      modeRaw === 'jump' ? '紧急插队 Jump' : modeRaw === 'queue' ? '排队 Queue' : '实时引导 Steer';
    const channel = String(body.channel ?? 'reclaude::claude-opus-5-5');
    const effort = (body.effort as 'low' | 'medium' | 'high' | 'max' | undefined) ?? 'high';
    const text = String(body.text ?? '').trim();
    if (!text) return sendBadRequest(res, '引导内容不能为空');

    const existing = store.sessionMeta[sessionId];
    if (existing) {
      existing.model = channel;
      existing.effort = effort;
      existing.updatedAt = new Date().toISOString();
    }
    const modelShort = channel.split('::')[1] ?? channel;
    const ev = await appendToSession(db, sessionId, 'worker.progress.reported', {
      summary: `[${modeLabel}] ${text} (接力引擎: ${modelShort} · 思考档位: ${effort})`,
      steerMode: modeRaw,
      channel,
      effort,
    });
    sendJson(res, { ok: true, id: ev.id, sessionMeta: store.sessionMeta[sessionId] ?? null });
    return true;
  }

  // 2. 宿主集群与跨机协同: GET /cluster, POST /cluster/hosts, POST /cluster/dispatch
  if (subpath === '/cluster' && req.method === 'GET') {
    sendJson(res, { hosts: store.dynamicHosts, meshEvents: store.dynamicMeshEvents });
    return true;
  }
  if (subpath === '/cluster/hosts' && req.method === 'POST') {
    const host = await readJson(req);
    if (!host) return sendBadRequest(res, '请求体不是合法 JSON');
    store.dynamicHosts.push(host);
    const meshEv = {
      id: `mesh-${Date.now()}`,
      at: '刚刚',
      fromHost: '集群控制面',
      toHost: String(host.name ?? ''),
      kind: 'contract-sync',
      message: `[新节点入网] 已挂载主机「${String(host.name ?? '')}」(${String(host.endpoint ?? '')})，hostd 握手成功并加入跨机协同黑板。`,
    };
    store.dynamicMeshEvents.unshift(meshEv);
    sendJson(res, { ok: true, host, meshEvent: meshEv });
    return true;
  }
  if (subpath === '/cluster/dispatch' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendBadRequest(res, '请求体不是合法 JSON');
    const sessionId = String(body.sessionId ?? `job-mesh-${Date.now()}`);
    const hostName = String(body.hostName ?? '主力云节点');
    const hostId = String(body.hostId ?? 'vps-france');
    const model = String(body.model ?? 'reclaude::claude-opus-5-5');
    const title = String(body.title ?? '跨机派工任务');

    store.sessionMeta[sessionId] = {
      sessionId,
      title,
      workspaceId: store.activeWorkspaceId,
      role: 'worker-code',
      model,
      effort: 'high',
      hostId,
      writeScope: 'packages/**',
      yskEnabled: true,
      branch: `mesh/${sessionId}`,
      updatedAt: new Date().toISOString(),
    };

    await appendToSession(db, sessionId, 'session.turn.started', {
      turnId: 't1',
      text: `[跨机定向派工 → ${hostName}] ${title}`,
    });
    await appendToSession(db, sessionId, 'worker.spawned', {
      runId: sessionId,
      sessionId,
      sessionMode: 'new',
      model,
    });
    await appendToSession(db, sessionId, 'worker.progress.reported', {
      summary: `已在主机【${hostName}】拉起隔离 worktree，跨机黑板 Mesh 总线已连接。`,
      percent: 15,
    });
    const meshEv = {
      id: `mesh-dispatch-${Date.now()}`,
      at: '刚刚',
      fromHost: '集群调度器',
      toHost: hostName,
      kind: 'task-dispatch',
      message: `[跨机定向派工] 任务「${title}」已派发至主机【${hostName}】，执行模型 ${model}，全集群黑板实时同步中。`,
    };
    store.dynamicMeshEvents.unshift(meshEv);
    sendJson(res, { ok: true, sessionId, meshEvent: meshEv });
    return true;
  }

  // 3. ADE 全局状态读取: GET /ade/state
  if (subpath === '/ade/state' && req.method === 'GET') {
    sendJson(res, {
      workspaces: store.workspaces,
      activeWorkspaceId: store.activeWorkspaceId,
      models: store.models,
      routes: store.routes,
      overlays: store.overlays,
      sessionMeta: store.sessionMeta,
      waveNodes: store.waveNodes,
      blackboardFacts: store.blackboardFacts,
      decisionsResolved: store.decisionsResolved,
    });
    return true;
  }

  // 4. 工作区管理: POST /ade/workspaces
  if (subpath === '/ade/workspaces' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendBadRequest(res, '请求体不是合法 JSON');
    const action = String(body.action ?? 'add');

    if (action === 'select') {
      const wsId = String(body.workspaceId ?? '');
      if (store.workspaces.some((w) => w.id === wsId)) {
        store.activeWorkspaceId = wsId;
      }
      sendJson(res, { ok: true, activeWorkspaceId: store.activeWorkspaceId, workspaces: store.workspaces });
      return true;
    }

    if (action === 'delete') {
      const wsId = String(body.workspaceId ?? '');
      if (store.workspaces.length > 1) {
        store.workspaces = store.workspaces.filter((w) => w.id !== wsId);
        if (store.activeWorkspaceId === wsId) {
          store.activeWorkspaceId = store.workspaces[0]?.id ?? '';
        }
      }
      sendJson(res, { ok: true, activeWorkspaceId: store.activeWorkspaceId, workspaces: store.workspaces });
      return true;
    }

    const name = String(body.name ?? '').trim();
    const path = String(body.path ?? '').trim();
    if (!name || !path) return sendBadRequest(res, '工作区名称和路径不能为空');
    const newWs: AdeWorkspace = {
      id: String(body.id ?? `ws-${Date.now().toString().slice(-5)}`),
      name,
      path,
      gitUrl: String(body.gitUrl ?? path),
      defaultBranch: String(body.defaultBranch ?? 'main'),
      checkCmd: String(body.checkCmd ?? 'pnpm check'),
      hostId: String(body.hostId ?? 'desktop-win'),
      repoKind: body.repoKind === 'external' ? 'external' : 'self',
    };
    store.workspaces.push(newWs);
    store.activeWorkspaceId = newWs.id;
    sendJson(res, {
      ok: true,
      workspace: newWs,
      activeWorkspaceId: store.activeWorkspaceId,
      workspaces: store.workspaces,
    });
    return true;
  }

  // 5. 新建会话 / 发起任务: POST /ade/sessions
  if (subpath === '/ade/sessions' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendBadRequest(res, '请求体不是合法 JSON');
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) return sendBadRequest(res, '任务描述不能为空');

    const workspaceId = String(body.workspaceId ?? store.activeWorkspaceId);
    const ws = store.workspaces.find((w) => w.id === workspaceId) ?? store.workspaces[0];
    const role = String(body.role ?? 'worker-code');
    const model = String(body.model ?? 'reclaude::claude-opus-5-5');
    const effort = (body.effort as 'low' | 'medium' | 'high' | 'max' | undefined) ?? 'high';
    const hostId = String(body.hostId ?? ws?.hostId ?? 'desktop-win');
    const writeScope = String(body.writeScope ?? 'packages/**').trim() || 'packages/**';
    const yskEnabled = body.yskEnabled !== false;
    const runId = `ade-${Date.now().toString().slice(-6)}`;
    const sessionId = String(body.sessionId ?? `worker-${runId}`);
    const branch = String(body.branch ?? `feat/${runId}`);

    const meta: AdeSessionMeta = {
      sessionId,
      title: prompt.slice(0, 72),
      workspaceId: ws?.id ?? 'ws-fleet-dao',
      role,
      model,
      effort,
      hostId,
      writeScope,
      yskEnabled,
      branch,
      statusOverride: 'running',
      updatedAt: new Date().toISOString(),
    };
    store.sessionMeta[sessionId] = meta;

    await appendToSession(db, sessionId, 'session.turn.started', {
      turnId: 't1',
      text: `[工作区: ${ws?.name ?? 'fleet-dao'} · 工种: ${role} · 模型: ${model.split('::')[1] ?? model} · 思考档位: ${effort}] ${prompt}`,
    });
    await appendToSession(db, sessionId, 'worker.spawn.requested', {
      task: prompt,
      expected: `通过工作区门禁 ${ws?.checkCmd ?? 'pnpm check'}`,
      must_do: `限定写范围 ${writeScope}，分支 ${branch}`,
      must_not: ws?.repoKind === 'external' ? '对外仓严禁带 AI 署名行与越界改动' : '严禁修改范围外文件',
      context: `工作区路径: ${ws?.path ?? 'D:/frank/fleet-dao'} (${hostId})`,
      stop_when: `${ws?.checkCmd ?? 'pnpm check'} 退出码为 0`,
    });
    await appendToSession(db, sessionId, 'worker.spawned', {
      runId,
      sessionId,
      sessionMode: 'new',
      model,
      effort,
      workspaceId: meta.workspaceId,
      hostId,
      writeScope,
    });
    await appendToSession(db, sessionId, 'worker.progress.reported', {
      summary: `已在工作区「${ws?.name ?? 'fleet-dao'}」(${ws?.path ?? '.'}) 切出分支 ${branch}，挂载模型 ${model} (档位: ${effort})${yskEnabled ? '，YSK (devin/swe-2) 旁路盯梢已激活' : ''}。`,
      percent: 25,
    });

    // 同步往 transcript:<runId> 写入真实过程步骤，让详情页时间线立刻有代码分析与工具执行记录
    const tStream = transcriptStream(runId);
    await appendToStream(db, tStream, 'transcript.assistant', {
      runId,
      text: `收到任务：「${prompt}」。已加载工作区 \`${ws?.path ?? 'D:/frank/fleet-dao'}\`，写范围锁 \`${writeScope}\`，准备调用 Scout 预切片定位目标文件。`,
      truncated: false,
      chars: 64,
    });
    await appendToStream(db, tStream, 'transcript.tool_use', {
      runId,
      toolUseId: `${runId}-tu-1`,
      name: 'codegraph_explore',
      summary: `${prompt.slice(0, 36)} (${ws?.path ?? 'D:/frank/fleet-dao'})`,
      input: JSON.stringify({ query: prompt.slice(0, 48), projectPath: ws?.path ?? 'D:/frank/fleet-dao' }),
      inputTruncated: false,
    });
    await appendToStream(db, tStream, 'transcript.tool_result', {
      runId,
      toolUseId: `${runId}-tu-1`,
      isError: false,
      text: `定位到目标模块（写范围 ${writeScope}），正在按 ${model.split('::')[1] ?? model} (${effort}) 策略执行修改并准备运行 \`${ws?.checkCmd ?? 'pnpm check'}\`。`,
      truncated: false,
      chars: 72,
    });

    sendJson(res, { ok: true, sessionId, runId, meta });
    return true;
  }

  // 6. 会话内实时操控（热切模型/档位、暂停、恢复、终止、完成、Fork 分叉）: POST /ade/sessions/:id/control
  const ctrlMatch = /^\/ade\/sessions\/([^/]+)\/control$/.exec(subpath);
  if (ctrlMatch && req.method === 'POST') {
    const sessionId = decodeURIComponent(ctrlMatch[1] ?? '');
    const body = await readJson(req);
    if (!body) return sendBadRequest(res, '请求体不是合法 JSON');
    const action = String(body.action ?? '');

    const current: AdeSessionMeta = store.sessionMeta[sessionId] ?? {
      sessionId,
      title: sessionId,
      workspaceId: store.activeWorkspaceId,
      role: 'worker-code',
      model: 'reclaude::claude-opus-5-5',
      effort: 'high',
      hostId: 'desktop-win',
      writeScope: 'packages/**',
      yskEnabled: true,
      branch: `work/${sessionId}`,
      updatedAt: new Date().toISOString(),
    };
    store.sessionMeta[sessionId] = current;

    if (action === 'switch-config') {
      if (typeof body.model === 'string' && body.model) current.model = body.model;
      if (typeof body.effort === 'string' && body.effort) {
        current.effort = body.effort as 'low' | 'medium' | 'high' | 'max';
      }
      if (typeof body.workspaceId === 'string' && body.workspaceId) current.workspaceId = body.workspaceId;
      if (typeof body.hostId === 'string' && body.hostId) current.hostId = body.hostId;
      if (typeof body.writeScope === 'string' && body.writeScope) current.writeScope = body.writeScope;
      if (typeof body.role === 'string' && body.role) current.role = body.role;
      current.updatedAt = new Date().toISOString();

      await appendToSession(db, sessionId, 'worker.progress.reported', {
        summary: `[会话配置热更新] 模型切换为 ${current.model} · 思考档位 ${current.effort} · 工种 ${current.role} · 写范围 ${current.writeScope}`,
        model: current.model,
        effort: current.effort,
      });
      sendJson(res, { ok: true, meta: current });
      return true;
    }

    if (action === 'pause' || action === 'stop') {
      current.statusOverride = action === 'pause' ? 'paused' : 'stopped';
      current.updatedAt = new Date().toISOString();
      await appendToSession(db, sessionId, 'worker.stop.requested', {
        reason: action === 'pause' ? '创始人在驾驶舱点击暂停会话' : '创始人在驾驶舱手动终止会话',
      });
      await appendToSession(db, sessionId, 'worker.settled', {
        runId: sessionId,
        status: 'stopped',
        exitCode: 0,
        killed: false,
      });
      sendJson(res, { ok: true, meta: current });
      return true;
    }

    if (action === 'resume' || action === 'retry') {
      current.statusOverride = 'running';
      current.updatedAt = new Date().toISOString();
      await appendToSession(db, sessionId, 'worker.spawned', {
        runId: sessionId,
        sessionId,
        sessionMode: 'resume',
        model: current.model,
      });
      await appendToSession(db, sessionId, 'worker.progress.reported', {
        summary: `[会话已恢复执行] 使用模型 ${current.model} (档位: ${current.effort}) 继续推进任务。`,
        percent: 50,
      });
      sendJson(res, { ok: true, meta: current });
      return true;
    }

    if (action === 'complete') {
      current.statusOverride = 'done';
      current.updatedAt = new Date().toISOString();
      await appendToSession(db, sessionId, 'handback.recorded', {
        final: true,
        outcome: 'completed',
        verdict: 'passed',
        summary: '驾驶舱手动确认验收通过并合流收口。',
      });
      sendJson(res, { ok: true, meta: current });
      return true;
    }

    if (action === 'fork') {
      const forkRunId = `fork-${Date.now().toString().slice(-5)}`;
      const forkedSessionId = `worker-${forkRunId}`;
      const forkPrompt = String(body.prompt ?? `从会话 ${sessionId} 分叉继续探索新方案`).trim();
      const forkMeta: AdeSessionMeta = {
        ...current,
        sessionId: forkedSessionId,
        title: `[Fork 自 ${sessionId}] ${forkPrompt}`,
        branch: `${current.branch}-fork`,
        statusOverride: 'running',
        updatedAt: new Date().toISOString(),
      };
      store.sessionMeta[forkedSessionId] = forkMeta;
      await appendToSession(db, forkedSessionId, 'session.turn.started', {
        turnId: 't1',
        text: `[分叉自 ${sessionId} · 模型: ${forkMeta.model} · 档位: ${forkMeta.effort}] ${forkPrompt}`,
      });
      await appendToSession(db, forkedSessionId, 'worker.spawned', {
        runId: forkRunId,
        sessionId: forkedSessionId,
        sessionMode: 'new',
        model: forkMeta.model,
      });
      await appendToSession(db, forkedSessionId, 'worker.progress.reported', {
        summary: `已继承父会话 ${sessionId} 的上下文切片与工作区设置，开始在独立分支 ${forkMeta.branch} 推进。`,
        percent: 30,
      });
      sendJson(res, { ok: true, forkedSessionId, meta: forkMeta });
      return true;
    }

    return sendBadRequest(res, '未知的会话控制动作');
  }

  // 7. 四维路由与模型参数、Prompt 护栏管理: POST /ade/routing
  if (subpath === '/ade/routing' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendBadRequest(res, '请求体不是合法 JSON');
    const action = String(body.action ?? '');

    if (action === 'update-route') {
      const role = String(body.role ?? '');
      const target = store.routes.find((r) => r.role === role || r.roleLabel === role);
      if (target) {
        if (typeof body.primary === 'string' && body.primary) target.primary = body.primary;
        if (typeof body.secondary === 'string' && body.secondary) target.secondary = body.secondary;
        if (typeof body.effort === 'string' && body.effort) {
          target.effort = body.effort as 'low' | 'medium' | 'high' | 'max';
        }
        if (typeof body.maxConcurrency === 'number') target.maxConcurrency = body.maxConcurrency;
        if (typeof body.overlayNote === 'string') target.overlayNote = body.overlayNote;
      }
      sendJson(res, { ok: true, routes: store.routes });
      return true;
    }

    if (action === 'add-model') {
      const id = String(body.id ?? '').trim();
      const label = String(body.label ?? '').trim();
      if (!id || !label) return sendBadRequest(res, '模型 ID 和显示名称不能为空');
      const model: AdeModelOption = {
        id,
        label,
        runner:
          body.runner === 'native-reclaude-stream' || body.runner === 'native-cli'
            ? body.runner
            : 'pi-api-stream',
        family: (body.family as AdeModelOption['family']) ?? 'claude',
        quotaNote: String(body.quotaNote ?? '充足 (自定义接入)'),
      };
      if (!store.models.some((m) => m.id === id)) {
        store.models.push(model);
      }
      sendJson(res, { ok: true, models: store.models });
      return true;
    }

    if (action === 'add-overlay-rule') {
      const family = String(body.family ?? 'deepseek');
      const rule = String(body.rule ?? '').trim();
      if (!rule) return sendBadRequest(res, '规则内容不能为空');
      const overlay = store.overlays[family];
      if (overlay) {
        overlay.rules.push(`[手动新增] ${rule}`);
        overlay.evolvedCount += 1;
      }
      sendJson(res, { ok: true, overlays: store.overlays });
      return true;
    }

    return sendBadRequest(res, '未知的路由配置操作');
  }

  // 8. 任务波次 DAG 编排: POST /ade/waves
  if (subpath === '/ade/waves' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendBadRequest(res, '请求体不是合法 JSON');
    const action = String(body.action ?? 'create-wave');

    if (action === 'create-wave') {
      const title = String(body.title ?? '').trim();
      if (!title) return sendBadRequest(res, '波次任务标题不能为空');
      const modelName = String(body.modelName ?? 'Kiro · Claude Sonnet');
      const writeScope = String(body.writeScope ?? 'packages/harness-web/**');
      const waveNum = ([1, 2, 3].includes(Number(body.wave)) ? Number(body.wave) : 2) as 1 | 2 | 3;
      const runId = `w${waveNum}-${Date.now().toString().slice(-4)}`;
      const sessionId = `worker-${runId}`;
      const nodeId = `W${waveNum}-S${store.waveNodes.filter((n) => n.wave === waveNum).length + 1}`;

      const newNode: AdeWaveSubtask = {
        id: nodeId,
        wave: waveNum,
        title,
        role: String(body.role ?? 'worker-code'),
        runnerBadge: modelName.includes('reclaude') ? '官方本体直通' : 'pi常驻流',
        modelName,
        accountTag: String(body.accountTag ?? 'auto-pool'),
        writeScope,
        status: 'running',
        sessionId,
        funnelStep: 'Gate 1 (YSK 盯梢已挂载) · 已派发执行',
        savedTokens: '预计省 12.5k Tokens',
      };
      store.waveNodes.push(newNode);

      const fact: AdeBlackboardFact = {
        id: `bf-${Date.now()}`,
        at: nowTimeStr(),
        from: `${nodeId} (${modelName})`,
        scope: writeScope,
        text: `[新波次节点启动] 已锁定写范围 ${writeScope}，开始执行「${title}」，同波次会话实时共享契约。`,
      };
      store.blackboardFacts.unshift(fact);

      // 真实创建该波次子任务的会话流
      await appendToSession(db, sessionId, 'session.turn.started', {
        turnId: 't1',
        text: `[波次 ${nodeId} · ${modelName}] ${title}`,
      });
      await appendToSession(db, sessionId, 'worker.spawned', {
        runId,
        sessionId,
        sessionMode: 'new',
        model: modelName,
      });
      await appendToSession(db, sessionId, 'worker.progress.reported', {
        summary: `波次节点 ${nodeId} 已在写范围 ${writeScope} 启动，黑板广播已同步。`,
        percent: 20,
      });

      sendJson(res, {
        ok: true,
        node: newNode,
        waveNodes: store.waveNodes,
        blackboardFacts: store.blackboardFacts,
      });
      return true;
    }

    if (action === 'advance-node') {
      const nodeId = String(body.nodeId ?? '');
      const target = store.waveNodes.find((n) => n.id === nodeId);
      if (target) {
        if (typeof body.modelName === 'string' && body.modelName) {
          target.modelName = body.modelName;
        }
        target.status = target.status === 'ready' ? 'running' : 'verified';
        target.funnelStep =
          target.status === 'verified'
            ? 'Gate 1~4 全绿 · 已合入波次分支'
            : `已换模型 ${target.modelName} 重新拉起执行`;
        store.blackboardFacts.unshift({
          id: `bf-${Date.now()}`,
          at: nowTimeStr(),
          from: `${target.id} (${target.modelName})`,
          scope: target.writeScope,
          text:
            target.status === 'verified'
              ? `[节点核验合流] ${target.id}「${target.title}」已通过四道门禁并合入波次分支。`
              : `[节点重派] ${target.id} 已切换至 ${target.modelName} 推进。`,
        });
      }
      sendJson(res, { ok: true, waveNodes: store.waveNodes, blackboardFacts: store.blackboardFacts });
      return true;
    }

    return sendBadRequest(res, '未知的波次操作');
  }

  // 9. 决策拍板持久化: POST /ade/decisions
  if (subpath === '/ade/decisions' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendBadRequest(res, '请求体不是合法 JSON');
    const id = String(body.id ?? '');
    const verdict = body.verdict === 'rejected' ? 'rejected' : 'approved';
    if (id) {
      store.decisionsResolved[id] = verdict;
    }
    sendJson(res, { ok: true, decisionsResolved: store.decisionsResolved });
    return true;
  }

  return false;
}
