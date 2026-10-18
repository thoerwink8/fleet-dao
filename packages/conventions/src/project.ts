// pnpm project add|check <owner/仓>（#2749，design 15.7「导入项目 + 标准体检与补齐」）：加新项目一条命令做到底。
//
// add 八步，每步「先查、再补、再核」，可重复跑（已经做到的步只查不写）：
//   1 登记仓：经 ssh 调法国的 fleet-api project register（带 GitHub 仓号，认仓认号）
//   2 装两个 App：读装没装经 ssh 调 fleet-api project installations（#2977：两个机器人的安装令牌只要 metadata:read，
//     和驾驶舱导入列表同一份归并；不读本机 gh 的 user/installations，本机身份缺权限也不挡）；没查成就是没查成（退出码 2），
//     不当成没装、不退回本机 gh 猜。读全了、明确缺哪个角色才补：本机 gh 令牌走单仓接口
//     PUT /user/installations/{安装号}/repositories/{仓号}（没有请求体）；安装号按 owner 记在
//     packages/conventions/github-apps.json，owner 下还没装过就停下，提示先在网页装一次
//   3 同步流程标签：照标准仓（本仓）GitHub 上的标签，缺的建、颜色说明不一样的改，别的标签不动
//   4 仓档案：探测语言、工具链、测试命令、模块根，只补档案里没写的项，经 fleet-api project set-profile 写
//   5 补齐 PR：缺 AGENTS.md、四节单模板、引用本仓可复用合并闸和关单工作流的，开一个 PR 补上（开过还开着就不再开）
//   6 策略读桥：真实 HTTP 现读 DB、核当前头 source；add 经受保护管理命令补缺失 source，check 只读
//   7 跑 project check：全绿才打开「让 AI 接活」（fleet-api dispatch on）；有一项不过就停，接活不开
//   8 开一张冒烟单（四节齐，标题固定，开过就不再开）。有没有这张单只信直接列全的 issues 列表，
//     和开单回执单号的直接读取；搜索索引暂时看不到不算没有，也不把刚开成的单判成失败（#2995）
// check 只读：1～6 各查一遍，全绿退出码 0，有不过的 1，没查成的 2（别的步过了也不抵）。
//
// 碰 GitHub 只经本机 gh（令牌不读出来；App 装没装例外，经法国的 fleet-api 读），碰法国只经 ssh 调 fleet-api；这两样都收在 ProjectWorld 里，测试换成假的。
// 零安装入口只相对引用纯协议文件，不引有外部依赖的模块；档案校验在法国，读取它回的 gaps。

import {
  type PolicyBridgeDescriptor,
  parsePolicyUrl,
  policyId,
  policyRecord,
} from '../../shared/src/ci-policy-bridge.ts';

/** 标签：名字、颜色（不带 #）、说明。 */
export interface RepoLabel {
  name: string;
  color: string;
  description: string;
}

/** GitHub 上这个仓的几样事实。 */
export interface RepoFacts {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
  archived: boolean;
}

export interface FleetApiResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 一张单的事实：单号、完整标题、状态。直接读到的，不经搜索索引。 */
export interface IssueFact {
  number: number;
  title: string;
  state: string;
}

/** 这个命令碰外面的全部口子。真的见 bin/project.ts（gh + ssh），测试用内存里的假的。 */
export interface ProjectWorld {
  repo(slug: string): Promise<RepoFacts>;
  /** 单仓接口 PUT /user/installations/{id}/repositories/{repo}，没有请求体。只在 add 补装时调；读装没装走 fleetApi（#2977）。 */
  addToInstallation(installationId: number, repoId: number): Promise<void>;
  labels(slug: string): Promise<RepoLabel[]>;
  createLabel(slug: string, label: RepoLabel): Promise<void>;
  editLabel(slug: string, label: RepoLabel): Promise<void>;
  /** 仓根（或某个目录）下的条目；目录不在回空。 */
  listDir(slug: string, ref: string, dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]>;
  /** 文件内容；不在回 null。 */
  fileText(slug: string, ref: string, path: string): Promise<string | null>;
  /** 从这个分支开出的、还开着的 PR。 */
  openPrFrom(slug: string, head: string): Promise<{ number: number; url: string } | null>;
  /** 从 base 拉出 head 分支，写进这些文件，开 PR。 */
  openFillPr(
    slug: string,
    input: {
      base: string;
      head: string;
      files: { path: string; text: string }[];
      title: string;
      body: string;
    },
  ): Promise<{ number: number; url: string }>;
  /**
   * 按完整标题找单（开着、关了都算）。不得走搜索索引：刚创建的单搜索会晚一步，空不等于没有（#2995）。
   * 冒烟单「有没有」以 listIssueByTitle 为准；这个口子的空不能当成没有。
   */
  findIssue(slug: string, title: string): Promise<IssueFact | null>;
  /**
   * 直接列这个仓的单，按完整标题对（issues 列表，不走搜索）。
   * 读全了没有回 null。没读成、没读全、有一条认不出抛错：没读到不等于没有。
   */
  listIssueByTitle(slug: string, title: string): Promise<IssueFact | null>;
  /**
   * 按单号直接读（GET /repos/{owner}/{repo}/issues/{number}，不走搜索）。
   * 没有这张单回 null。端口出错或回的认不出抛错。
   */
  readIssue(slug: string, number: number): Promise<IssueFact | null>;
  createIssue(slug: string, input: { title: string; body: string; labels: string[] }): Promise<number>;
  /** 在法国跑一条 fleet-api 子命令（stdin 给了就从标准输入喂进去）。 */
  fleetApi(args: string[], stdin?: string): Promise<FleetApiResult>;
  /** 现读真实 HTTPS 桥和当前 open heads 的 source，仅查不写。 */
  policyBridge(
    slug: string,
    githubId: number,
    descriptor: PolicyBridgeDescriptor,
  ): Promise<{ ciPolicy: 'force' | 'off'; heads: number; missing: number }>;
}

