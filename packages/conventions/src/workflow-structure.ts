// 工作流（ci.yml）的结构化比对：合并闸用它判「这次改动碰没碰信任」，替掉原来按行匹配的写法（#701）。
// 原来的做法是在改动的行上套一串正则：每轮第二意见都能想出一种没覆盖的写法（键名加引号、往 GITHUB_OUTPUT 写东西……），
// 没有终点。这里改成把改动前后的文件各解析一遍，只比几样固定的东西；同样的输入永远是同样的结论。
//
// 改这里之前必须知道：
// - 比的是「信任相关的结构」，不是文字：权限、触发、并发、顶层和 job 的环境、job 的增删、每个 job 的 needs / if / runs-on /
//   权限 / 环境 / 容器 / 服务、每一步用到的 action 和它的整个 with（检出的 ref/path、缓存的 key/path）、if / continue-on-error /
//   shell / working-directory、
//   「汇总」那些步骤的整段脚本、每个 job 里跑检查的命令还在不在、几个危险词出现的次数有没有变多。
//   矩阵（strategy.matrix：跑哪几台、各测什么）也比。步骤顺序、超时、名字、fail-fast/max-parallel、注释、某一步里
//   别的命令怎么写，都不比——这些是提速改动的常态（分台怎么分在 ci-plan.ts / test-split.ts 里改，那边先合后审）。
// - 比不了（读不懂、不是对象）一律算「碰了」，由调用方要第二意见；不许当成「没变」。
// - 加比对项要配一条故意造出失败的测试（改了它必须被抓到）；删比对项等于放松合并闸，走先审后合。

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 键排好序再转 JSON：两边内容一样、只是键的顺序不同，不算变了。 */
function canon(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (isObj(x))
      return Object.fromEntries(
        Object.keys(x)
          .sort()
          .map((k) => [k, sort(x[k])]),
      );
    return x;
  };
  return JSON.stringify(sort(v)) ?? 'undefined';
}

const TOP_KEYS = ['on', 'permissions', 'concurrency', 'env', 'defaults'] as const;
const JOB_KEYS = [
  'needs',
  'if',
  'runs-on',
  'permissions',
  'environment',
  'container',
  'services',
  'continue-on-error',
  'uses',
  'secrets',
  'defaults',
  'env',
  'outputs',
] as const;
const STEP_KEYS = ['uses', 'if', 'continue-on-error', 'shell', 'working-directory'] as const;

/**
 * 跑检查的命令：一个 job 里原来有、现在没有了，就说明有一步检查被换掉、搬走、删掉了。
 * 反过来列「哪些算检查」的名单总有漏的，所以只在这里列「看得见的检查命令」，名单外的靠别的比对项兜（job 增删、needs、if……）。
 */
const CHECK_TOKENS = [
  'vitest',
  'biome',
  'tsc',
  'run.sh',
  'build:demo',
  'ci-verdict',
  'ci-plan',
  'ci-cache',
  'ci-box',
  'main-base',
  'doc-pointers',
  'ci-history',
  'check.ts',
];

/** 这些词在整份文件里出现的次数变多，就算碰了：往步骤输出、环境、PATH 里写东西能改后面步骤读到的东西，其余是令牌和密钥。 */
const WATCH_WORDS = [
  'GITHUB_OUTPUT',
  'GITHUB_ENV',
  'GITHUB_PATH',
  'GITHUB_STATE',
  'secrets.',
  'GITHUB_TOKEN',
  'github.token',
  'persist-credentials',
  // 吞掉失败的写法：检查命令还在、但红了也当绿（pnpm exec vitest run || true）
  '|| true',
  '|| :',
  'exit 0',
  'set +e',
];

const count = (text: string, word: string) => text.split(word).length - 1;

/** 汇总判红的步骤：整段脚本都得比（job check 里所有步骤、名字以「汇总」开头的步骤）。 */
function verdictScripts(jobs: Obj): string[] {
  const out: string[] = [];
  for (const [name, job] of Object.entries(jobs)) {
    if (!isObj(job) || !Array.isArray(job.steps)) continue;
    for (const [i, step] of job.steps.entries()) {
      if (!isObj(step)) continue;
      const isSummary = typeof step.name === 'string' && step.name.startsWith('汇总');
      if (name === 'check' || isSummary)
        out.push(`${name}#${i}:${canon(step.run ?? null)}:${canon(step.env ?? null)}`);
    }
  }
  return out.sort();
}

const stepSig = (s: unknown): string => {
  if (!isObj(s)) return canon(s);
  const pick: Obj = {};
  for (const k of STEP_KEYS) if (k in s) pick[k] = s[k];
  // 用到 action 的步骤：整个 with 都比（检出的 ref/path/sparse-checkout 决定跑的是主线的代码还是 PR 的，缓存的 key/path
  // 决定跳过什么）；没用 action 的步骤 with 没意义，只看检出那一项以防写错地方
  if (typeof s.uses === 'string') pick.with = s.with ?? null;
  else {
    const w = isObj(s.with) ? s.with['persist-credentials'] : undefined;
    if (w !== undefined) pick['persist-credentials'] = w;
  }
  return canon(pick);
};

const runText = (job: Obj): string =>
  (Array.isArray(job.steps) ? job.steps : [])
    .map((s) => (isObj(s) ? `${String(s.run ?? '')}\n${canon(s.with ?? null)}\n${canon(s.env ?? null)}` : ''))
    .join('\n');

type Parse = (text: string) => unknown;

