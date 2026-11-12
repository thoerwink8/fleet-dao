// 模块化、大白话的「多机管理与派活」中心。
// 统一使用 UiCard / UiSectionHeader / UiButton / UiField / UiInput / UiSelect / UiSegmentedTabs 重构，
// 支持随时添加新机器、选机器派活、查看每台机器当前干到百分之几、看终端输出与机器间互通消息。
import {
  Activity,
  ArrowRight,
  Cpu,
  Lock,
  Network,
  PauseCircle,
  PlayCircle,
  Plus,
  Send,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Chip } from '../components/chip';
import { PageBar } from '../components/shell';
import { UiButton, UiCard, UiField, UiInput, UiSectionHeader, UiSelect } from '../components/ui-kit';
import { API_BASE } from '../lib/api';
import { cn } from '../lib/cn';

export type HostTransport = 'Linux VPS' | 'Desktop Local' | '公司内网 SSH 隧道' | 'SSH 远端节点';

export interface ActiveHostJob {
  sessionId: string;
  title: string;
  model: string;
  percent: number;
  currentStep: string;
}

export interface ClusterHostNode {
  id: string;
  name: string;
  kind: HostTransport;
  endpoint: string;
  daemonVersion: string;
  tags: string[];
  cpuLoad: string;
  memUsed: string;
  maxSlots: number;
  activeStreams: string;
  keyIsolation: string;
  status: 'online' | 'draining';
  currentJobs: ActiveHostJob[];
  ptyLines: string[];
}

const INITIAL_HOSTS: readonly ClusterHostNode[] = [
  {
    id: 'vps-france',
    name: '云端主机 #1 (Ubuntu 24.04 · 6核12G)',
    kind: 'Linux VPS',
    endpoint: 'ssh://10.99.0.2 · 后台常驻',
    daemonVersion: 'fleet-daemon 0.1.0',
    tags: ['24小时在线', '跑重测试'],
    cpuLoad: '28%',
    memUsed: '5.4 / 12 GB',
    maxSlots: 6,
    activeStreams: '正在跑 2 个会话',
    keyIsolation: '不同账号按系统用户隔离，互不串号',
    status: 'online',
    currentJobs: [
      {
        sessionId: 'cmd-demo-login-fix',
        title: '第一步 · W1-S2: 核心调度与状态机验证',
        model: 'reclaude · Claude Opus 5.5',
        percent: 85,
        currentStep: 'cargo test 全部通过，正在写结果',
      },
      {
        sessionId: 'cmd-demo-migration',
        title: '第二步 · W2-S1: 模型规则与防跑偏盯梢',
        model: 'kiro · Claude Sonnet',
        percent: 70,
        currentStep: '正在跑 packages/omp-bridge 单元测试',
      },
    ],
    ptyLines: [
      '$ fleet-daemon self-check',
      '{"status":"ok","daemon":"fleet-daemon 0.1.0","antiBanVerified":true,"sampleCodeRoute":{"runner":"native-reclaude-stream","account_id":"reclaude-carpool-a"}}',
      '$ systemctl status fleet-daemon --no-pager',
      'Active: active (running) · 2 reclaude streams + 4 pi rpc streams · 0 zombie children',
    ],
  },
  {
    id: 'desktop-win',
    name: '本机电脑 (Windows 11 · 桌面与浏览器)',
    kind: 'Desktop Local',
    endpoint: '本机 · D:/frank/fleet-dao (127.0.0.1:7347)',
    daemonVersion: 'fleet-hostd 0.1.0',
    tags: ['桌面浏览器', '本机代码'],
    cpuLoad: '16%',
    memUsed: '6.8 / 32 GB',
    maxSlots: 4,
    activeStreams: '1 个会话 + 浏览器截图检查',
    keyIsolation: '密钥锁在本机钥匙串，任务只走本地端口',
    status: 'online',
    currentJobs: [
      {
        sessionId: 'cmd-demo-docs-sweep',
        title: '第三步 · W3-S1: 驾驶舱电脑与手机双屏截图检查',
        model: 'antigravity · Gemini 3.1 Pro',
        percent: 95,
        currentStep: '双屏排版检查全部通过',
      },
    ],
    ptyLines: [
      '$ ~/.local/bin/fleet-daemon.exe route worker-code',
      '{"selectedRoute":{"role":"worker-code","channel_id":"reclaude","model_id":"claude-opus-5-5","runner":"native-reclaude-stream"}}',
      '$ ~/.local/bin/fleet-hostd.exe status',
      '{"status":"online","binary":"fleet-hostd 0.1.0","reverseLoopbackPort":19820}',
    ],
  },
  {
    id: 'corp-intranet-01',
    name: '公司内网机 (跳板机穿透 · 不存密钥)',
    kind: '公司内网 SSH 隧道',
    endpoint: 'ssh -J bastion -R 127.0.0.1:19820:127.0.0.1:19820',
    daemonVersion: 'fleet-hostd 0.1.0',
    tags: ['公司内网', '零密钥落盘'],
    cpuLoad: '41%',
    memUsed: '7.1 / 16 GB',
    maxSlots: 4,
    activeStreams: '代码在内网跑，调模型走 SSH 隧道',
    keyIsolation: '内网机器不存任何 API 密钥，提交不带 AI 署名',
    status: 'online',
    currentJobs: [
      {
        sessionId: 'cmd-demo-test-run',
        title: '第二步 · W2-S2: 内网服务联调测试',
        model: 'commoncode · DeepSeek V4 Pro',
        percent: 65,
        currentStep: '正在跑内网集成测试',
      },
    ],
    ptyLines: [
      '$ ~/.local/bin/fleet-hostd.exe tunnel-args dev@10.20.30.40 bastion.corp.internal',
      'ssh -o BatchMode=yes -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes -R 127.0.0.1:19820:127.0.0.1:19820 -J bastion.corp.internal dev@10.20.30.40 ~/.fleet/bin/fleet-hostd --stdio-rpc',
      '{"jsonrpc":"2.0","id":1,"result":{"hostd":"fleet-hostd 0.1.0","mode":"stdio-rpc","intranetZeroKeyDisk":true,"ready":true}}',
    ],
  },
];

