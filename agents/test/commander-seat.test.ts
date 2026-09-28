// commander-seat 技能带的脚本（本机进度页、单上的「在做」认领）。脚本是 .mjs（装进各家技能目录后直接 node 跑，不靠类型剥离），
// 这里按网址动态加载它们的库、在临时家目录里跑，不碰真家目录、不出网（gh 换成内存里的假 GitHub）；命令行外壳另起进程各跑一遍。
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { type DoingIo, doing, fakeGitHub, NOW, runDoing } from './helpers/doing.ts';

const SCRIPTS = fileURLToPath(new URL('../skills/commander-seat/scripts/', import.meta.url));

interface Step {
  id: string;
  order: number;
  title: string;
  status: string;
  detail?: string;
  links?: { label: string; url: string }[];
}
interface Progress {
  meta: { project?: string; repo?: string; headline?: string; needsYou?: string[]; updatedAt?: string };
  steps: Step[];
  log: { t: string; text: string }[];
  structure?: unknown;
}
type Read = { ok: true; data: Progress } | { ok: false; kind: string; why: string };
interface CliIo {
  home: string;
  now: () => Date;
  readText: (file: string) => string;
  out: (text: string) => void;
  err: (text: string) => void;
}
interface ProgressLib {
  DEFAULT_PORT: number;
  APP_ID: string;
  dataRoot(home: string): string;
  projectPaths(
    project: string,
    home: string,
  ): { dir: string; progress: string; handoff: string; handoffs: string };
  validateProgress(data: unknown): string[];
  readProgress(file: string): Read;
  withLock<T>(dir: string, fn: () => T, opts?: { waitMs?: number; staleMs?: number }): T;
  runProgressCli(argv: string[], io: CliIo): number;
  createProgressServer(opts: { home: string; htmlFile: string }): Server;
  startServer(opts: {
    port: number;
    home: string;
    htmlFile: string;
    out: (text: string) => void;
    err: (text: string) => void;
  }): Promise<{ code: number; server?: Server; port?: number }>;
  parsePort(argv: string[], env: Record<string, string | undefined>): number | string;
  isOurs(port: number): Promise<boolean>;
  ensureServer(opts: {
    port: number;
    isUp?: (port: number) => Promise<boolean>;
    launch: () => void;
    waitMs?: number;
    stepMs?: number;
  }): Promise<{ state: 'up' | 'started' } | { state: 'failed'; why: string }>;
}

const load = async (name: string) => import(pathToFileURL(join(SCRIPTS, name)).href);
const progress = (await load('progress-lib.mjs')) as ProgressLib;
const boardCli = (await load('board-cli.mjs')) as {
  runBoardCli(
    argv: string[],
    io: {
      home: string;
      env: Record<string, string | undefined>;
      now: () => Date;
      readText?: (file: string) => string;
      ssh: (
        args: string[],
        input?: string,
      ) => { status: number | null; stdout: string; stderr: string; error?: string };
      gh: (args: string[]) => { status: number | null; stdout: string; stderr: string; error?: string };
      out: (t: string) => void;
      err: (t: string) => void;
    },
  ): Promise<number>;
};
const HTML = join(SCRIPTS, 'index.html');

const made: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'commander-seat-'));
  made.push(dir);
  return dir;
}