export interface AppInstallConfig {
  apps: Record<'agent' | 'engine', { slug: string; installations: Record<string, number> }>;
}

export interface ProjectContext {
  world: ProjectWorld;
  /** 标准仓（本仓）owner/名字：标签照它、补齐 PR 里的工作流引用它。 */
  standardRepo: string;
  apps: AppInstallConfig;
  out(line: string): void;
}

export type StepStatus = 'ok' | 'fixed' | 'red' | 'unchecked';

export interface StepResult {
  step: string;
  status: StepStatus;
  detail: string;
}

/** 一步的「查」：ok 就是做到了；没做到时 fix 给了就能补，没给就是要人动手（why 说清）。 */
type Probe = { ok: true; detail: string } | { ok: false; why: string; fix?: () => Promise<void> };

class Unchecked extends Error {}

export const PROJECT_USAGE = '用法：pnpm project add <owner/仓> | pnpm project check <owner/仓>';
export const FILL_BRANCH = 'fleet-dao/standard-fill';
export const SMOKE_TITLE = '冒烟：fleet-dao 接活打通';
const SMOKE_LABELS = ['需求', '域:engine', '性质:process'];
export const REQUIRED_FILES = {
  agents: 'AGENTS.md',
  issueTemplate: '.github/ISSUE_TEMPLATE/需求.md',
  mergeGate: '.github/workflows/fleet-merge-gate.yml',
  closeOnMerge: '.github/workflows/fleet-close-on-merge.yml',
} as const;
/** 四节单模板、冒烟单都要有的四节（和 pnpm issue:new 查的同一套）。 */
export const ISSUE_SECTIONS = ['场景', '原话', '已知的模块', '怎么算做完'] as const;

const SLUG = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/;

export function parseProjectArgv(argv: readonly string[]): { action: 'add' | 'check'; slug: string } {
  const [action, slug, ...rest] = argv;
  if ((action !== 'add' && action !== 'check') || !slug || rest.length > 0 || !SLUG.test(slug))
    throw new Error(PROJECT_USAGE);
  return { action, slug };
}

// —— 文件模板 ——

export function mergeGateCaller(standardRepo: string): string {
  return `name: merge-gate
# fleet-ci-policy-bridge: v1
# 合并闸：引用 ${standardRepo} 的可复用工作流（pnpm project add 放的），判法在那边，这里只写触发和权限。
on:
  pull_request_target:
    types: [opened, reopened, synchronize, edited]
  status:
  workflow_dispatch:
    inputs:
      pr:
        description: PR 号；留空算所有开着的
        required: false
permissions:
  contents: read
  pull-requests: read
  statuses: write
jobs:
  merge-gate:
    uses: ${standardRepo}/.github/workflows/merge-gate.yml@main
    with:
      standard-repo: ${standardRepo}
`;
}

export function closeOnMergeCaller(standardRepo: string): string {
  return `name: close-on-merge
# 合并时收口：引用 ${standardRepo} 的可复用工作流（pnpm project add 放的），PR 合并后关掉它「需求」栏挂的、做完了的单。
on:
  pull_request_target:
    types: [closed]
permissions:
  contents: read
  issues: write
  pull-requests: read
jobs:
  close:
    uses: ${standardRepo}/.github/workflows/close-on-merge.yml@main
    with:
      standard-repo: ${standardRepo}
`;
}

export function issueTemplate(): string {
  return `---
name: 需求
about: 要新东西或改行为。四节都要写（pnpm issue:new 开单时查的也是这四节）
---

## 场景

<!-- 这是干什么的、为什么现在做 -->

## 原话

<!-- 创始人当时的原话（逐字）；AI 自己发现的写「无（AI 发现）」 -->

## 已知的模块

<!-- 建单时确实知道的模块；不知道写「暂无」 -->

## 怎么算做完

<!-- 一条一行，写 diff 里看得见的（测试名、文件、命令） -->
`;
}

