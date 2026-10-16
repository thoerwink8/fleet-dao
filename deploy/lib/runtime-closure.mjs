// 这一版要不要重启某个服务（#2797）：按文件级的引用闭包判，不再按路径白名单。
// 从服务的入口（引擎 packages/engine/src/main.ts、后端 packages/api/src/main.ts）出发，用 TypeScript 自己的模块解析
// （tsc --listFilesOnly：和 tsc 同一套 resolveModuleName，不用正则）走静态引用，得到服务运行要读的文件；再用 TypeScript 的
// 词法扫描器（不是正则：注释、字符串里的字不算）补上按路径读的：`new URL('…', import.meta.url)`（引擎经它起 Temporal 的
// workflows、给会话挂 agents/hooks/pretool.mjs、读 deploy/quota.json）、`createRequire(…).resolve('@fleet-dao/…')`
// （Mirasim 的桥接脚本），补进来的代码文件再当入口走一遍，直到不再多出文件。拼出来的 `import(…)`（参数不是一个字符串）
// 认不出走到哪：那个文件所在的整个包都算进去。
// 新旧两版各算一次取并集（删掉一个被引用的文件也算碰到）；改动和并集没有交集、也没碰非代码的运行输入（NON_CODE），
// 就不用重启。读不出、算不出一律当成要重启（宁多重启、不漏重启）。
//
// 用法（deploy/release.sh 和自动发布 deploy/france/auto-release 调同一份）：
//   node deploy/lib/runtime-closure.mjs --git <仓> --old <在用提交> --new <要发的提交> --service engine|api
// 退出码：0 不用重启；10 要重启（碰到了）；2 判不了（调用方当要重启）。标准输出一行原因。
//
// 改这里之前必须知道：
// - 依赖的是这一版 node_modules 里的 typescript（7.x 原生版没有 preProcessFile / resolveModuleName 的 JS 接口，所以走 tsc
//   --listFilesOnly 拿同一套解析结果，扫描器用它 JS 里带的 unstable/ast/scanner）。法国的发布目录是整套 pnpm install（含开发依赖），有它。
// - 只看仓里的文件：第三方包的变化看 pnpm-lock.yaml（在 NON_CODE 里）。
// - 新旧两版从 git 里取（git archive 到临时目录，工作区包按 package.json 的名字链进临时的 node_modules），不读发布目录：
//   自动发布在构建之前就要判（攒着发，#2797），那时新版还没有目录。
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 每个服务的入口（相对仓根）和它自己的单元文件。 */
export const SERVICES = {
  engine: { entries: ['packages/engine/src/main.ts'], units: ['deploy/france/fleet-engine.service'] },
  api: {
    entries: ['packages/api/src/main.ts'],
    units: ['deploy/france/fleet-api.service', 'deploy/france/fleet-api.socket'],
  },
};

/**
 * 非代码的运行输入：改了就要重启，不看闭包。依赖（根和各包的 package.json、锁文件、工作区配置）、迁移（发版要迁移，
 * 旧进程不能对着新的库结构）、模型目录和路由数据（发版装进库）、本机配置的期望（引擎和后端的环境文件照它写）。
 */
export const NON_CODE = [
  /^package\.json$/,
  /^packages\/[^/]+\/package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^\.npmrc$/,
  /^packages\/db\/migrations\//,
  /^deploy\/catalog\.json$/,
  /^packages\/db\/routing\.default\.json$/,
  /^packages\/db\/quota-reserve\.default\.json$/,
  /^deploy\/france\/desired-config\.json$/,
];

const CODE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
/** git archive 取这几样就够算闭包（服务的代码、会话的钩子、按路径读的数据都在里面）。 */
const ARCHIVE_PATHS = ['package.json', 'packages', 'agents', 'deploy'];
const MAX_ROUNDS = 6;

const posix = (p) => p.split(sep).join('/');

/** 一个文件属于哪个「包」：packages/<名>/、agents/、deploy/ 这一层（认不出的动态 import 把它整个算进去）。 */
export function packageOf(rel) {
  const parts = rel.split('/');
  return parts[0] === 'packages' && parts.length > 2 ? `packages/${parts[1]}/` : `${parts[0]}/`;
}