/** 在内存里跑一条 p.mjs 命令。 */
function p(home: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = progress.runProgressCli(argv, {
    home,
    now: () => NOW,
    readText: (file) => readFileSync(file, 'utf8'),
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function readData(home: string, project: string): Progress {
  const r = progress.readProgress(progress.projectPaths(project, home).progress);
  if (!r.ok) throw new Error(r.why);
  return r.data;
}

/** 今晚本机原型写出来的样子（字段一个不少）：新脚本得照样认。 */
const PROTOTYPE = {
  meta: { headline: '迁移和文档都合进去了', needsYou: [], updatedAt: '2026-09-26T19:18:52.642Z' },
  steps: [
    {
      id: 's01',
      order: 1,
      title: '记下 7 件拍板',
      status: 'done',
      detail: '记进去了',
      links: [{ label: 'PR #189', url: 'https://github.com/o/r/pull/189' }],
    },
    { id: 's02', order: 2, title: '出一页设计图', status: 'doing', detail: '在画' },
  ],
  log: [{ t: '2026-09-26T19:18:52.642Z', text: '文档 PR 合了' }],
  structure: {
    note: '2026-09-26 迁完',
    groups: [
      {
        title: 'v1',
        url: 'https://github.com/o/r/milestone/8',
        note: '按先后',
        items: [{ n: 191, mother: true, title: '母单', children: [{ n: 129, title: '子单' }] }],
      },
    ],
  },
};

describe('进度文件：读不到、认不出、形状不对都明确报出来，不当成空的', () => {
  it('四种失败分得开，原型写的文件照样认', () => {
    const home = tempHome();
    const file = join(home, 'progress.json');
    expect(progress.readProgress(file)).toMatchObject({ ok: false, kind: 'missing' });
    writeFileSync(file, '{ 写坏了');
    expect(progress.readProgress(file)).toMatchObject({ ok: false, kind: 'bad-json' });
    writeFileSync(file, JSON.stringify({ meta: {}, steps: 'x', log: [] }));
    const shape = progress.readProgress(file);
    expect(shape).toMatchObject({ ok: false, kind: 'bad-shape' });
    expect(shape.ok ? '' : shape.why).toContain('steps 不是列表');
    writeFileSync(file, JSON.stringify(PROTOTYPE));
    expect(progress.readProgress(file).ok).toBe(true);
  });

  it.each([
    [{}, 'meta 不是对象'],
    [[], '整份不是一个对象'],
    [{ ...PROTOTYPE, log: [{ t: 1 }] }, 'log[0] 要有 t 和 text'],
    [
      { ...PROTOTYPE, steps: [{ id: 'a', order: 1, title: 'x', status: 'finished' }] },
      'status 是「finished」',
    ],
    [{ ...PROTOTYPE, steps: [PROTOTYPE.steps[1], PROTOTYPE.steps[1]] }, '重复了'],
    [
      {
        ...PROTOTYPE,
        steps: [
          {
            id: 'a',
            order: 1,
            title: 'x',
            status: 'done',
            links: [{ label: 'x', url: 'javascript:alert(1)' }],
          },
        ],
      },
      'links 每项要有网址',
    ],
    [{ ...PROTOTYPE, meta: { repo: 'file:///etc' } }, 'meta.repo 不是网址'],
    [{ ...PROTOTYPE, structure: { groups: [{ title: 'v1', items: [{ n: 'x' }] }] } }, 'items[0].n 不是单号'],
  ])('认得出坏数据：%j', (data, problem) => {
    expect(progress.validateProgress(data).join('；')).toContain(problem);
  });
});

describe('p.mjs：按项目分开存，放在家目录下', () => {
  it('init 建在 ~/.local/share/fleet-progress/<项目>/，再 init 不盖掉；两个项目各管各的', () => {
    const home = tempHome();
    expect(p(home, 'fleet-dao', 'init', '--repo', 'owner/fleet-dao', '刚接手').code).toBe(0);
    const file = join(home, '.local', 'share', 'fleet-progress', 'fleet-dao', 'progress.json');
    expect(existsSync(file)).toBe(true);
    expect(readData(home, 'fleet-dao').meta).toMatchObject({
      project: 'fleet-dao',
      repo: 'https://github.com/owner/fleet-dao',
      headline: '刚接手',
    });
    const again = p(home, 'fleet-dao', 'init');
    expect(again.code).toBe(1);
    expect(again.err).toContain('已经有进度文件');
    expect(p(home, 'other', 'init').code).toBe(0);
    p(home, 'other', 'head', '另一个项目');
    expect(readData(home, 'fleet-dao').meta.headline).toBe('刚接手');
  });

  it('各个命令都改对了，每次记更新时间；动态只留最近 60 条', () => {
    const home = tempHome();
    p(home, 'demo', 'init');
    for (const argv of [
      ['add', 's01', '1', '第一步', '说明'],
      ['add', 's02', '2', '第二步'],
      ['step', 's01', 'done', '合进去了'],
      ['link', 's01', 'PR #1', 'https://github.com/o/r/pull/1'],
      ['needs', '拍 A', '拍 B'],
      ['head', '在做第二步'],
    ]) {
      expect(p(home, 'demo', ...argv).code, argv.join(' ')).toBe(0);
    }
    for (let i = 0; i < 70; i++) p(home, 'demo', 'log', `第 ${i} 条`);
    const data = readData(home, 'demo');
    expect(data.steps.map((s) => [s.id, s.status])).toEqual([
      ['s01', 'done'],
      ['s02', 'waiting'],
    ]);
    expect(data.steps[0]).toMatchObject({
      detail: '合进去了',
      links: [{ label: 'PR #1', url: 'https://github.com/o/r/pull/1' }],
    });
    expect(data.meta).toMatchObject({
      headline: '在做第二步',
      needsYou: ['拍 A', '拍 B'],
      updatedAt: NOW.toISOString(),
    });
    expect(data.log).toHaveLength(60);
    expect(data.log.at(-1)?.text).toBe('第 69 条');
    expect(p(home, 'demo', 'needs').code).toBe(0);
    expect(readData(home, 'demo').meta.needsYou).toEqual([]);
  });

  it('用法不对退出码 1，什么都不改', () => {
    const home = tempHome();
    p(home, 'demo', 'init');
    const before = readFileSync(progress.projectPaths('demo', home).progress, 'utf8');
    for (const argv of [
      ['step', 's09', 'done'],
      ['step', 's01', 'finished'],
      ['add', 's01', 'x', '标题'],
      ['link', 's01', '名字', 'javascript:alert(1)'],
      ['head'],
      ['fly'],
    ]) {
      expect(p(home, 'demo', ...argv).code, argv.join(' ')).toBe(1);
    }
    expect(readFileSync(progress.projectPaths('demo', home).progress, 'utf8')).toBe(before);
  });

  it('项目名只许一段：../ 这类跳出数据目录的一律不认', () => {
    const home = tempHome();
    for (const bad of ['../evil', 'a/b', '..', '.hidden', '']) {
      expect(p(home, bad, 'init').code, bad).toBe(1);
    }
    expect(existsSync(join(home, '.local', 'share', 'evil'))).toBe(false);
  });

  it('还没 init 就改：退出码 2，叫先 init，不偷偷建一份空的', () => {
    const home = tempHome();
    const r = p(home, 'demo', 'log', 'x');
    expect(r.code).toBe(2);
    expect(r.err).toContain('先 node p.mjs demo init');
    expect(existsSync(progress.projectPaths('demo', home).dir)).toBe(false);
  });

  it('进度文件坏了：改的命令退出码 2、原文件一个字不动；show 也报坏，不当成空的', () => {
    const home = tempHome();
    p(home, 'demo', 'init');
    const file = progress.projectPaths('demo', home).progress;
    for (const broken of ['{ 写坏了', JSON.stringify({ meta: {}, steps: 'x', log: [] })]) {
      writeFileSync(file, broken);
      const r = p(home, 'demo', 'log', '这条不该写进去');
      expect(r.code).toBe(2);
      expect(r.err).toContain('没改');
      expect(readFileSync(file, 'utf8')).toBe(broken);
      expect(p(home, 'demo', 'show').code).toBe(2);
    }
  });

  it('structure：形状不对拒收，对的整段换上', () => {
    const home = tempHome();
    p(home, 'demo', 'init');
    const bad = join(home, 'bad.json');
    writeFileSync(bad, JSON.stringify({ groups: [{ title: 'v1', items: [{ n: 'x' }] }] }));
    expect(p(home, 'demo', 'structure', bad).code).toBe(1);
    const good = join(home, 'good.json');
    writeFileSync(good, JSON.stringify(PROTOTYPE.structure));
    expect(p(home, 'demo', 'structure', good).code).toBe(0);
    expect(readData(home, 'demo').structure).toEqual(PROTOTYPE.structure);
  });

  it('handoff：存成交接说明，上一份归档；show 打出现状和交接说明', () => {
    const home = tempHome();
    p(home, 'demo', 'init');
    p(home, 'demo', 'add', 's01', '1', '第一步');
    const note = join(home, 'note.md');
    writeFileSync(note, '在做什么：第一份\n');
    expect(p(home, 'demo', 'handoff', note).code).toBe(0);
    writeFileSync(note, '在做什么：第二份\n');
    expect(p(home, 'demo', 'handoff', note).code).toBe(0);
    const paths = progress.projectPaths('demo', home);
    expect(readFileSync(paths.handoff, 'utf8')).toBe('在做什么：第二份\n');
    const archived = readdirSync(paths.handoffs);
    expect(archived).toHaveLength(1);
    expect(readFileSync(join(paths.handoffs, archived[0] ?? ''), 'utf8')).toBe('在做什么：第一份\n');
    const shown = p(home, 'demo', 'show');
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('s01 [排着] 第一步');
    expect(shown.out).toContain('在做什么：第二份');
    expect(p(home, 'demo', 'handoff', join(home, 'missing.md')).code).toBe(2);
  });
});

describe('写锁：同一个项目同时两条命令，一条都不丢', () => {
  it('锁被占着：等不到就明说是谁占着，不硬写', () => {
    const home = tempHome();
    const dir = join(home, 'demo');
    mkdirSync(dir);
    closeSync(openSync(join(dir, '.lock'), 'w'));
    expect(() => progress.withLock(dir, () => 1, { waitMs: 100 })).toThrow(/占着/);
  });

  it('上次崩了留下的旧锁：过期就当没有', () => {
    const home = tempHome();
    const dir = join(home, 'demo');
    mkdirSync(dir);
    const lock = join(dir, '.lock');
    closeSync(openSync(lock, 'w'));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(progress.withLock(dir, () => 42, { waitMs: 100, staleMs: 30_000 })).toBe(42);
    expect(existsSync(lock)).toBe(false);
  });

  // 这条只证明「抢锁时都等得到、都记上」；丢更新的竞态在 Windows 上起进程太慢、不一定撞得出，锁本身由上面两条定死
  it('六条 p.mjs 同时报动态、这台没有登法国的钥匙：都退出码 2，不写本地进度文件', async () => {
    const home = tempHome();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      FLEET_PROGRESS_AUTOSTART: '0',
    };
    delete env.FLEET_FRANCE_SSH;
    const codes = await Promise.all(
      [0, 1, 2, 3, 4, 5].map(
        (i) =>
          new Promise<number | null>((resolve) => {
            spawn(process.execPath, [join(SCRIPTS, 'p.mjs'), 'demo', 'log', `并行 ${i}`], {
              env,
              stdio: 'ignore',
            }).on('exit', resolve);
          }),
      ),
    );
    expect(codes).toEqual([2, 2, 2, 2, 2, 2]);
    expect(existsSync(join(home, '.local', 'share', 'fleet-progress', 'demo', 'progress.json'))).toBe(false);
  });
});

describe('页面服务', () => {
  async function serve(home: string) {
    const server = progress.createProgressServer({ home, htmlFile: HTML });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('没拿到端口');
    const base = `http://127.0.0.1:${address.port}`;
    return async (path: string, init?: RequestInit) => {
      const r = await fetch(base + path, init);
      const text = await r.text();
      return {
        status: r.status,
        type: r.headers.get('content-type') ?? '',
        text,
        json: () => JSON.parse(text),
      };
    };
  }

  it('列项目：好的带现状，坏的带原因；一个项目的数据好的 200、坏的 500、没有的 404、名字不对 400', async () => {
    const home = tempHome();
    p(home, 'good', 'init', '好好的');
    p(home, 'good', 'needs', '拍 A');
    p(home, 'broken', 'init');
    writeFileSync(progress.projectPaths('broken', home).progress, '{ 写坏了');
    const get = await serve(home);
    const list = await get('/api/projects');
    expect(list.status).toBe(200);
    expect(list.json().projects).toEqual([
      { name: 'broken', ok: false, why: expect.stringContaining('不是 JSON') },
      { name: 'good', ok: true, headline: '好好的', updatedAt: NOW.toISOString(), needs: 1 },
    ]);
    expect((await get('/api/p/good')).json().meta.headline).toBe('好好的');
    const broken = await get('/api/p/broken');
    expect(broken.status).toBe(500);
    expect(broken.json().error).toContain('不是 JSON');
    expect((await get('/api/p/nobody')).status).toBe(404);
    expect((await get('/api/p/..%2Fetc')).status).toBe(400);
    expect((await get('/api/ping')).json()).toEqual({ app: progress.APP_ID });
    expect((await get('/api/p/good', { method: 'POST' })).status).toBe(405);
    const page = await get('/');
    expect(page.status).toBe(200);
    expect(page.type).toContain('text/html');
    expect(page.text).toContain('帅位进度');
    expect(page.text).toContain('搬到驾驶舱');
    expect(page.text).not.toContain('/api/projects');
  });

  it('这台机器还没有任何项目：明说是空的（200、空列表），和读不了分开', async () => {
    const get = await serve(tempHome());
    const list = await get('/api/projects');
    expect(list.status).toBe(200);
    expect(list.json().projects).toEqual([]);
  });

  it('页面文件读不到：500 带原因，不给空页面', async () => {
    const server = progress.createProgressServer({
      home: tempHome(),
      htmlFile: join(tmpdir(), 'no-such-page.html'),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('没拿到端口');
    const r = await fetch(`http://127.0.0.1:${address.port}/`);
    expect(r.status).toBe(500);
    expect(await r.text()).toContain('页面文件读不到');
  });

  it('端口：默认 1127，环境变量和 --port 能改，认不出就说', () => {
    expect(progress.parsePort([], {})).toBe(progress.DEFAULT_PORT);
    expect(progress.DEFAULT_PORT).toBe(1127);
    expect(progress.parsePort([], { FLEET_PROGRESS_PORT: '2000' })).toBe(2000);
    expect(progress.parsePort(['--port', '3000'], { FLEET_PROGRESS_PORT: '2000' })).toBe(3000);
    expect(typeof progress.parsePort(['--port', 'abc'], {})).toBe('string');
    expect(typeof progress.parsePort(['--port'], {})).toBe('string');
    expect(typeof progress.parsePort([], { FLEET_PROGRESS_PORT: '70000' })).toBe('string');
  });

  it('再起一遍：端口上已经是进度页就说「已经在跑」、退出码 0；被别的程序占着退出码 1', async () => {
    const home = tempHome();
    const lines: string[] = [];
    const log = (t: string) => lines.push(t);
    const first = await progress.startServer({ port: 0, home, htmlFile: HTML, out: log, err: log });
    if (first.server) servers.push(first.server);
    expect(first.code).toBe(0);
    const again = await progress.startServer({
      port: first.port ?? -1,
      home,
      htmlFile: HTML,
      out: log,
      err: log,
    });
    expect(again).toEqual({ code: 0 });
    expect(lines.at(-1)).toContain('已经在跑');

    const other = createServer((_req, res) => res.end('别人的'));
    servers.push(other);
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const address = other.address();
    if (address === null || typeof address === 'string') throw new Error('没拿到端口');
    const taken = await progress.startServer({
      port: address.port,
      home,
      htmlFile: HTML,
      out: log,
      err: log,
    });
    expect(taken).toEqual({ code: 1 });
    expect(lines.at(-1)).toContain('被别的程序占着');
  });
});

describe('写进度顺手拉起页面（页面进程退出后没人拉，数据照写、页面打不开）', () => {
  it('页面在：不起新的', async () => {
    let launched = 0;
    const r = await progress.ensureServer({ port: 1, isUp: async () => true, launch: () => launched++ });
    expect(r).toEqual({ state: 'up' });
    expect(launched).toBe(0);
  });

  it('页面不在：起一个，等它答了算拉起', async () => {
    let up = false;
    const r = await progress.ensureServer({
      port: 1,
      isUp: async () => up,
      launch: () => {
        up = true;
      },
      stepMs: 10,
    });
    expect(r).toEqual({ state: 'started' });
  });

  it('起进程就报错：明说没成，不当没事', async () => {
    const r = await progress.ensureServer({
      port: 1,
      isUp: async () => false,
      launch: () => {
        throw new Error('node 找不到');
      },
    });
    expect(r.state).toBe('failed');
    expect(r.state === 'failed' && r.why).toContain('node 找不到');
  });

  it('起了进程、等不到它答：明说没成', async () => {
    const r = await progress.ensureServer({
      port: 1,
      isUp: async () => false,
      launch: () => {},
      waitMs: 50,
      stepMs: 10,
    });
    expect(r.state).toBe('failed');
    expect(r.state === 'failed' && r.why).toContain('还不是进度页');
  });

  it('真服务：关掉之后再拉起来，页面又能打开', async () => {
    const home = tempHome();
    const log = () => {};
    const first = await progress.startServer({ port: 0, home, htmlFile: HTML, out: log, err: log });
    const port = first.port ?? -1;
    expect(await progress.isOurs(port)).toBe(true);
    await new Promise((r) => first.server?.close(r));
    expect(await progress.isOurs(port)).toBe(false);
    const r = await progress.ensureServer({
      port,
      launch: () => {
        void progress.startServer({ port, home, htmlFile: HTML, out: log, err: log }).then((s) => {
          if (s.server) servers.push(s.server);
        });
      },
    });
    expect(r).toEqual({ state: 'started' });
  });

  it('p.mjs：没有登法国的钥匙，退出码 2，不写本地进度文件', async () => {
    const home = tempHome();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      FLEET_PROGRESS_AUTOSTART: '0',
    };
    delete env.FLEET_FRANCE_SSH;
    const r = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [join(SCRIPTS, 'p.mjs'), 'demo', 'init'], { env });
      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += String(d);
      });
      child.on('close', (status) => resolve({ status, stderr }));
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('没有登法国的钥匙');
    expect(existsSync(join(home, '.local', 'share', 'fleet-progress', 'demo', 'progress.json'))).toBe(false);
  });
});