export function agentsMd(slug: string, standardRepo: string, testCommand: string): string {
  return `# ${slug.split('/')[1]} 协作约定

只写本仓特有的规矩；通用规矩以 ${standardRepo} 为准（同步脚本装进每台机器的全局说明）。

## 去哪找

| 事 | 读 |
|---|---|
| 进度、创始人引导 | \`docs/PROGRESS.md\` |

## 常用

- 测试：\`${testCommand}\`

## 本仓特有

<!-- 第一次进仓的 AI 补：目录、怎么跑、常见坑 -->
`;
}

export function smokeIssueBody(slug: string): string {
  return `## 场景

${slug} 刚用 \`pnpm project add\` 接进 fleet-dao：登记、装 App、标签、仓档案、补齐 PR 都做完了，「让 AI 接活」刚打开。这张单让引擎从拉单到合并走一遍，确认整条线是通的。

## 原话

「比如未来我可能还会加新项目，这才是我的意图」（2026-10-16 16:29）

## 已知的模块

- \`docs/fleet-smoke.md\`（新建）

## 怎么算做完

- 仓里新建 \`docs/fleet-smoke.md\`，一行：\`fleet-dao 冒烟：引擎接活打通\`。
`;
}

// —— 探测仓档案 ——

/** 从仓根的文件认语言、工具链、测试命令、模块根。认不出的项不写（留给法国那头补默认值，check 会报缺）。 */
export async function detectProfile(
  world: ProjectWorld,
  slug: string,
  ref: string,
): Promise<Record<string, unknown>> {
  const root = await world.listDir(slug, ref, '');
  const has = (name: string) => root.some((e) => e.name === name);
  const dir = (name: string) => root.some((e) => e.name === name && e.type === 'dir');
  const out: Record<string, unknown> = {};
  let pkgScripts: Record<string, unknown> = {};
  if (has('package.json')) {
    try {
      const pkg = JSON.parse((await world.fileText(slug, ref, 'package.json')) ?? '{}') as {
        scripts?: unknown;
      };
      if (pkg.scripts && typeof pkg.scripts === 'object') pkgScripts = pkg.scripts as Record<string, unknown>;
    } catch {
      // package.json 认不出：当没有 scripts，测试命令往下按语言猜
    }
  }
  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('package.json') ? 'npm' : null;
  const toolchain: string[] = [];
  if (has('go.mod')) {
    out.language = 'go';
    toolchain.push('go');
    out.moduleRoots = ['cmd', 'internal', 'pkg'].filter(dir).map((d) => `${d}/*`);
  } else if (has('Cargo.toml')) {
    out.language = 'rust';
    toolchain.push('cargo');
  } else if (has('pyproject.toml') || has('requirements.txt')) {
    out.language = 'python';
    toolchain.push('python');
  } else if (has('package.json')) {
    out.language = has('tsconfig.json') ? 'typescript' : 'javascript';
    out.moduleRoots = ['packages', 'apps'].filter(dir).map((d) => `${d}/*`);
  }
  if (pm) toolchain.push('node', pm);
  out.toolchain = toolchain;
  // 标准要每个仓都有 pnpm check（仓合同 entry）；有就用它，没有按语言给惯用的
  const runner = pm === 'pnpm' || pm === null ? 'pnpm' : pm === 'yarn' ? 'yarn' : 'npm run';
  if (typeof pkgScripts.check === 'string') out.testCommand = `${runner} check`;
  else if (out.language === 'go') out.testCommand = 'go test ./...';
  else if (out.language === 'rust') out.testCommand = 'cargo test';
  else if (out.language === 'python') out.testCommand = 'pytest';
  else if (typeof pkgScripts.test === 'string') out.testCommand = `${runner} test`;
  if (out.moduleRoots === undefined) out.moduleRoots = [];
  // 补齐 PR 放的合并闸写 merge-gate 这个状态：强制 CI 时等它
  out.mergeSignals = ['merge-gate'];
  out.standardPathsFile = 'packages/conventions/standard-paths.json';
  out.weight = 1;
  return out;
}

// —— 法国那头 ——

interface ShownRepo {
  repo: string;
  ciPolicy: 'force' | 'off';
  ciPolicyBridge: PolicyBridgeDescriptor | null;
  githubId: number | null;
  testCommand: string;
  autoDispatchSince: string | null;
  profile: Record<string, unknown>;
  gaps: string[];
  error?: string;
}