interface CrossHostMeshEvent {
  id: string;
  at: string;
  fromHost: string;
  toHost: string;
  kind: 'contract-sync' | 'task-dispatch' | 'ysk-steer';
  message: string;
}

const INITIAL_MESH_EVENTS: readonly CrossHostMeshEvent[] = [
  {
    id: 'mesh-1',
    at: '刚刚',
    fromHost: '云端主机 #1',
    toHost: '公司内网机 & 本机电脑',
    kind: 'contract-sync',
    message: 'W1-S2 改完接口定义，已自动发消息通知内网机与本机电脑正在跑的会话。',
  },
  {
    id: 'mesh-2',
    at: '1 分钟前',
    fromHost: '本机电脑',
    toHost: '公司内网机',
    kind: 'task-dispatch',
    message: '已把内网联调任务 W2-S2 派给公司内网机，通过本地 19820 隧道提供模型能力。',
  },
];

const RECLAUDE_ACCOUNTS = [
  {
    accountId: 'reclaude-main',
    hostUser: 'vps-france:fleet-agent',
    runner: '官方直连 (不走代理)',
    windowUsed: '$18.40 / $80.00',
    resetsIn: '3 小时 12 分后刷新',
    antiBanStatus: '正常 · 独立系统用户',
  },
  {
    accountId: 'reclaude-carpool-a',
    hostUser: 'vps-france:fleet-agent-carpool',
    runner: '官方直连 (不走代理)',
    windowUsed: '$52.10 / $80.00',
    resetsIn: '42 分钟后刷新（优先使用）',
    antiBanStatus: '正常 · 独立目录与机器码',
  },
];