/**
 * 用 TypeScript 的扫描器找按路径读的引用和认不出的 import(…)。text 是源码，回：
 *   urls：`new URL('字面量', import.meta.url)` 的字面量；resolves：`.resolve('@fleet-dao/…')` 的字面量；dynamic：有拼出来的 import(…)。
 * @param {(skipTrivia: boolean, variant?: number, text?: string) => any} createScanner
 * @param {Record<string, number>} K SyntaxKind
 */
export function scanRefs(createScanner, K, text) {
  const s = createScanner(true, 0, text);
  /** @type {{ k: number, v: string }[]} */
  const toks = [];
  for (let k = s.scan(); k !== K.EndOfFile; k = s.scan()) {
    toks.push({
      k,
      v:
        k === K.StringLiteral || k === K.NoSubstitutionTemplateLiteral || k === K.Identifier
          ? s.getTokenValue()
          : '',
    });
    if (toks.length > 2_000_000) break;
  }
  const str = (t) => t && (t.k === K.StringLiteral || t.k === K.NoSubstitutionTemplateLiteral);
  const urls = [];
  const resolves = [];
  let dynamic = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    // import(…)：前面不是 . （x.import 不算），后面是 (
    if (t.k === K.ImportKeyword && toks[i + 1]?.k === K.OpenParenToken && toks[i - 1]?.k !== K.DotToken) {
      const arg = toks[i + 2];
      const after = toks[i + 3];
      if (!(str(arg) && (after?.k === K.CloseParenToken || after?.k === K.CommaToken))) dynamic = true;
    }
    // new URL('…', import.meta.url)
    if (
      t.k === K.NewKeyword &&
      toks[i + 1]?.k === K.Identifier &&
      toks[i + 1].v === 'URL' &&
      toks[i + 2]?.k === K.OpenParenToken &&
      str(toks[i + 3]) &&
      toks[i + 4]?.k === K.CommaToken &&
      toks[i + 5]?.k === K.ImportKeyword &&
      toks[i + 6]?.k === K.DotToken &&
      toks[i + 7]?.v === 'meta'
    ) {
      urls.push(toks[i + 3].v);
    }
    // xxx.resolve('@fleet-dao/…')（createRequire(import.meta.url).resolve）
    if (
      t.k === K.DotToken &&
      toks[i + 1]?.v === 'resolve' &&
      toks[i + 2]?.k === K.OpenParenToken &&
      str(toks[i + 3]) &&
      toks[i + 3].v.startsWith('@fleet-dao/') &&
      toks[i + 4]?.k === K.CloseParenToken
    ) {
      resolves.push(toks[i + 3].v);
    }
  }
  return { urls, resolves, dynamic };
}

async function loadTs() {
  const req = createRequire(import.meta.url);
  const pkgDir = dirname(req.resolve('typescript/package.json'));
  const scanner = await import(pathToFileURL(join(pkgDir, 'dist/ast/scanner.js')).href);
  const ast = await import(pathToFileURL(join(pkgDir, 'dist/ast/index.js')).href);
  return { tsc: join(pkgDir, 'bin/tsc'), createScanner: scanner.createScanner, K: ast.SyntaxKind };
}

/** 把一棵树里的工作区包按 package.json 的名字链进 <root>/node_modules（git archive 出来的树没有 node_modules）。 */
export function linkWorkspace(root) {
  const nm = join(root, 'node_modules');
  if (existsSync(nm)) return;
  const pk = join(root, 'packages');
  if (!existsSync(pk)) return;
  for (const d of readdirSync(pk)) {
    const f = join(pk, d, 'package.json');
    if (!existsSync(f)) continue;
    let name;
    try {
      name = JSON.parse(readFileSync(f, 'utf8')).name;
    } catch {
      continue;
    }
    if (typeof name !== 'string' || !name) continue;
    const at = join(nm, ...name.split('/'));
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(join(pk, d), at, 'junction');
  }
}

function listFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * 一棵树（仓根 root，有工作区包的 node_modules）里，从 entries 出发服务运行要读的仓内文件（相对仓根，/ 分隔）。
 * 回 { files: Set, prefixes: Set（整个目录算进去的，以 / 结尾） }；tsc 跑不成抛。
 */