/** fleet-api project show：库里没有这个仓回 null；法国读不成、版本太老抛 Unchecked。 */
async function show(ctx: ProjectContext, slug: string): Promise<ShownRepo | null> {
  const r = await ctx.world.fleetApi(['project', 'show', slug]);
  if (r.code === 0) {
    try {
      const raw: unknown = JSON.parse(r.stdout);
      if (
        !policyRecord(raw) ||
        typeof raw.repo !== 'string' ||
        raw.repo.toLowerCase() !== slug.toLowerCase() ||
        !(raw.githubId === null || policyId(raw.githubId)) ||
        (raw.ciPolicy !== 'force' && raw.ciPolicy !== 'off') ||
        typeof raw.testCommand !== 'string' ||
        !policyRecord(raw.profile) ||
        !Array.isArray(raw.gaps) ||
        raw.gaps.some((x) => typeof x !== 'string') ||
        !(raw.autoDispatchSince === null || typeof raw.autoDispatchSince === 'string')
      )
        throw new Unchecked('project show 的仓身份、ciPolicy 或字段不完整');
      return raw as unknown as ShownRepo;
    } catch {
      throw new Unchecked('fleet-api project show 回的 JSON/仓身份/ciPolicy 不完整，未查成');
    }
  }
  if (r.code === 1 && r.stderr.includes('库里没有仓')) return null;
  if (r.code === 2 && /认不出|用法/.test(r.stderr) && !r.stderr.includes('project'))
    throw new Unchecked('法国的版本还没有 fleet-api project 命令（#2738、#2749 发版后才有）');
  throw new Unchecked(
    `在法国跑 fleet-api project show 没成（退出码 ${r.code}）：${(r.stderr || r.stdout).trim()}`,
  );
}

async function fleetApiOrThrow(ctx: ProjectContext, args: string[], stdin?: string): Promise<string> {
  const r = await ctx.world.fleetApi(args, stdin);
  if (r.code !== 0)
    throw new Error(
      `fleet-api ${args.slice(0, 2).join(' ')} 没成（退出码 ${r.code}）：${(r.stderr || r.stdout).trim()}`,
    );
  return r.stdout;
}

// —— 八步里的六个「查」（check 只跑这六个） ——

async function probeRegister(ctx: ProjectContext, slug: string, facts: RepoFacts): Promise<Probe> {
  const shown = await show(ctx, slug);
  if (shown && shown.githubId === facts.id) return { ok: true, detail: `已登记，仓号 ${facts.id}` };
  const why = shown
    ? shown.githubId === null
      ? '库里有这一行，但没有仓号'
      : `库里的仓号 ${shown.githubId} 和 GitHub 上的 ${facts.id} 对不上（要人核对）`
    : '库里还没有这个仓';
  if (shown && shown.githubId !== null) return { ok: false, why };
  return {
    ok: false,
    why,
    fix: async () => {
      await fleetApiOrThrow(ctx, [
        'project',
        'register',
        slug,
        '--github-id',
        String(facts.id),
        '--default-branch',
        facts.defaultBranch,
      ]);
    },
  };
}

/** 第二步读装没装的标准来源（#2977）：法国 fleet-api 的只读命令，不是本机 gh。 */
export const INSTALLATIONS_COMMAND = 'fleet-api project installations';

/** fleet-api project installations 打的那一份里，这一步要用的几样。 */
export interface AppInstallFacts {
  source: string;
  readAt: string;
  agentInstalled: boolean;
  engineInstalled: boolean;
}

/**
 * 认 fleet-api project installations 回的 JSON：每个字段都要在、类型对、仓名仓号对得上、reason 是 null。
 * 有一样不对就抛 Unchecked（写清来源和原因），不当成空、false 或装了。
 */
export function parseInstallFacts(stdout: string, slug: string, githubId: number): AppInstallFacts {
  const fail = (why: string) => new Unchecked(`没查成（来源 ${INSTALLATIONS_COMMAND}）：${why}`);
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw fail(`回的不是 JSON：${stdout.trim().slice(0, 200)}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw fail('回的不是一个 JSON 对象');
  const r = raw as Record<string, unknown>;
  if (!('reason' in r)) throw fail('缺 reason');
  if (r.reason !== null)
    throw fail(`服务说没读全：${typeof r.reason === 'string' ? r.reason : JSON.stringify(r.reason)}`);
  if (typeof r.source !== 'string' || !r.source) throw fail('source 缺了或不是字符串');
  if (typeof r.readAt !== 'string' || Number.isNaN(Date.parse(r.readAt))) throw fail('readAt 缺了或不是时刻');
  if (typeof r.repo !== 'string' || r.repo.toLowerCase() !== slug.toLowerCase())
    throw fail(`回的仓是 ${JSON.stringify(r.repo)}，不是 ${slug}（身份对不上）`);
  if (r.githubId !== githubId)
    throw fail(`回的仓号是 ${JSON.stringify(r.githubId)}，不是 ${githubId}（身份对不上）`);
  for (const k of ['agentInstalled', 'engineInstalled', 'fullyInstalled'] as const)
    if (typeof r[k] !== 'boolean') throw fail(`${k} 缺了或不是 true/false`);
  if (r.fullyInstalled !== (r.agentInstalled === true && r.engineInstalled === true))
    throw fail('fullyInstalled 和两个角色对不上');
  return {
    source: r.source,
    readAt: r.readAt,
    agentInstalled: r.agentInstalled === true,
    engineInstalled: r.engineInstalled === true,
  };
}

/** 经法国读两个 App 装没装到这个仓（只读）。读不成、回的认不出都抛 Unchecked，不退回本机 gh。 */
async function readInstallFacts(
  ctx: ProjectContext,
  slug: string,
  facts: RepoFacts,
): Promise<AppInstallFacts> {
  const r = await ctx.world.fleetApi(['project', 'installations', slug, '--github-id', String(facts.id)]);
  if (r.code === 0) return parseInstallFacts(r.stdout, slug, facts.id);
  const said = (r.stderr || r.stdout).trim();
  // 老版本的 fleet-api 回「认不出「installations」：只收 show、set-profile、register」
  if (r.code === 2 && said.includes('认不出「installations」'))
    throw new Unchecked(
      `没查成（来源 ${INSTALLATIONS_COMMAND}）：法国的版本还没有这个命令（#2977 发版后才有）：${said}`,
    );
  throw new Unchecked(`没查成（来源 ${INSTALLATIONS_COMMAND}，退出码 ${r.code}）：${said || '没有输出'}`);
}