function read(parse: Parse, text: string, which: string): { doc: Obj; jobs: Obj } | string {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return `${which}的工作流读不懂（${e instanceof Error ? e.message.split('\n')[0] : String(e)}）`;
  }
  if (!isObj(doc)) return `${which}的工作流顶层不是键值对`;
  const jobs = doc.jobs;
  if (!isObj(jobs)) return `${which}的工作流没有 jobs`;
  return { doc, jobs };
}

/**
 * 比改动前后的工作流：回碰到信任的地方（一句话一条，空 = 都不碰）；读不懂回一句话（调用方当「碰了」）。
 * 两边文字完全一样直接回空，不用解析。
 */
export async function workflowDiff(before: string, after: string): Promise<string[] | string> {
  if (before === after) return [];
  // 按需加载：合并闸的工作流只为它装依赖；装坏了只让改 ci.yml 的 PR 判「读不懂」（= 要审），别的 PR 不受影响
  let parse: Parse;
  try {
    parse = (await import('yaml')).parse;
  } catch (e) {
    return `解析 YAML 的库加载不了（${e instanceof Error ? e.message.split('\n')[0] : String(e)}），没法比对`;
  }
  const b = read(parse, before, '改动前');
  if (typeof b === 'string') return b;
  const a = read(parse, after, '改动后');
  if (typeof a === 'string') return a;
  const out: string[] = [];

  for (const k of TOP_KEYS) {
    if (canon(b.doc[k]) !== canon(a.doc[k])) out.push(`顶层 ${k} 变了`);
  }
  const bNames = Object.keys(b.jobs);
  const aNames = Object.keys(a.jobs);
  for (const n of aNames) if (!bNames.includes(n)) out.push(`新增 job：${n}`);
  for (const n of bNames) if (!aNames.includes(n)) out.push(`删了 job：${n}`);

  for (const n of aNames.filter((x) => bNames.includes(x))) {
    const jb = b.jobs[n];
    const ja = a.jobs[n];
    if (!isObj(jb) || !isObj(ja)) {
      if (canon(jb) !== canon(ja)) out.push(`job ${n} 的写法变了`);
      continue;
    }
    for (const k of JOB_KEYS) {
      if (canon(jb[k]) !== canon(ja[k])) out.push(`job ${n} 的 ${k} 变了`);
    }
    // 矩阵决定这个 job 跑哪几台、各测什么（现在由 changes 算好经 fromJSON 交进来，分台的改动在 ci-plan.ts / test-split.ts
    // 里做，不在这里）：矩阵写法变了就算碰了；fail-fast、max-parallel 只影响快慢，不比
    const matrix = (j: Obj) => (isObj(j.strategy) ? j.strategy.matrix : undefined);
    if (canon(matrix(jb)) !== canon(matrix(ja))) out.push(`job ${n} 的矩阵（strategy.matrix）变了`);
    // 「路标」步骤按顺序比：带信任相关键的（action、if、continue-on-error……）、装依赖的（跑 PR 的安装脚本）、跑检查的。
    // 顺序也算：卫生检查挪到装依赖之后，PR 的安装脚本就能先改掉它（#115）。只有 run 的普通步骤（加一步、删一步）不算路标
    const landmarks = (steps: unknown) =>
      (Array.isArray(steps) ? steps : []).flatMap((s) => {
        const sig = stepSig(s);
        if (sig !== '{}') return [`信任:${sig}`];
        const run = isObj(s) && typeof s.run === 'string' ? s.run : '';
        // 装依赖那步整条命令都算（接一句 curl 就是跑别的东西了）
        if (/\binstall\b/.test(run)) return [`装依赖:${canon(run)}`];
        if (CHECK_TOKENS.some((t) => run.includes(t)))
          return [`检查:${canon({ run, env: isObj(s) ? (s.env ?? null) : null })}`];
        return [];
      });
    if (canon(landmarks(jb.steps)) !== canon(landmarks(ja.steps)))
      out.push(
        `job ${n} 里步骤用到的 action、if、continue-on-error、shell、检出方式，或它们和装依赖、跑检查的先后变了`,
      );
    // 跑检查的那几步（run 里带检查命令的）：改动后必须还有一步 run、env 一字不差的。只看「词还在不在」挡不住
    // 「echo vitest」「vitest run || true」这类，比整步就一类全收；代价是改检查命令行本身（加个参数）也要审，那本来就该审
    const checkSteps = (j: Obj) =>
      (Array.isArray(j.steps) ? j.steps : [])
        .filter(
          (s): s is Obj =>
            isObj(s) && typeof s.run === 'string' && CHECK_TOKENS.some((t) => String(s.run).includes(t)),
        )
        .map((s) => canon({ run: s.run, env: s.env ?? null }));
    const keptAfter = new Set(checkSteps(ja));
    const changedChecks = checkSteps(jb).filter((sig) => !keptAfter.has(sig));
    if (changedChecks.length > 0) {
      const tb = runText(jb);
      const ta = runText(ja);
      const gone = CHECK_TOKENS.filter((t) => tb.includes(t) && !ta.includes(t));
      out.push(
        gone.length > 0
          ? `job ${n} 里的检查命令「${gone.join('、')}」不见了`
          : `job ${n} 里跑检查的步骤改了（${changedChecks.length} 步的命令或环境不再一字不差）`,
      );
    }
  }
  if (canon(verdictScripts(b.jobs)) !== canon(verdictScripts(a.jobs)))
    out.push('汇总判红的脚本变了（check 或「汇总」步骤）');

  const tb = JSON.stringify(b.doc);
  const ta = JSON.stringify(a.doc);
  for (const w of WATCH_WORDS) {
    if (count(ta, w) > count(tb, w)) out.push(`「${w}」出现的次数变多了`);
  }
  return out;
}