describe('命令行外壳：数据按 os.homedir() 放', () => {
  it('p.mjs：不带参数给用法、退出码 1；没有法国钥匙时不写本地进度文件', () => {
    const home = tempHome();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      FLEET_PROGRESS_AUTOSTART: '0',
    };
    delete env.FLEET_FRANCE_SSH;
    const run = (...argv: string[]) =>
      spawnSync(process.execPath, [join(SCRIPTS, 'p.mjs'), ...argv], { env, encoding: 'utf8' });
    expect(run().status).toBe(1);
    expect(run('demo', 'init').status).toBe(2);
    expect(existsSync(join(home, '.local', 'share', 'fleet-progress', 'demo', 'progress.json'))).toBe(false);
  });

  it('server.mjs --port 0：起来、报地址、读的是这个家目录', async () => {
    const home = tempHome();
    p(home, 'demo', 'init', '从外壳读到的');
    const child = spawn(process.execPath, [join(SCRIPTS, 'server.mjs'), '--port', '0'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error(`10 秒没起来：${buf}`)), 10_000);
        child.stdout.on('data', (d) => {
          buf += String(d);
          const m = /http:\/\/127\.0\.0\.1:\d+/.exec(buf);
          if (m) {
            clearTimeout(timer);
            resolve(m[0]);
          }
        });
        child.stderr.on('data', (d) => {
          buf += String(d);
        });
        child.on('exit', (code) => reject(new Error(`退出了（${code}）：${buf}`)));
      });
      const r = await fetch(`${url}/api/p/demo`);
      expect(r.status).toBe(200);
      expect(((await r.json()) as Progress).meta.headline).toBe('从外壳读到的');
    } finally {
      // 等它真退出再删临时家目录：Windows 上进程的当前目录（server.mjs 挪到了家目录）在它活着时删不掉
      const exited = new Promise((resolve) => child.once('exit', resolve));
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
    }
  });
});