async function probeApps(ctx: ProjectContext, slug: string, facts: RepoFacts): Promise<Probe> {
  const read = await readInstallFacts(ctx, slug, facts);
  const from = `来源 ${read.source}，读于 ${read.readAt}`;
  const installed = { agent: read.agentInstalled, engine: read.engineInstalled };
  // 读全了、明确不含这个仓的角色才算没装
  const missing: { role: string; inst: number }[] = [];
  const notInstalled: string[] = [];
  for (const role of ['agent', 'engine'] as const) {
    if (installed[role]) continue;
    const app = ctx.apps.apps[role];
    const inst = app.installations[facts.owner.toLowerCase()] ?? app.installations[facts.owner];
    if (inst === undefined) {
      notInstalled.push(
        `${app.slug} 还没装到 ${facts.owner}：这个账号或组织要先在网页装一次（https://github.com/apps/${app.slug}/installations/new），再把安装号记进 packages/conventions/github-apps.json`,
      );
      continue;
    }
    missing.push({ role: app.slug, inst });
  }
  if (notInstalled.length > 0) return { ok: false, why: `${notInstalled.join('；')}（${from}）` };
  if (missing.length === 0) return { ok: true, detail: `两个 App 都装到了这个仓（${from}）` };
  return {
    ok: false,
    why: `${missing.map((m) => m.role).join('、')} 还没装到这个仓（${from}）`,
    fix: async () => {
      for (const m of missing) await ctx.world.addToInstallation(m.inst, facts.id);
    },
  };
}

async function probeLabels(ctx: ProjectContext, slug: string): Promise<Probe> {
  const want = await ctx.world.labels(ctx.standardRepo);
  if (want.length === 0) throw new Unchecked(`标准仓 ${ctx.standardRepo} 一个标签都没读到`);
  const have = new Map((await ctx.world.labels(slug)).map((l) => [l.name, l]));
  const create = want.filter((l) => !have.has(l.name));
  const edit = want.filter((l) => {
    const h = have.get(l.name);
    return (
      h !== undefined && (h.color.toLowerCase() !== l.color.toLowerCase() || h.description !== l.description)
    );
  });
  if (create.length === 0 && edit.length === 0)
    return { ok: true, detail: `${want.length} 个流程标签都在、颜色说明一致` };
  const parts = [
    create.length > 0 ? `缺 ${create.map((l) => l.name).join('、')}` : '',
    edit.length > 0 ? `颜色或说明不一样：${edit.map((l) => l.name).join('、')}` : '',
  ].filter(Boolean);
  return {
    ok: false,
    why: parts.join('；'),
    fix: async () => {
      for (const l of create) await ctx.world.createLabel(slug, l);
      for (const l of edit) await ctx.world.editLabel(slug, l);
    },
  };
}

async function probeProfile(ctx: ProjectContext, slug: string, facts: RepoFacts): Promise<Probe> {
  const shown = await show(ctx, slug);
  if (!shown) return { ok: false, why: '库里还没有这个仓（先登记）' };
  if (shown.error) return { ok: false, why: `库里的档案形状不对：${shown.error}（要人看）` };
  if (shown.gaps.length === 0) return { ok: true, detail: '档案每项都写了' };
  return {
    ok: false,
    why: `档案缺 ${shown.gaps.join('、')}`,
    fix: async () => {
      const detected = await detectProfile(ctx.world, slug, facts.defaultBranch);
      // 已经写了的项不动，只补缺的
      const merged = { ...detected, ...shown.profile };
      await fleetApiOrThrow(ctx, ['project', 'set-profile', slug, '--file', '-'], JSON.stringify(merged));
    },
  };
}