export async function closureOf(root, entries, ts = undefined) {
  const t = ts ?? (await loadTs());
  // native：Windows 上把 ADMINI~1 这种短名展开成长名，和 tsc 打出来的真实路径对得上
  const realRoot = realpathSync.native(root);
  const files = new Set();
  const prefixes = new Set();
  const scanned = new Set();
  let todo = entries.filter((e) => existsSync(join(realRoot, e)));
  const allEntries = new Set(todo);
  const work = mkdtempSync(join(tmpdir(), 'fleet-closure-'));
  try {
    for (let round = 0; round < MAX_ROUNDS && todo.length > 0; round++) {
      const cfg = join(work, `tsconfig.${round}.json`);
      writeFileSync(
        cfg,
        JSON.stringify({
          compilerOptions: {
            target: 'ES2023',
            lib: ['ES2023'],
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            allowImportingTsExtensions: true,
            resolveJsonModule: true,
            allowJs: true,
            checkJs: false,
            noEmit: true,
            skipLibCheck: true,
            types: [],
            maxNodeModuleJsDepth: 0,
          },
          files: [...allEntries].map((e) => posix(join(realRoot, e))),
        }),
      );
      const r = spawnSync(process.execPath, [t.tsc, '-p', cfg, '--listFilesOnly'], {
        encoding: 'utf8',
        maxBuffer: 64 << 20,
        timeout: 300_000,
      });
      if (r.error || (r.status !== 0 && r.status !== 2) || !r.stdout.trim()) {
        throw new Error(
          `tsc --listFilesOnly 没跑成（退出码 ${r.status}）：${(r.error?.message ?? r.stderr ?? '').slice(0, 300)}`,
        );
      }
      todo = [];
      for (const line of r.stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let abs;
        try {
          abs = realpathSync.native(resolve(line.trim()));
        } catch {
          continue; // tsc 列了却不在（lib 的虚拟文件）
        }
        const rel = posix(relative(realRoot, abs));
        if (rel.startsWith('..') || rel.includes('node_modules/') || rel.startsWith('/')) continue;
        files.add(rel);
        if (scanned.has(rel) || !CODE.test(rel)) continue;
        scanned.add(rel);
        const refs = scanRefs(t.createScanner, t.K, readFileSync(abs, 'utf8'));
        if (refs.dynamic) prefixes.add(packageOf(rel));
        const base = pathToFileURL(abs);
        for (const u of refs.urls) {
          let target;
          try {
            target = fileURLToPath(new URL(u, base));
          } catch {
            prefixes.add(packageOf(rel));
            continue;
          }
          const trel = posix(relative(realRoot, target));
          if (trel.startsWith('..')) continue;
          if (existsSync(target) && statSync(target).isDirectory()) {
            prefixes.add(trel.endsWith('/') ? trel : `${trel}/`);
            for (const f of listFiles(target)) {
              const frel = posix(relative(realRoot, f));
              if (CODE.test(frel) && !allEntries.has(frel)) {
                allEntries.add(frel);
                todo.push(frel);
              }
            }
          } else {
            files.add(trel);
            if (CODE.test(trel) && existsSync(target) && !allEntries.has(trel)) {
              allEntries.add(trel);
              todo.push(trel);
            }
          }
        }
        for (const spec of refs.resolves) {
          let target;
          try {
            target = realpathSync(createRequire(abs).resolve(spec));
          } catch {
            prefixes.add(packageOf(rel));
            continue;
          }
          const trel = posix(relative(realRoot, target));
          if (trel.startsWith('..')) continue;
          files.add(trel);
          if (CODE.test(trel) && !allEntries.has(trel)) {
            allEntries.add(trel);
            todo.push(trel);
          }
        }
      }
    }
    if (todo.length > 0) throw new Error(`走了 ${MAX_ROUNDS} 轮还在多出入口，算不出`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { files, prefixes };
}

/**
 * 判：改动（相对仓根的路径）碰没碰服务的运行内容。closure 是新旧两版的并集。
 * 回 { restart: boolean, why: string }。
 */
export function judge(changed, closure, service) {
  const units = SERVICES[service].units;
  const nonCode = changed.filter((p) => units.includes(p) || NON_CODE.some((re) => re.test(p)));
  if (nonCode.length > 0)
    return { restart: true, why: `改了非代码的运行输入：${nonCode.slice(0, 3).join('、')}` };
  const hit = changed.filter(
    (p) => closure.files.has(p) || [...closure.prefixes].some((pre) => p.startsWith(pre)),
  );
  if (hit.length > 0) {
    return {
      restart: true,
      why: `改了 ${service === 'engine' ? '引擎' : '后端'}运行要读的文件：${hit.slice(0, 3).join('、')}${hit.length > 3 ? ` 等 ${hit.length} 个` : ''}`,
    };
  }
  return {
    restart: false,
    why: `改的 ${changed.length} 个文件都不在${service === 'engine' ? '引擎' : '后端'}的引用闭包里`,
  };
}

function git(repo, args, opts = {}) {
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding: opts.encoding ?? 'utf8',
    maxBuffer: 256 << 20,
    timeout: 300_000,
    cwd: opts.cwd,
  });
  if (r.error || r.status !== 0)
    throw new Error(
      `git ${args[0]} 没成（退出码 ${r.status}）：${String(r.error?.message ?? r.stderr ?? '').slice(0, 300)}`,
    );
  return r.stdout;
}

