// 运行时追踪的底层：记下这个进程读了哪些文件、列了哪些目录、经 Node 加载了哪些模块。两处用它：
// - trace-setup.ts（vitest 的 setupFiles，测试进程里）；
// - 子进程：trace-setup.ts 往 NODE_OPTIONS 里放 `--import=<这个文件>`，子进程一启动就记，退出时写一行 JSON 到
//   $FLEET_TRACE_OUT（testFile 取 $FLEET_TRACE_TEST，即起它的那个测试文件）。
// 没设 $FLEET_TRACE_OUT 时什么都不做。shell 脚本自己读的文件、洗掉 NODE_OPTIONS 的子进程记不到。
import childProcess from 'node:child_process';
import fs, { appendFileSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

export interface Sink {
  loaded: string[];
  read: string[];
  listed: string[];
}

const KEY = Symbol.for('fleet.trace.sink');

const toPath = (a: unknown): string | undefined => {
  if (typeof a === 'string') return a;
  if (a instanceof URL) return a.protocol === 'file:' ? fileURLToPath(a) : undefined;
  if (Buffer.isBuffer(a)) return a.toString();
  return undefined;
};

/** 装上记录器（一个进程只装一次，再调返回同一个）。 */
export function startTracing(): Sink {
  const g = globalThis as { [KEY]?: Sink };
  const existing = g[KEY];
  if (existing !== undefined) return existing;
  const sink: Sink = { loaded: [], read: [], listed: [] };
  g[KEY] = sink;
  try {
    registerHooks({
      resolve(spec, context, next) {
        const r = next(spec, context);
        if (r.url.startsWith('file:')) sink.loaded.push(fileURLToPath(r.url));
        return r;
      },
    });
  } catch {
    // 没有 registerHooks 的 Node：经 Node 加载的模块这一头记不到（读盘照记）
  }
  const mod = fs as unknown as Record<string, unknown> & { promises: Record<string, unknown> };
  const wrap = (target: Record<string, unknown>, name: string, into: string[]) => {
    const orig = target[name];
    if (typeof orig !== 'function') return;
    target[name] = function (this: unknown, ...args: unknown[]) {
      const p = toPath(args[0]);
      if (p !== undefined) into.push(p);
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
  };
  for (const n of [
    'readFileSync',
    'readFile',
    'statSync',
    'stat',
    'lstatSync',
    'lstat',
    'existsSync',
    'accessSync',
    'createReadStream',
    'openSync',
    'cpSync',
    'copyFileSync',
  ])
    wrap(mod, n, sink.read);
  for (const n of ['readdirSync', 'readdir', 'opendirSync']) wrap(mod, n, sink.listed);
  for (const n of ['readFile', 'stat', 'lstat', 'access', 'open', 'cp', 'copyFile'])
    wrap(mod.promises, n, sink.read);
  for (const n of ['readdir', 'opendir']) wrap(mod.promises, n, sink.listed);
  // 子进程：默认继承 process.env（里面已有追踪用的几个变量）；测试自己造一份 env 的，往里补上这几个，免得断了追踪
  const cp = childProcess as unknown as Record<string, unknown>;
  for (const n of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const orig = cp[n];
    if (typeof orig !== 'function') continue;
    cp[n] = function (this: unknown, ...args: unknown[]) {
      for (const a of args) {
        if (a === null || typeof a !== 'object' || Array.isArray(a)) continue;
        const o = a as { env?: Record<string, string | undefined> };
        if (o.env === undefined) break;
        o.env = { ...o.env };
        for (const k of TRACE_ENV) {
          const v = process.env[k];
          if (v === undefined) continue;
          o.env[k] = k === 'NODE_OPTIONS' ? mergeNodeOptions(o.env[k], v) : v;
        }
        break;
      }
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
  }
  // ESM 的具名导入（import { readFileSync } from 'node:fs'）是另一份绑定，同步一次才看得见上面的改动
  syncBuiltinESMExports();
  return sink;
}

const TRACE_ENV = [
  'NODE_OPTIONS',
  'FLEET_TRACE_OUT',
  'FLEET_TRACE_ROOT',
  'FLEET_TRACE_TEST',
  'FLEET_TRACE_CHILD',
];
/** 把我们的 --import 并进调用方给的 NODE_OPTIONS（只取我们那一段，不覆盖它自己的）。 */
function mergeNodeOptions(theirs: string | undefined, ours: string): string {
  const hook = /--import=\S*trace-child\.ts/.exec(ours)?.[0];
  if (hook === undefined) return theirs ?? '';
  return `${(theirs ?? '').replace(/\s*--import=\S*trace-child\.ts/g, '')} ${hook}`.trim();
}

const OUT = process.env.FLEET_TRACE_OUT;
// 在 vitest 的测试进程里被 trace-setup.ts 导入时不在这里写（那边按测试文件写）；只有子进程走这里
if (
  OUT !== undefined &&
  OUT !== '' &&
  (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__ === undefined
) {
  const sink = startTracing();
  const write = () => {
    appendFileSync(
      OUT,
      `${JSON.stringify({
        testFile: process.env.FLEET_TRACE_TEST ?? '',
        root: process.env.FLEET_TRACE_ROOT ?? '',
        child: true,
        loaded: [...sink.loaded, ...(process.argv[1] ? [process.argv[1]] : [])],
        read: sink.read,
        listed: sink.listed,
      })}\n`,
    );
  };
  process.on('exit', write);
}