function fillFiles(
  ctx: ProjectContext,
  slug: string,
  testCommand: string,
): { path: string; text: string; want: (t: string) => boolean }[] {
  const uses = (wf: string) => (t: string) =>
    t.includes(`uses: ${ctx.standardRepo}/.github/workflows/${wf}@`);
  return [
    { path: REQUIRED_FILES.agents, text: agentsMd(slug, ctx.standardRepo, testCommand), want: () => true },
    {
      path: REQUIRED_FILES.issueTemplate,
      text: issueTemplate(),
      want: (t) => ISSUE_SECTIONS.every((s) => t.includes(`## ${s}`)),
    },
    {
      path: REQUIRED_FILES.mergeGate,
      text: mergeGateCaller(ctx.standardRepo),
      // 只认我们生成的固定 caller，不用 includes 或自制 YAML 扫描猜实际输入语义。
      want: (t) => t.replaceAll('\r\n', '\n').trim() === mergeGateCaller(ctx.standardRepo).trim(),
    },
    {
      path: REQUIRED_FILES.closeOnMerge,
      text: closeOnMergeCaller(ctx.standardRepo),
      want: uses('close-on-merge.yml'),
    },
  ];
}

async function probeFill(
  ctx: ProjectContext,
  slug: string,
  facts: RepoFacts,
  testCommand: string,
): Promise<Probe> {
  const lacking: { path: string; text: string }[] = [];
  for (const f of fillFiles(ctx, slug, testCommand)) {
    const text = await ctx.world.fileText(slug, facts.defaultBranch, f.path);
    if (text === null || !f.want(text)) lacking.push({ path: f.path, text: f.text });
  }
  if (lacking.length === 0)
    return { ok: true, detail: 'AGENTS.md、四节单模板、合并闸和关单工作流都在默认分支上' };
  const why = `默认分支上缺：${lacking.map((f) => f.path).join('、')}`;
  const open = await ctx.world.openPrFrom(slug, FILL_BRANCH);
  if (open) return { ok: false, why: `${why}；补齐 PR #${open.number} 待合（${open.url}），合了再跑一遍` };
  return {
    ok: false,
    why,
    fix: async () => {
      const pr = await ctx.world.openFillPr(slug, {
        base: facts.defaultBranch,
        head: FILL_BRANCH,
        files: lacking,
        title: '补齐 fleet-dao 标准：AGENTS.md、四节单模板、合并闸和关单工作流',
        body: `pnpm project add 开的补齐 PR（design 15.7 第 9 条）：${lacking.map((f) => `\`${f.path}\``).join('、')}。工作流引用 ${ctx.standardRepo} 的可复用工作流，判法不往本仓抄。`,
      });
      ctx.out(`  开了补齐 PR #${pr.number}：${pr.url}`);
    },
  };
}

async function probePolicyBridge(ctx: ProjectContext, slug: string, facts: RepoFacts): Promise<Probe> {
  const shown = await show(ctx, slug);
  if (!shown || shown.githubId !== facts.id) throw new Unchecked('策略桥的 DB/GitHub 仓身份未对齐');
  const descriptor = shown.ciPolicyBridge;
  if (
    !policyRecord(descriptor) ||
    descriptor.version !== 1 ||
    typeof descriptor.public !== 'boolean' ||
    typeof descriptor.publisher !== 'boolean'
  )
    throw new Unchecked('真实策略桥 descriptor 未装配或版本不支持');
  if (!descriptor.publisher) return { ok: false, why: '真实 source publisher 未装配' };
  if (!descriptor.public && descriptor.endpoint !== null)
    throw new Unchecked('私有仓 descriptor 不能公开策略 URL');
  if (!descriptor.public)
    return shown.ciPolicy === 'force'
      ? { ok: true, detail: '私有仓保持 force；未公开策略，off 暂不支持' }
      : { ok: false, why: '私有仓 off 尚无可信认证读桥，不支持完整准入' };
  try {
    parsePolicyUrl(descriptor.endpoint, facts.id);
  } catch {
    throw new Unchecked('策略桥 descriptor URL 不符合固定 HTTPS 协议');
  }
  const workflow = await ctx.world.fileText(ctx.standardRepo, 'main', '.github/workflows/merge-gate.yml');
  if (!workflow?.includes('# fleet-ci-policy-bridge: v1'))
    return { ok: false, why: '标准 reusable 合并闸尚不支持真实策略读桥协议' };
  const read = await ctx.world.policyBridge(slug, facts.id, descriptor);
  if (read.ciPolicy !== shown.ciPolicy) return { ok: false, why: '真实 HTTPS 桥与 DB 当前 ciPolicy 不一致' };
  if (read.missing > 0)
    return {
      ok: false,
      why: `${read.missing} 个当前头缺可信 source`,
      fix: async () => {
        await fleetApiOrThrow(ctx, ['project', 'refresh-policy-source', slug]);
      },
    };
  return {
    ok: true,
    detail: `HTTPS 真实 DB ${read.ciPolicy} 已核；${read.heads === 0 ? '无 open PR，尚未验证真实事件全链' : `${read.heads} 个当前头 source 已核，未冒称最终 gate 已通过`}`,
  };
}

