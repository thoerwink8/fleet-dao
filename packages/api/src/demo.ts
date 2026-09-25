// 演示版的可见范围：驾驶舱里发演示链接、作废、改默认范围（设计文档第十四节）。
// 发布处是本机一个目录（FLEET_DEMO_DIR）：
//   scopes/<链接 id>.json、scopes/default.json —— 公开的可见范围文件，由装机时的同步单元推到香港，演示版只读它们；
//   links/<链接 id>.json —— 备注、创建人、创建时刻，只留在本机，不往外推。
// 链接口令只在新建时返回一次，这里只存它的 SHA-256（也就是链接 id 和文件名）。作废 = 撤掉那个文件。
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CreateDemoLinkRequest,
  CreateDemoLinkResponse,
  DEMO_DEFAULT_SCOPE_FILE,
  DEMO_MODULES,
  DEMO_STRICT_DEFAULT,
  DemoLinksResponse,
  type DemoScope,
  DemoScopeSchema,
  RevokeDemoLinkResponse,
  UpdateDemoDefaultRequest,
  UpdateDemoDefaultResponse,
  WebRoutes,
} from '@fleet-dao/shared';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Deps } from './deps.ts';
import { ApiError, readJson, reply } from './http.ts';
import type { Actor } from './ports.ts';
import type { CockpitEnv } from './session.ts';

/** 一条演示链接在本机的记录：公开的那部分（可见范围）加只在驾驶舱里看的备注。 */
export interface DemoLinkRecord {
  id: string;
  scope: DemoScope & { expiresAt: string };
  note?: string | undefined;
  createdAt: string;
  createdBy?: string | undefined;
}

export interface DemoPublisher {
  /** 全部链接（含已过期、文件已撤的），外加默认范围（没发布过是 null）。 */
  list(): Promise<{ links: (DemoLinkRecord & { published: boolean })[]; defaultScope: DemoScope | null }>;
  put(link: DemoLinkRecord): Promise<void>;
  /** 只撤公开的可见范围文件，本机记录留着（过期的链接照样列出来，写明已过期）。 */
  unpublish(id: string): Promise<void>;
  /** 连记录一起删掉；没有这条返回 false。 */
  remove(id: string): Promise<boolean>;
  putDefault(scope: DemoScope): Promise<void>;
}

const ID = /^[0-9a-f]{64}$/;

const LinkMetaSchema = z.object({
  id: z.string().regex(ID),
  note: z.string().optional(),
  createdAt: z.string(),
  createdBy: z.string().optional(),
  scope: DemoScopeSchema.extend({ expiresAt: z.string() }),
});

/** 口令 32 字节随机数；id 是它的 SHA-256。 */
export function newDemoToken(): { token: string; id: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, id: demoLinkId(token) };
}