/** 把一个提交的 ARCHIVE_PATHS 取到临时目录，链好工作区包。回目录。 */
function checkout(repo, sha, into) {
  mkdirSync(into, { recursive: true });
  const tar = join(into, '.src.tar');
  const present = ARCHIVE_PATHS.filter((p) => {
    const r = spawnSync('git', ['-C', repo, 'cat-file', '-e', `${sha}:${p}`]);
    return r.status === 0;
  });
  git(repo, ['archive', '--format=tar', '-o', tar, sha, ...present]);
  // tar 在临时目录里解（相对路径）：Windows 的 GNU tar 把 D:/… 当成远端主机
  const r = spawnSync('tar', ['-xf', '.src.tar'], { cwd: into, encoding: 'utf8', timeout: 300_000 });
  if (r.error || r.status !== 0)
    throw new Error(`解开 ${sha.slice(0, 12)} 没成：${String(r.error?.message ?? r.stderr).slice(0, 300)}`);
  rmSync(tar, { force: true });
  linkWorkspace(into);
  return into;
}

/** 整套：git 里两个提交，判某个服务要不要重启。回 { restart, why }；算不出抛。 */
export async function decide({ repo, oldSha, newSha, service }) {
  if (!SERVICES[service])
    throw new Error(`认不出服务 ${service}（只认 ${Object.keys(SERVICES).join('、')}）`);
  if (!oldSha || oldSha === newSha)
    return { restart: true, why: oldSha ? '和在用是同一个提交' : '还没有在用的版本' };
  const changed = git(repo, ['diff', '--name-only', '--no-renames', oldSha, newSha])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (changed.length === 0) return { restart: false, why: '两个提交的文件一样' };
  // 碰了非代码的运行输入就不用再算闭包
  const quick = judge(changed, { files: new Set(), prefixes: new Set() }, service);
  if (quick.restart) return quick;
  const work = mkdtempSync(join(tmpdir(), 'fleet-closure-src-'));
  try {
    const ts = await loadTs();
    const union = { files: new Set(), prefixes: new Set() };
    for (const [tag, sha] of [
      ['old', oldSha],
      ['new', newSha],
    ]) {
      const root = checkout(repo, sha, join(work, tag));
      const c = await closureOf(root, SERVICES[service].entries, ts);
      if (c.files.size === 0) throw new Error(`${sha.slice(0, 12)} 的 ${service} 闭包是空的（入口不在？）`);
      for (const f of c.files) union.files.add(f);
      for (const p of c.prefixes) union.prefixes.add(p);
    }
    return judge(changed, union, service);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const repo = arg('git');
  const service = arg('service');
  if (!repo || !arg('new') || !service) {
    console.log(
      '用法：node runtime-closure.mjs --git <仓> --old <在用提交> --new <要发的提交> --service engine|api',
    );
    process.exit(2);
  }
  decide({ repo, oldSha: arg('old') ?? '', newSha: arg('new') ?? '', service }).then(
    (r) => {
      console.log(r.why);
      process.exit(r.restart ? 10 : 0);
    },
    (e) => {
      console.log(`判不了：${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