// —— 跑法 ——

async function runStep(
  _ctx: ProjectContext,
  step: string,
  probe: () => Promise<Probe>,
  mode: 'check' | 'add',
): Promise<StepResult> {
  let first: Probe;
  try {
    first = await probe();
  } catch (err) {
    return { step, status: 'unchecked', detail: err instanceof Error ? err.message : String(err) };
  }
  if (first.ok) return { step, status: 'ok', detail: first.detail };
  if (mode === 'check' || !first.fix) return { step, status: 'red', detail: first.why };
  try {
    await first.fix();
    const again = await probe();
    return again.ok
      ? { step, status: 'fixed', detail: `${first.why} → 补好了：${again.detail}` }
      : { step, status: 'red', detail: `${first.why} → 补了，再查还差：${again.why}` };
  } catch (err) {
    return {
      step,
      status: 'red',
      detail: `${first.why}；补的时候出错：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function print(ctx: ProjectContext, r: StepResult) {
  const mark = { ok: '✓', fixed: '✓（补了）', red: '✗', unchecked: '？没查成' }[r.status];
  ctx.out(`${mark} ${r.step}：${r.detail}`);
}

/** 退出码：全绿 0；有不过的 1；有没查成的 2。 */
export function exitCodeOf(results: readonly StepResult[]): number {
  if (results.some((r) => r.status === 'unchecked')) return 2;
  return results.some((r) => r.status === 'red') ? 1 : 0;
}

async function facts(ctx: ProjectContext, slug: string): Promise<RepoFacts | StepResult> {
  try {
    const f = await ctx.world.repo(slug);
    if (f.archived) return { step: 'GitHub 上的仓', status: 'red', detail: `${slug} 已归档，不接` };
    return f;
  } catch (err) {
    return {
      step: 'GitHub 上的仓',
      status: 'unchecked',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 测试命令：档案里写了用档案的，没写按探测的（AGENTS.md 里写给人看）。 */
async function testCommandOf(ctx: ProjectContext, slug: string, f: RepoFacts): Promise<string> {
  try {
    const shown = await show(ctx, slug);
    const fromProfile = shown?.profile.testCommand;
    if (typeof fromProfile === 'string') return fromProfile;
  } catch {
    // 法国读不成：下面按探测的
  }
  const detected = await detectProfile(ctx.world, slug, f.defaultBranch);
  return typeof detected.testCommand === 'string' ? detected.testCommand : 'pnpm check';
}

async function steps(
  ctx: ProjectContext,
  slug: string,
  f: RepoFacts,
  mode: 'check' | 'add',
): Promise<StepResult[]> {
  const out: StepResult[] = [];
  const run = async (step: string, probe: () => Promise<Probe>) => {
    const r = await runStep(ctx, step, probe, mode);
    print(ctx, r);
    out.push(r);
    return r;
  };
  const registered = await run('1 登记仓', () => probeRegister(ctx, slug, f));
  await run('2 装两个 App', () => probeApps(ctx, slug, f));
  await run('3 流程标签', () => probeLabels(ctx, slug));
  if (registered.status === 'unchecked' || (mode === 'add' && registered.status === 'red'))
    out.push({ step: '4 仓档案', status: registered.status, detail: '登记没成，档案这一步没跑' });
  else await run('4 仓档案', () => probeProfile(ctx, slug, f));
  const testCommand = await testCommandOf(ctx, slug, f).catch(() => 'pnpm check');
  await run('5 补齐 PR', () => probeFill(ctx, slug, f, testCommand));
  await run('6 策略读桥', () => probePolicyBridge(ctx, slug, f));
  return out;
}

/** pnpm project check：只读，六项各查一遍。 */
export async function projectCheck(
  ctx: ProjectContext,
  slug: string,
): Promise<{ code: number; results: StepResult[] }> {
  const f = await facts(ctx, slug);
  if ('step' in f) {
    print(ctx, f);
    return { code: exitCodeOf([f]), results: [f] };
  }
  const results = await steps(ctx, slug, f, 'check');
  const code = exitCodeOf(results);
  ctx.out(code === 0 ? `${slug} 全绿` : code === 1 ? `${slug} 有没过的项` : `${slug} 有没查成的项`);
  return { code, results };
}

function textOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function issueNumberOk(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

/** 按单号直接读，核对就是这张冒烟单。读不成、读到空、对不上都不当成没有。 */
async function readSmokeFact(
  ctx: ProjectContext,
  slug: string,
  number: number,
): Promise<{ ok: true; fact: IssueFact } | { ok: false; status: 'red' | 'unchecked'; detail: string }> {
  let fact: IssueFact | null;
  try {
    fact = await ctx.world.readIssue(slug, number);
  } catch (err) {
    return { ok: false, status: 'unchecked', detail: `#${number} 直接读没成：${textOf(err)}` };
  }
  if (!fact) {
    return {
      ok: false,
      status: 'unchecked',
      detail: `#${number} 直接读没有这张单（没读到，不能当成没开成）`,
    };
  }
  if (fact.number !== number || fact.title !== SMOKE_TITLE) {
    return {
      ok: false,
      status: 'red',
      detail: `直接读到的 #${fact.number}「${fact.title}」和冒烟单 #${number} 对不上`,
    };
  }
  return { ok: true, fact };
}

/**
 * 第八步不走 runStep 的「补完用同一条探测再查」。
 * 那条若是按标题搜索，索引还没跟上会把刚开成的单说成还没开，重跑还可能再开一张（#2995）。
 * 有没有：直接列单，读全了才算没有。刚开的：只信 createIssue 回的单号，再按这个号直接读。
 * 空的搜索不算失败，也不算成功；列单或直读失败不再补开。
 */
async function smokeIssueStep(ctx: ProjectContext, slug: string): Promise<StepResult> {
  const step = '8 冒烟单';
  let listed: IssueFact | null;
  try {
    listed = await ctx.world.listIssueByTitle(slug, SMOKE_TITLE);
  } catch (err) {
    return { step, status: 'unchecked', detail: `没查成：${textOf(err)}` };
  }
  if (listed) {
    if (!issueNumberOk(listed.number) || listed.title !== SMOKE_TITLE) {
      return {
        step,
        status: 'unchecked',
        detail: `直接列单回的 #${String(listed.number)}「${listed.title}」认不出，不能当成没开成`,
      };
    }
    const got = await readSmokeFact(ctx, slug, listed.number);
    if (!got.ok) return { step, status: got.status, detail: got.detail };
    return { step, status: 'ok', detail: `#${got.fact.number}（${got.fact.state}）` };
  }

  let created: number;
  try {
    created = await ctx.world.createIssue(slug, {
      title: SMOKE_TITLE,
      body: smokeIssueBody(slug),
      labels: SMOKE_LABELS,
    });
  } catch (err) {
    return { step, status: 'unchecked', detail: `创建结果不明：${textOf(err)}` };
  }
  if (!issueNumberOk(created)) {
    return { step, status: 'unchecked', detail: `创建结果不明：回执单号 ${String(created)} 不可信` };
  }
  const got = await readSmokeFact(ctx, slug, created);
  if (!got.ok) return { step, status: got.status, detail: got.detail };
  return { step, status: 'fixed', detail: `还没开 → 补好了：#${got.fact.number}（${got.fact.state}）` };
}

/** pnpm project add：八步，每步先查、再补、再核；可重复跑。 */
export async function projectAdd(
  ctx: ProjectContext,
  slug: string,
): Promise<{ code: number; results: StepResult[] }> {
  const f = await facts(ctx, slug);
  if ('step' in f) {
    print(ctx, f);
    return { code: exitCodeOf([f]), results: [f] };
  }
  const results = await steps(ctx, slug, f, 'add');

  // 7：重新跑一遍只读的 check，全绿才打开接活
  ctx.out('—— 7 跑 project check ——');
  const check = await projectCheck(ctx, slug);
  if (check.code !== 0) {
    const r: StepResult = {
      step: '7 打开让 AI 接活',
      status: check.code === 2 ? 'unchecked' : 'red',
      detail: `check 没全绿，接活不开：${check.results
        .filter((x) => x.status !== 'ok')
        .map((x) => x.step)
        .join('、')}`,
    };
    print(ctx, r);
    return { code: exitCodeOf([...results, r]), results: [...results, r] };
  }
  const dispatch = await runStep(
    ctx,
    '7 打开让 AI 接活',
    async () => {
      const shown = await show(ctx, slug);
      if (shown?.autoDispatchSince) return { ok: true, detail: `开着，自 ${shown.autoDispatchSince} 起` };
      return {
        ok: false,
        why: '关着',
        fix: async () => {
          await fleetApiOrThrow(ctx, ['dispatch', slug, 'on']);
        },
      };
    },
    'add',
  );
  print(ctx, dispatch);
  results.push(dispatch);
  if (dispatch.status !== 'ok' && dispatch.status !== 'fixed') return { code: exitCodeOf(results), results };

  // 7：冒烟单。不把搜索的空当成没有，也不在补完后再搜一次标题。
  const smoke = await smokeIssueStep(ctx, slug);
  print(ctx, smoke);
  results.push(smoke);
  return { code: exitCodeOf(results), results };
}