export function demoLinkId(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 本机目录版的发布处。写文件先落在 .tmp/ 再改名换上：同步单元任何时候看到的都是完整的文件。 */
export function createDirDemoPublisher(dir: string): DemoPublisher {
  const scopes = join(dir, 'scopes');
  const links = join(dir, 'links');
  const tmp = join(dir, '.tmp');

  async function ready(): Promise<void> {
    await Promise.all([
      mkdir(scopes, { recursive: true }),
      mkdir(links, { recursive: true }),
      mkdir(tmp, { recursive: true }),
    ]);
  }

  async function writeAtomic(file: string, data: unknown): Promise<void> {
    await ready();
    const temp = join(tmp, `${randomBytes(8).toString('hex')}.json`);
    await writeFile(temp, `${JSON.stringify(data)}\n`, { mode: 0o644 });
    await rename(temp, file);
  }

  async function readJsonFile(file: string): Promise<unknown | undefined> {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async function names(d: string): Promise<string[]> {
    try {
      return await readdir(d);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  return {
    async list() {
      const [metaFiles, scopeFiles] = await Promise.all([names(links), names(scopes)]);
      const published = new Set(scopeFiles);
      const records = await Promise.all(
        metaFiles
          .filter((f) => f.endsWith('.json'))
          .map(async (f) => {
            const raw = await readJsonFile(join(links, f));
            const parsed = LinkMetaSchema.safeParse(raw);
            // 本机记录坏了要报出来，不能悄悄少列一条（少列的那条可能还在外面生效）。
            if (!parsed.success) throw new Error(`演示链接记录 ${f} 读不懂：${parsed.error.message}`);
            const { note, createdBy, ...rest } = parsed.data;
            const record: DemoLinkRecord & { published: boolean } = {
              ...rest,
              published: published.has(`${parsed.data.id}.json`),
            };
            if (note !== undefined) record.note = note;
            if (createdBy !== undefined) record.createdBy = createdBy;
            return record;
          }),
      );
      const rawDefault = await readJsonFile(join(scopes, DEMO_DEFAULT_SCOPE_FILE));
      let defaultScope: DemoScope | null = null;
      if (rawDefault !== undefined) {
        const parsed = DemoScopeSchema.safeParse(rawDefault);
        if (!parsed.success) throw new Error(`默认范围文件读不懂：${parsed.error.message}`);
        defaultScope = parsed.data;
      }
      records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { links: records, defaultScope };
    },
    async put(link) {
      if (!ID.test(link.id)) throw new Error(`链接 id 不对：${link.id}`);
      await writeAtomic(join(links, `${link.id}.json`), link);
      await writeAtomic(join(scopes, `${link.id}.json`), link.scope);
    },
    async unpublish(id) {
      if (!ID.test(id)) return;
      await rm(join(scopes, `${id}.json`), { force: true });
    },
    async remove(id) {
      if (!ID.test(id)) return false;
      const existed = (await readJsonFile(join(links, `${id}.json`))) !== undefined;
      await rm(join(scopes, `${id}.json`), { force: true });
      await rm(join(links, `${id}.json`), { force: true });
      return existed;
    },
    async putDefault(scope) {
      await writeAtomic(join(scopes, DEMO_DEFAULT_SCOPE_FILE), scope);
    },
  };
}

/**
 * 过期的链接撤掉公开的范围文件（本机记录留着，列表里写明已过期）。演示版自己也按到期时刻判，
 * 这一步防游客把电脑时钟往回拨：没人打开驾驶舱时也要撤，所以进程里每小时扫一次（main.ts），列表接口也顺手扫。
 */
export async function sweepExpiredDemoLinks(
  pub: DemoPublisher,
  now: Date,
): Promise<Awaited<ReturnType<DemoPublisher['list']>>> {
  const listed = await pub.list();
  for (const l of listed.links) {
    if (l.published && Date.parse(l.scope.expiresAt) <= now.getTime()) {
      await pub.unpublish(l.id);
      l.published = false;
    }
  }
  return listed;
}

/** 模块按约定里的先后排，文件内容不随勾选顺序变。 */
const ordered = (modules: DemoScope['modules']) =>
  [...modules].sort((a, b) => DEMO_MODULES.indexOf(a) - DEMO_MODULES.indexOf(b));

/** 驾驶舱的「演示版」页用的四个接口。挂在 cockpitRoutes 里（已登录、写操作查过 CSRF）。 */
export function registerDemoRoutes(
  app: Hono<CockpitEnv>,
  deps: Deps,
  actorOf: (c: Context<CockpitEnv>) => Actor,
): void {
  const { store } = deps;

  function publisher(): DemoPublisher {
    if (!deps.demo) {
      throw new ApiError(
        503,
        'demo_not_configured',
        '演示版的发布目录没配置（后端的 FLEET_DEMO_DIR），发不了链接',
      );
    }
    return deps.demo;
  }

  app.get(WebRoutes.demoLinks.path, async (c) => {
    if (!deps.demo) {
      return reply(c, DemoLinksResponse, {
        configured: false,
        links: [],
        defaultScope: DEMO_STRICT_DEFAULT,
        defaultPublished: false,
      });
    }
    const { links, defaultScope } = await sweepExpiredDemoLinks(deps.demo, deps.now());
    return reply(c, DemoLinksResponse, {
      configured: true,
      links: links.map((l) => ({
        id: l.id,
        modules: l.scope.modules,
        detail: l.scope.detail,
        expiresAt: l.scope.expiresAt,
        createdAt: l.createdAt,
        ...(l.note ? { note: l.note } : {}),
        ...(l.createdBy ? { createdBy: l.createdBy } : {}),
        expired: !l.published,
      })),
      defaultScope: defaultScope ?? DEMO_STRICT_DEFAULT,
      defaultPublished: defaultScope !== null,
    });
  });

  app.post(WebRoutes.createDemoLink.path, async (c) => {
    const pub = publisher();
    const body = await readJson(c, CreateDemoLinkRequest);
    const now = deps.now();
    const { token, id } = newDemoToken();
    const actor = actorOf(c);
    const expiresAt = new Date(now.getTime() + body.expiresInDays * 86_400_000).toISOString();
    const record: DemoLinkRecord = {
      id,
      scope: { v: 1, modules: ordered(body.modules), detail: body.detail, expiresAt },
      createdAt: now.toISOString(),
      createdBy: actor.id,
      ...(body.note ? { note: body.note } : {}),
    };
    // 先记后做：记录写不进就不发。
    await store.appendAudit({
      actor,
      action: 'demo.link.create',
      target: `demo-link:${id.slice(0, 12)}`,
      after: { modules: record.scope.modules, detail: body.detail, expiresAt, note: body.note },
      via: c.get('via'),
      ok: true,
    });
    await pub.put(record);
    return reply(c, CreateDemoLinkResponse, {
      link: {
        id,
        modules: record.scope.modules,
        detail: record.scope.detail,
        expiresAt,
        createdAt: record.createdAt,
        createdBy: actor.id,
        ...(body.note ? { note: body.note } : {}),
        expired: false,
      },
      token,
    });
  });

  app.delete(WebRoutes.revokeDemoLink.path, async (c) => {
    const pub = publisher();
    const id = c.req.param('linkId');
    const known = ID.test(id) && (await pub.list()).links.some((l) => l.id === id);
    if (!known) throw new ApiError(404, 'demo_link_not_found', '没有这条演示链接');
    await store.appendAudit({
      actor: actorOf(c),
      action: 'demo.link.revoke',
      target: `demo-link:${id.slice(0, 12)}`,
      via: c.get('via'),
      ok: true,
    });
    await pub.remove(id);
    return reply(c, RevokeDemoLinkResponse, { ok: true });
  });

  app.put(WebRoutes.updateDemoDefault.path, async (c) => {
    const pub = publisher();
    const body = await readJson(c, UpdateDemoDefaultRequest);
    const scope: DemoScope = { v: 1, modules: ordered(body.modules), detail: body.detail };
    const before = (await pub.list()).defaultScope ?? DEMO_STRICT_DEFAULT;
    await store.appendAudit({
      actor: actorOf(c),
      action: 'demo.default.update',
      target: 'demo:default',
      before: { modules: before.modules, detail: before.detail },
      after: { modules: scope.modules, detail: scope.detail },
      via: c.get('via'),
      ok: true,
    });
    await pub.putDefault(scope);
    return reply(c, UpdateDemoDefaultResponse, { defaultScope: scope });
  });
}