// ── 单上的「在做」 ──

async function run(
  gh: DoingIo['gh'],
  argv: string[],
  env: Record<string, string | undefined> = { FLEET_MACHINE: '本机' },
  home = tempHome(),
) {
  return runDoing(gh, argv, env, home);
}

describe('「在做」评论的格式', () => {
  it('写出来的认得回来；别的评论不算；机器名只许一段', () => {
    const body = doing.renderClaim('doing', '法国', '写认领\n脚本');
    expect(body.split('\n')[0]).toBe('<!-- fleet:doing machine=法国 -->');
    expect(doing.parseClaim({ id: 1, body })).toMatchObject({
      id: 1,
      state: 'doing',
      machine: '法国',
      text: '写认领 脚本',
    });
    expect(
      doing.parseClaim({ id: 2, body: doing.renderClaim('done', '本机', '合了').replaceAll('\n', '\r\n') }),
    ).toMatchObject({
      state: 'done',
      text: '合了',
    });
    expect(doing.parseClaim({ id: 3, body: '**本机 在做**：手打的，没有标记' })).toBeNull();
    for (const bad of ['', '有 空格', 'a>b', 'x'.repeat(33)])
      expect(doing.machineProblem(bad), bad).not.toBeNull();
    expect(doing.machineProblem('笔记本-2')).toBeNull();
  });
});