export function OpsPage({ hideBar = false }: { hideBar?: boolean } = {}) {
  const [hosts, setHosts] = useState<ClusterHostNode[]>(() => [...INITIAL_HOSTS]);
  const [selectedHost, setSelectedHost] = useState<string>('corp-intranet-01');
  const [meshEvents, setMeshEvents] = useState<CrossHostMeshEvent[]>(() => [...INITIAL_MESH_EVENTS]);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newHostName, setNewHostName] = useState('');
  const [newHostKind, setNewHostKind] = useState<HostTransport>('SSH 远端节点');
  const [newHostEndpoint, setNewHostEndpoint] = useState('');
  const [newHostTags, setNewHostTags] = useState('linux, 写代码');

  const [dispatchTargetHost, setDispatchTargetHost] = useState<string>('corp-intranet-01');
  const [dispatchModel, setDispatchModel] = useState<string>('commoncode::deepseek-v4-pro');
  const [dispatchTaskTitle, setDispatchTaskTitle] = useState('');

  useEffect(() => {
    fetch(`${API_BASE}/cluster`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { hosts?: ClusterHostNode[]; meshEvents?: CrossHostMeshEvent[] } | null) => {
        if (!data) return;
        if (Array.isArray(data.hosts) && data.hosts.length > 0) {
          setHosts((prev) => {
            const existingIds = new Set(prev.map((h) => h.id));
            const added = data.hosts?.filter((h) => !existingIds.has(h.id)) ?? [];
            return [...prev, ...added];
          });
        }
        if (Array.isArray(data.meshEvents) && data.meshEvents.length > 0) {
          setMeshEvents((prev) => {
            const existingIds = new Set(prev.map((m) => m.id));
            const added = data.meshEvents?.filter((m) => !existingIds.has(m.id)) ?? [];
            return [...added, ...prev];
          });
        }
      })
      .catch(() => undefined);
  }, []);

  const activeHostObj = hosts.find((h) => h.id === selectedHost) ?? hosts[0];
  const onlineCount = hosts.filter((h) => h.status === 'online').length;

  const handleAddHost = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newHostName.trim();
    const endpoint = newHostEndpoint.trim();
    if (!name || !endpoint) return;
    const id = `host-${Date.now()}`;
    const tags = newHostTags
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const created: ClusterHostNode = {
      id,
      name,
      kind: newHostKind,
      endpoint,
      daemonVersion: 'fleet-hostd 0.1.0',
      tags: tags.length > 0 ? tags : ['新机器'],
      cpuLoad: '8%',
      memUsed: '1.2 / 16 GB',
      maxSlots: 4,
      activeStreams: '已连上 · 0 在跑',
      keyIsolation:
        newHostKind === '公司内网 SSH 隧道' ? '走 SSH 隧道调模型 · 机器上不存密钥' : '独立目录隔离',
      status: 'online',
      currentJobs: [],
      ptyLines: [
        `$ fleet-hostd connect ${endpoint}`,
        `{"jsonrpc":"2.0","id":1,"result":{"hostId":"${id}","status":"online","intranetZeroKeyDisk":true}}`,
      ],
    };
    setHosts((prev) => [...prev, created]);
    setSelectedHost(id);
    setDispatchTargetHost(id);
    setMeshEvents((prev) => [
      {
        id: `mesh-${Date.now()}`,
        at: '刚刚',
        fromHost: '机器管理',
        toHost: name,
        kind: 'contract-sync',
        message: `[新节点入网] 已添加机器「${name}」(${endpoint})，连接正常，随时可以派活。`,
      },
      ...prev,
    ]);
    void fetch(`${API_BASE}/cluster/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(created),
    }).catch(() => undefined);
    setNewHostName('');
    setNewHostEndpoint('');
    setShowAddModal(false);
  };

  const handleDispatchToHost = (e: React.FormEvent) => {
    e.preventDefault();
    const title = dispatchTaskTitle.trim();
    if (!title) return;
    const target = hosts.find((h) => h.id === dispatchTargetHost);
    if (!target) return;
    const sessionId = `worker-${target.id}-${Date.now().toString().slice(-4)}`;
    const modelLabel = dispatchModel.split('::')[1] ?? dispatchModel;

    setHosts((prev) =>
      prev.map((h) =>
        h.id === target.id
          ? {
              ...h,
              currentJobs: [
                {
                  sessionId,
                  title,
                  model: modelLabel,
                  percent: 15,
                  currentStep: `已在 ${target.name} 启动，正在定位相关代码`,
                },
                ...h.currentJobs,
              ],
              ptyLines: [
                ...h.ptyLines,
                `$ fleet-daemon dispatch --host ${target.id} --model ${modelLabel} "${title}"`,
                `{"session":"${sessionId}","host":"${target.id}","status":"running"}`,
              ],
            }
          : h,
      ),
    );

    setMeshEvents((prev) => [
      {
        id: `mesh-dispatch-${Date.now()}`,
        at: '刚刚',
        fromHost: '集群调度器',
        toHost: target.name,
        kind: 'task-dispatch',
        message: `[跨机定向派工] 任务「${title}」已派发至主机【${target.name}】，执行模型 ${modelLabel}，全集群黑板实时同步中。`,
      },
      ...prev,
    ]);
    void fetch(`${API_BASE}/cluster/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hostId: target.id,
        hostName: target.name,
        model: modelLabel,
        title,
        sessionId,
      }),
    }).catch(() => undefined);
    setDispatchTaskTitle('');
  };

  const toggleHostStatus = (id: string) => {
    setHosts((prev) =>
      prev.map((h) => (h.id === id ? { ...h, status: h.status === 'online' ? 'draining' : 'online' } : h)),
    );
  };

  const removeHost = (id: string) => {
    setHosts((prev) => prev.filter((h) => h.id !== id));
    if (selectedHost === id && hosts[0]) {
      setSelectedHost(hosts[0].id);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {hideBar ? null : (
        <PageBar
          title="机器与派活"
          extra={
            <div className="flex items-center gap-2">
              <span className="num hidden items-center gap-1.5 text-xs text-ink-2 sm:inline-flex">
                <ShieldCheck className="size-3.5 text-brand" />
                {onlineCount} 台机器在线
              </span>
              <UiButton
                variant="primary"
                size="sm"
                icon={<Plus />}
                onClick={() => setShowAddModal((v) => !v)}
              >
                添加主机节点
              </UiButton>
            </div>
          }
        />
      )}

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 pb-24 md:p-6">
        {/* 新增机器表单模块 */}
        {showAddModal ? (
          <UiCard data-testid="add-host-form" className="border-brand/30 bg-brand-soft/20">
            <UiSectionHeader
              icon={<Server />}
              title="添加新机器"
              subtitle="接入云服务器、Mac、Windows 或公司内网 SSH 机器，随时分担任务"
              action={
                <UiButton variant="ghost" size="xs" onClick={() => setShowAddModal(false)}>
                  取消
                </UiButton>
              }
            />
            <form onSubmit={handleAddHost} className="mt-3.5 grid gap-3 sm:grid-cols-4">
              <UiField label="机器名称">
                <UiInput
                  value={newHostName}
                  onChange={(e) => setNewHostName(e.target.value)}
                  placeholder="例如：法兰克福 GPU 节点"
                  aria-label="新主机名称"
                />
              </UiField>
              <UiField label="连接方式">
                <UiSelect
                  value={newHostKind}
                  onChange={(e) => setNewHostKind(e.target.value as HostTransport)}
                  aria-label="新主机连接模式"
                >
                  <option value="SSH 远端节点">SSH 远端机器</option>
                  <option value="公司内网 SSH 隧道">公司内网机 (不存密钥)</option>
                  <option value="Linux VPS">Linux 云主机</option>
                  <option value="Desktop Local">本机电脑</option>
                </UiSelect>
              </UiField>
              <UiField label="SSH 地址">
                <UiInput
                  value={newHostEndpoint}
                  onChange={(e) => setNewHostEndpoint(e.target.value)}
                  placeholder="ssh://ubuntu@10.88.1.9"
                  aria-label="新主机连接地址"
                  className="font-mono"
                />
              </UiField>
              <UiField label="用途标签（逗号分隔）">
                <div className="flex items-center gap-2">
                  <UiInput
                    value={newHostTags}
                    onChange={(e) => setNewHostTags(e.target.value)}
                    aria-label="新主机能力标签"
                    className="flex-1 font-mono"
                  />
                  <UiButton type="submit" variant="primary">
                    保存接入
                  </UiButton>
                </div>
              </UiField>
            </form>
          </UiCard>
        ) : null}

        {/* 模块 1：机器实时终端输出（首屏直看，窄屏直接点选） */}
        <UiCard aria-label="宿主实时PTY终端跟随">
          <UiSectionHeader
            icon={<Terminal />}
            title="机器终端实时输出"
            subtitle="点选任意机器，实时查看它的后台命令行输出"
            action={
              <div className="flex flex-wrap items-center gap-1.5">
                {hosts.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => setSelectedHost(h.id)}
                    aria-pressed={selectedHost === h.id}
                    className={cn(
                      'h-7 cursor-pointer rounded-lg border px-2.5 text-2xs transition-colors',
                      selectedHost === h.id
                        ? 'border-brand/30 bg-brand-soft font-medium text-brand-strong'
                        : 'border-line bg-surface text-muted hover:text-ink',
                    )}
                  >
                    {h.kind}
                  </button>
                ))}
              </div>
            }
          />
          <pre
            data-testid="ops-pty-output"
            className="mt-3.5 overflow-x-auto rounded-xl border border-line bg-subtle p-3.5 font-mono text-2xs leading-5 text-ink-2"
          >
            {(activeHostObj?.ptyLines ?? []).join('\n')}
          </pre>
        </UiCard>

        {/* 模块 2：直接选一台机器派活 */}
        <UiCard aria-label="跨主机定向派单">
          <UiSectionHeader
            icon={<Send />}
            title="给指定机器派活"
            subtitle="选一台机器和模型，任务立刻在那台机器上启动，进度实时同步回来"
            action={
              hideBar ? (
                <UiButton variant="soft" size="sm" icon={<Plus />} onClick={() => setShowAddModal((v) => !v)}>
                  添加主机节点
                </UiButton>
              ) : null
            }
          />
          <form onSubmit={handleDispatchToHost} className="mt-3.5 grid gap-3 sm:grid-cols-12">
            <UiField label="派给哪台机器" className="sm:col-span-3">
              <UiSelect
                aria-label="选择目标执行主机"
                value={dispatchTargetHost}
                onChange={(e) => setDispatchTargetHost(e.target.value)}
              >
                {hosts
                  .filter((h) => h.status === 'online')
                  .map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
              </UiSelect>
            </UiField>
            <UiField label="用什么模型" className="sm:col-span-3">
              <UiSelect
                aria-label="选择派工模型"
                value={dispatchModel}
                onChange={(e) => setDispatchModel(e.target.value)}
                className="font-mono text-2xs"
              >
                <option value="commoncode::deepseek-v4-pro">DeepSeek V4 Pro</option>
                <option value="kiro::kiro-claude-sonnet">Kiro · Claude Sonnet</option>
                <option value="reclaude::claude-opus-5-5">reclaude · Opus 5.5</option>
                <option value="recodex::gpt-5.3-codex">Recodex · GPT-5.3 Codex</option>
              </UiSelect>
            </UiField>
            <UiField label="要做什么事" className="sm:col-span-6">
              <div className="flex items-center gap-2">
                <UiInput
                  value={dispatchTaskTitle}
                  onChange={(e) => setDispatchTaskTitle(e.target.value)}
                  placeholder="输入要交给这台机器的任务…"
                  aria-label="跨机派工任务描述"
                  className="flex-1"
                />
                <UiButton type="submit" variant="primary" icon={<Send />}>
                  派发到该主机
                </UiButton>
              </div>
            </UiField>
          </form>
        </UiCard>

        {/* 模块 2：每台机器实时状态卡片 */}
        <section aria-label="多宿主节点" className="grid gap-4 md:grid-cols-3">
          {hosts.map((h) => (
            <UiCard
              key={h.id}
              data-testid={`host-card-${h.id}`}
              className="flex min-w-0 flex-col justify-between"
            >
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand">
                    <Server className="size-3.5 shrink-0" />
                    {h.kind}
                  </span>
                  <Chip tone={h.status === 'online' ? 'brand' : 'warning'}>
                    {h.status === 'online' ? '正常接活' : '暂停接活'}
                  </Chip>
                </div>

                <h2 className="mt-2 text-sm font-semibold text-ink">{h.name}</h2>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {h.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-md bg-subtle px-2 py-0.5 font-mono text-2xs text-ink-2"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>

                <dl className="mt-3.5 grid gap-2 rounded-xl bg-subtle/50 p-3 text-2xs">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-muted">CPU / 内存</dt>
                    <dd className="num inline-flex items-center gap-1 font-mono font-medium text-ink">
                      <Cpu className="size-3 text-brand" />
                      <span>
                        {h.cpuLoad} · {h.memUsed}
                      </span>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="shrink-0 text-muted">连接地址</dt>
                    <dd className="truncate font-mono text-ink-2" title={h.endpoint}>
                      {h.endpoint}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="shrink-0 text-muted">安全隔离</dt>
                    <dd className="truncate text-ink-2" title={h.keyIsolation}>
                      {h.keyIsolation}
                    </dd>
                  </div>
                </dl>

                {/* 正在干的活 */}
                <div className="mt-3.5 border-t border-line/70 pt-3">
                  <div className="flex items-center justify-between text-2xs font-medium text-ink-2">
                    <span className="inline-flex items-center gap-1">
                      <Activity className="size-3 text-brand" />
                      正在干的活 ({h.currentJobs.length}/{h.maxSlots})
                    </span>
                  </div>
                  {h.currentJobs.length === 0 ? (
                    <p className="mt-2 rounded-lg bg-subtle/50 p-2.5 text-2xs text-muted">
                      当前空闲，随时可派新任务
                    </p>
                  ) : (
                    <ul className="mt-2 flex flex-col gap-2">
                      {h.currentJobs.map((job) => (
                        <li
                          key={job.sessionId}
                          className="rounded-xl border border-line/70 bg-subtle/40 p-2.5 text-2xs"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-semibold text-ink">{job.title}</span>
                            <span className="num shrink-0 font-mono font-semibold text-brand">
                              {job.percent}%
                            </span>
                          </div>
                          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-line">
                            <div
                              className="h-full rounded-full bg-brand transition-all"
                              style={{ width: `${job.percent}%` }}
                            />
                          </div>
                          <p className="mt-1.5 truncate text-muted">{job.currentStep}</p>
                          <div className="mt-1.5 flex items-center justify-between">
                            <span className="font-mono text-muted">{job.model}</span>
                            <Link
                              to={`/s/${job.sessionId}`}
                              className="inline-flex items-center gap-0.5 font-medium text-brand hover:underline"
                            >
                              看实时过程
                              <ArrowRight className="size-3" />
                            </Link>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between gap-2 border-t border-line/70 pt-3">
                <UiButton
                  variant="secondary"
                  size="xs"
                  icon={<Terminal />}
                  onClick={() => setSelectedHost(h.id)}
                >
                  看终端
                </UiButton>
                <div className="flex items-center gap-1.5">
                  <UiButton
                    variant="secondary"
                    size="xs"
                    icon={h.status === 'online' ? <PauseCircle /> : <PlayCircle />}
                    onClick={() => toggleHostStatus(h.id)}
                  >
                    {h.status === 'online' ? '暂停接活' : '恢复接活'}
                  </UiButton>
                  {hosts.length > 1 ? (
                    <UiButton
                      variant="danger"
                      size="xs"
                      aria-label={`移除主机 ${h.name}`}
                      icon={<Trash2 />}
                      onClick={() => removeHost(h.id)}
                    />
                  ) : null}
                </div>
              </div>
            </UiCard>
          ))}
        </section>

        {/* 模块 4：机器间互通消息记录 */}
        <UiCard aria-label="跨主机实时协同总线">
          <UiSectionHeader
            icon={<Network />}
            title="跨主机实时通信与协同总线"
            subtitle="多台机器一起干活时的派单记录与接口变更通知"
            action={<Chip tone="brand">实时在线</Chip>}
          />
          <ul data-testid="cross-host-mesh-list" className="mt-3.5 divide-y divide-line text-xs">
            {meshEvents.map((m) => (
              <li
                key={m.id}
                className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <span className="font-mono text-2xs font-semibold text-brand">
                    {m.fromHost} → {m.toHost}
                  </span>
                  <p className="mt-1 text-ink-2">{m.message}</p>
                </div>
                <span className="num shrink-0 font-mono text-2xs text-muted">{m.at}</span>
              </li>
            ))}
          </ul>
        </UiCard>

        {/* 模块 5：账号防封隔离状态 */}
        <UiCard aria-label="reclaude防封隔离池">
          <UiSectionHeader
            icon={<Lock />}
            title="Claude 账号隔离状态"
            subtitle="每个账号使用独立系统用户与独立目录，直连官方不走中转，防止串号封禁"
            action={<Chip tone="brand">non_cc_client 风险 = 0</Chip>}
          />
          <div className="mt-3.5 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-line text-2xs text-muted">
                  <th className="py-2 pr-3 font-medium">账号</th>
                  <th className="px-3 py-2 font-medium">所在机器与系统用户</th>
                  <th className="px-3 py-2 font-medium">连接方式</th>
                  <th className="px-3 py-2 font-medium">当前窗口已用</th>
                  <th className="py-2 pl-3 font-medium">隔离状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {RECLAUDE_ACCOUNTS.map((a) => (
                  <tr key={a.accountId}>
                    <td className="py-2.5 pr-3 font-mono font-medium text-ink">{a.accountId}</td>
                    <td className="px-3 py-2.5 font-mono text-brand">{a.hostUser}</td>
                    <td className="px-3 py-2.5 text-2xs text-ink-2">{a.runner}</td>
                    <td className="num px-3 py-2.5 font-mono text-ink">
                      {a.windowUsed} <span className="text-2xs text-muted">({a.resetsIn})</span>
                    </td>
                    <td className="py-2.5 pl-3 text-2xs text-ink-2">{a.antiBanStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </UiCard>
      </div>
    </div>
  );
}