describe('doing.mjs claim：动一张单之前先认领', () => {
  it('没人在做：留一条、读回、认领成功', async () => {
    const gh = fakeGitHub();
    gh.add(12, '随便一条评论');
    const r = await run(gh.gh, ['claim', '#12', '写', '认领脚本']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('认领了 #12');
    expect(gh.claims(12)).toMatchObject([{ state: 'doing', machine: '本机', text: '写 认领脚本' }]);
    expect(gh.methods()).toEqual(['GET', 'POST', 'GET']);
  });

  it('别的机器做完了、放下了的不挡', async () => {
    const gh = fakeGitHub();
    gh.add(12, doing.renderClaim('done', '法国', '合了'));
    gh.add(12, doing.renderClaim('dropped', '笔记本', '不做了'));
    expect((await run(gh.gh, ['claim', '12'])).code).toBe(0);
  });

  it('撞车：法国比我晚留（编号比我大）——我留着；法国那条是晚的，报进度被拒，再认领时删掉自己那条', async () => {
    const gh = fakeGitHub();
    gh.hooks.afterPost = () => {
      gh.hooks.afterPost = undefined;
      gh.add(12, doing.renderClaim('doing', '法国', '晚到'));
    };
    const r = await run(gh.gh, ['claim', '12']);
    expect(r.code).toBe(0);
    expect(gh.claims(12).map((c) => c.machine)).toEqual(['本机', '法国']);
    const france = await run(gh.gh, ['say', '12', '继续'], { FLEET_MACHINE: '法国' });
    expect(france.code).toBe(3);
    expect(france.out).toContain('本机 先认领的');
    const franceClaim = await run(gh.gh, ['claim', '12'], { FLEET_MACHINE: '法国' });
    expect(franceClaim.code).toBe(3);
    expect(franceClaim.out).toContain('已经删了');
    expect(gh.claims(12).map((c) => c.machine)).toEqual(['本机']);
    expect((await run(gh.gh, ['say', '12', '本机接着做'])).code).toBe(0);
  });

  it('这台机器本来就在做：接着用那条，不重复留', async () => {
    const gh = fakeGitHub();
    gh.add(12, doing.renderClaim('doing', '本机', '旧的一句'));
    const r = await run(gh.gh, ['claim', '12', '新的一句']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('本来就是 本机 在做');
    expect(gh.claims(12)).toMatchObject([{ machine: '本机', text: '新的一句' }]);
    expect(gh.methods()).toEqual(['GET', 'PATCH']);
  });

  it('查不成就是查不成：先读失败退出码 2、不留评论；读回失败撤回自己那条、退出码 2', async () => {
    const first = fakeGitHub();
    first.hooks.failListAt = 0;
    const r1 = await run(first.gh, ['claim', '12']);
    expect(r1.code).toBe(2);
    expect(r1.err).toContain('别当成没人在做');
    expect(first.comments).toEqual([]);

    const readBack = fakeGitHub();
    readBack.hooks.failListAt = 1;
    const r2 = await run(readBack.gh, ['claim', '12']);
    expect(r2.code).toBe(2);
    expect(r2.err).toContain('读回没查成');
    expect(readBack.comments).toEqual([]);
  });

  it('留言后 gh 回的内容认不出：退出码 2，叫人去单上看', async () => {
    const gh = fakeGitHub();
    gh.hooks.postReply = '不是 JSON';
    const r = await run(gh.gh, ['claim', '12']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('去单上看一眼');
  });

  it('不知道这台机器叫什么：退出码 2，不猜；machine 命令记下来之后就认得', async () => {
    const gh = fakeGitHub();
    const home = tempHome();
    const r = await run(gh.gh, ['claim', '12'], {}, home);
    expect(r.code).toBe(2);
    expect(r.err).toContain('doing.mjs machine');
    expect(gh.calls).toEqual([]);
    expect((await run(gh.gh, ['machine', '有 空格'], {}, home)).code).toBe(1);
    expect((await run(gh.gh, ['machine', '笔记本'], {}, home)).code).toBe(0);
    expect(readFileSync(join(home, '.fleet-dao', 'machine-name'), 'utf8').trim()).toBe('笔记本');
    expect((await run(gh.gh, ['claim', '12'], {}, home)).code).toBe(0);
    expect(gh.claims(12)).toMatchObject([{ machine: '笔记本' }]);
  });

  it('用法不对退出码 1', async () => {
    const gh = fakeGitHub();
    for (const argv of [
      ['claim'],
      ['claim', 'abc'],
      ['say', '12'],
      ['fly', '12'],
      ['show'],
      ['say', '12', 'x', '--takeover', 'y'],
      ['claim', '12', '--repo', 'no'],
    ]) {
      expect((await run(gh.gh, argv)).code, argv.join(' ')).toBe(1);
    }
    expect(gh.calls).toEqual([]);
  });

  it('--repo 指定仓；不给就用 gh 从当前目录认的仓', async () => {
    const gh = fakeGitHub();
    await run(gh.gh, ['show', '12', '--repo', 'owner/name']);
    await run(gh.gh, ['show', '12']);
    expect(gh.calls.map((a) => a[2])).toEqual([
      'repos/owner/name/issues/12/comments',
      'repos/{owner}/{repo}/issues/12/comments',
    ]);
  });
});

describe('doing.mjs say、done、drop、show', () => {
  it('改自己那条：say 换一句，done、drop 改状态；没认领的先 claim', async () => {
    const gh = fakeGitHub();
    expect((await run(gh.gh, ['say', '12', '先说一句'])).code).toBe(2);
    await run(gh.gh, ['claim', '12', '开工']);
    expect((await run(gh.gh, ['say', '12', 'PR', '#5', '开了'])).code).toBe(0);
    expect(gh.claims(12)).toMatchObject([{ state: 'doing', text: 'PR #5 开了' }]);
    expect((await run(gh.gh, ['done', '12'])).code).toBe(0);
    expect(gh.claims(12)).toMatchObject([{ state: 'done', text: 'PR #5 开了' }]);
    const after = await run(gh.gh, ['say', '12', '还想说']);
    expect(after.code).toBe(2);
    expect(after.err).toContain('已经标了做完了');
    await run(gh.gh, ['claim', '13']);
    expect((await run(gh.gh, ['drop', '13', '交给法国'])).code).toBe(0);
    expect(gh.claims(13)).toMatchObject([{ state: 'dropped', text: '交给法国' }]);
  });

  it('show：谁在做、多久没动静；超过时限标「可能断了」；查不成的那张退出码 2', async () => {
    const gh = fakeGitHub();
    gh.add(
      12,
      doing.renderClaim('doing', '法国', '在写'),
      new Date(NOW.getTime() - (doing.STALE_HOURS * 60 + 5) * 60_000),
    );
    gh.add(13, doing.renderClaim('doing', '本机', '刚开始'), new Date(NOW.getTime() - 5 * 60_000));
    const r = await run(gh.gh, ['show', '12', '13', '14']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('#12 法国 在做：在写（最后动静 2 小时 5 分钟前，可能断了；要接手得创始人说）');
    expect(r.out).toContain('#13 本机 在做：刚开始（最后动静 5 分钟前）');
    expect(r.out).toContain('#14 没人在做');
    gh.hooks.failListAt = 3;
    const failed = await run(gh.gh, ['show', '12']);
    expect(failed.code).toBe(2);
    expect(failed.out).toContain('#12 没查成');
  });
});

describe('报到驾驶舱：法国连不上不写本地文件，评论失败不记账', () => {
  function seated(home: string) {
    const dir = join(home, '.fleet-dao', 'seat');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'main__s1.json'),
      JSON.stringify({
        scope: 'main',
        machine: '本机',
        session: 's1',
        term: 1,
        renewedOkAt: new Date().toISOString(),
        leaseMinutes: 45,
      }),
    );
  }

  it('没有法国钥匙：退出码 2，不写 progress.json', async () => {
    const home = tempHome();
    seated(home);
    const err: string[] = [];
    const code = await boardCli.runBoardCli(['demo', 'log', '一步'], {
      home,
      env: {},
      now: () => NOW,
      ssh: () => ({ status: 0, stdout: '', stderr: '' }),
      gh: () => ({ status: 0, stdout: '', stderr: '' }),
      out: () => {},
      err: (t) => err.push(t),
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('没有登法国的钥匙');
    expect(existsSync(join(home, '.local', 'share', 'fleet-progress'))).toBe(false);
  });

  it('gh 评论失败：不发 ack', async () => {
    const home = tempHome();
    seated(home);
    const calls: string[][] = [];
    const err: string[] = [];
    const code = await boardCli.runBoardCli(['demo', 'record'], {
      home,
      env: { FLEET_FRANCE_SSH: 'france' },
      now: () => NOW,
      ssh: (args) => {
        calls.push(args);
        const command = args.at(-1) ?? '';
        if (command.includes('pending')) {
          return {
            status: 0,
            stdout: `${JSON.stringify({
              ok: true,
              pending: [
                { project: 'demo', id: 'n1', question: '先做哪件', option: '接口', repo: 'o/r', issue: 12 },
              ],
            })}\n`,
            stderr: '',
          };
        }
        return { status: 0, stdout: `${JSON.stringify({ ok: true })}\n`, stderr: '' };
      },
      gh: () => ({ status: 1, stdout: '', stderr: 'gh 拒绝了' }),
      out: () => {},
      err: (t) => err.push(t),
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('还没记账');
    expect(calls.some((a) => (a.at(-1) ?? '').includes("board' 'ack'"))).toBe(false);
  });

  it('handoff：把文件交给座位，并在栏里记一条；文件读不到就退出，不假装存上', async () => {
    const home = tempHome();
    seated(home);
    const file = join(home, 'handoff.md');
    writeFileSync(file, '在做首页\n等拍选项\n');
    const seen: { cmd: string; input?: string }[] = [];
    const err: string[] = [];
    const code = await boardCli.runBoardCli(['demo', 'handoff', file], {
      home,
      env: { FLEET_FRANCE_SSH: 'france' },
      now: () => NOW,
      readText: (path) => readFileSync(path, 'utf8'),
      ssh: (args, input) => {
        const cmd = args.at(-1) ?? '';
        // input 缺省是 undefined；可选字段在开着 exactOptionalPropertyTypes 时不能赋 undefined。
        seen.push(input === undefined ? { cmd } : { cmd, input });
        return { status: 0, stdout: `${JSON.stringify({ ok: true })}\n`, stderr: '' };
      },
      gh: () => ({ status: 0, stdout: '', stderr: '' }),
      out: () => {},
      err: (t) => err.push(t),
    });
    expect(code).toBe(0);
    expect(seen[0]?.cmd).toContain("seat' 'handoff'");
    expect(seen[0]?.input).toContain('在做首页');
    expect(seen[1]?.cmd).toContain('写了交接说明');
    const missing = await boardCli.runBoardCli(['demo', 'handoff', join(home, '没有.md')], {
      home,
      env: { FLEET_FRANCE_SSH: 'france' },
      now: () => NOW,
      readText: (path) => readFileSync(path, 'utf8'),
      ssh: () => {
        throw new Error('不该连法国');
      },
      gh: () => ({ status: 0, stdout: '', stderr: '' }),
      out: () => {},
      err: (t) => err.push(t),
    });
    expect(missing).toBe(2);
    expect(err.join('\n')).toContain('读不到');
  });
});
