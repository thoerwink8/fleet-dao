// 演示版的可见范围：发链接、作废、到期、默认范围，以及发布目录没配、记录读不懂时照实报错。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CreateDemoLinkResponse,
  DEMO_MODULES,
  DEMO_STRICT_DEFAULT,
  DemoDetailSchema,
  DemoLinksResponse,
  DemoScopeSchema,
  UpdateDemoDefaultResponse,
} from '@fleet-dao/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createDirDemoPublisher, demoLinkId, sweepExpiredDemoLinks } from '../src/demo.ts';
import { errorCode, harness, write } from './harness.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'fleet-demo-test-'));
  dirs.push(d);
  return d;
}

async function setup() {
  const dir = tempDir();
  const h = harness({ demo: createDirDemoPublisher(dir), config: { demoDir: dir } });
  const session = await h.login();
  return { h, session, dir };
}

const NEW_LINK = { modules: ['quota', 'board'], detail: 'titles', expiresInDays: 7, note: '给投资人看' };

describe('演示链接', () => {
  it('新建：口令只给一次，文件按口令的 SHA-256 命名；公开文件里只有可见范围，备注只留本机', async () => {
    const { h, session, dir } = await setup();
    const res = await h.cockpit.request('/api/demo/links', write('POST', session, NEW_LINK));
    expect(res.status).toBe(200);
    const body = CreateDemoLinkResponse.parse(await res.json());
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.link.id).toBe(demoLinkId(body.token));

    const scope = JSON.parse(readFileSync(join(dir, 'scopes', `${body.link.id}.json`), 'utf8'));
    // 模块按约定里的先后排，和勾选顺序无关；到期 = 现在 + 7 天
    expect(scope).toEqual({
      v: 1,
      modules: ['board', 'quota'],
      detail: 'titles',
      expiresAt: new Date(h.clock.now.getTime() + 7 * 86_400_000).toISOString(),
    });
    expect(DemoScopeSchema.safeParse(scope).success).toBe(true);
    const meta = readFileSync(join(dir, 'links', `${body.link.id}.json`), 'utf8');
    expect(meta).toContain('给投资人看');
    expect(existsSync(join(dir, '.tmp'))).toBe(true);

    const audit = (await h.store.listAudit({ limit: 5 })).items;
    expect(audit[0]?.action).toBe('demo.link.create');
    expect(audit[0]?.target).toBe(`demo-link:${body.link.id.slice(0, 12)}`);
    // 操作记录里不留口令
    expect(JSON.stringify(audit)).not.toContain(body.token);
  });

  it('列出来：有效的、过期的都列，过期的公开文件撤掉（防游客把电脑时钟往回拨）', async () => {
    const { h, session, dir } = await setup();
    const created = CreateDemoLinkResponse.parse(
      await (await h.cockpit.request('/api/demo/links', write('POST', session, NEW_LINK))).json(),
    );
    let list = DemoLinksResponse.parse(
      await (await h.cockpit.request('/api/demo/links', { headers: { cookie: session.cookie } })).json(),
    );
    expect(list.configured).toBe(true);
    expect(list.links.map((l) => [l.id, l.expired, l.note])).toEqual([
      [created.link.id, false, '给投资人看'],
    ]);
    expect(list.defaultPublished).toBe(false);
    expect(list.defaultScope).toEqual(DEMO_STRICT_DEFAULT);

    h.clock.now = new Date(h.clock.now.getTime() + 8 * 86_400_000);
    list = DemoLinksResponse.parse(
      await (await h.cockpit.request('/api/demo/links', { headers: { cookie: session.cookie } })).json(),
    );
    expect(list.links.map((l) => l.expired)).toEqual([true]);
    expect(existsSync(join(dir, 'scopes', `${created.link.id}.json`))).toBe(false);
    expect(existsSync(join(dir, 'links', `${created.link.id}.json`))).toBe(true);
  });

  it('作废：撤掉文件和本机记录，记一笔；再作废同一条是 404', async () => {
    const { h, session, dir } = await setup();
    const created = CreateDemoLinkResponse.parse(
      await (await h.cockpit.request('/api/demo/links', write('POST', session, NEW_LINK))).json(),
    );
    const res = await h.cockpit.request(`/api/demo/links/${created.link.id}`, write('DELETE', session));
    expect(res.status).toBe(200);
    expect(existsSync(join(dir, 'scopes', `${created.link.id}.json`))).toBe(false);
    expect(existsSync(join(dir, 'links', `${created.link.id}.json`))).toBe(false);
    expect((await h.store.listAudit({ limit: 1 })).items[0]?.action).toBe('demo.link.revoke');

    const again = await h.cockpit.request(`/api/demo/links/${created.link.id}`, write('DELETE', session));
    expect(again.status).toBe(404);
    expect(await errorCode(again)).toBe('demo_link_not_found');
  });

  it('默认范围：发布成 default.json，列表里显示已发布', async () => {
    const { h, session, dir } = await setup();
    const res = await h.cockpit.request(
      '/api/demo/default',
      write('PUT', session, { modules: ['task', 'board'], detail: 'status' }),
    );
    expect(res.status).toBe(200);
    expect(UpdateDemoDefaultResponse.parse(await res.json()).defaultScope).toEqual({
      v: 1,
      modules: ['board', 'task'],
      detail: 'status',
    });
    expect(JSON.parse(readFileSync(join(dir, 'scopes', 'default.json'), 'utf8')).modules).toEqual([
      'board',
      'task',
    ]);
    const list = DemoLinksResponse.parse(
      await (await h.cockpit.request('/api/demo/links', { headers: { cookie: session.cookie } })).json(),
    );
    expect(list.defaultPublished).toBe(true);
    expect((await h.store.listAudit({ limit: 1 })).items[0]?.action).toBe('demo.default.update');
  });

  it('请求不合约定就拒：一个模块都不开、有效期 0 天、不认识的模块', async () => {
    const { h, session } = await setup();
    for (const body of [
      { ...NEW_LINK, modules: [] },
      { ...NEW_LINK, expiresInDays: 0 },
      { ...NEW_LINK, modules: ['board', 'secrets'] },
    ]) {
      const res = await h.cockpit.request('/api/demo/links', write('POST', session, body));
      expect(res.status).toBe(400);
    }
  });

  it('发布目录没配：列表照实说没配，发链接回 503，不假装「没有链接」', async () => {
    const h = harness();
    const session = await h.login();
    const list = DemoLinksResponse.parse(
      await (await h.cockpit.request('/api/demo/links', { headers: { cookie: session.cookie } })).json(),
    );
    expect(list.configured).toBe(false);
    const res = await h.cockpit.request('/api/demo/links', write('POST', session, NEW_LINK));
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('demo_not_configured');
  });

  it('本机记录读不懂：列表报错，不悄悄少列一条（少列的那条可能还在外面生效）', async () => {
    const { h, session, dir } = await setup();
    await h.cockpit.request('/api/demo/links', write('POST', session, NEW_LINK));
    writeFileSync(join(dir, 'links', `${'f'.repeat(64)}.json`), '{不是 JSON');
    const res = await h.cockpit.request('/api/demo/links', { headers: { cookie: session.cookie } });
    expect(res.status).toBe(500);
  });

  it('没人打开驾驶舱也会撤：定时扫一遍，到期的撤文件、没到期的不动', async () => {
    const { h, session, dir } = await setup();
    const short = CreateDemoLinkResponse.parse(
      await (
        await h.cockpit.request('/api/demo/links', write('POST', session, { ...NEW_LINK, expiresInDays: 1 }))
      ).json(),
    );
    const long = CreateDemoLinkResponse.parse(
      await (await h.cockpit.request('/api/demo/links', write('POST', session, NEW_LINK))).json(),
    );
    const pub = createDirDemoPublisher(dir);
    const later = new Date(h.clock.now.getTime() + 2 * 86_400_000);
    const { links } = await sweepExpiredDemoLinks(pub, later);
    expect(links.find((l) => l.id === short.link.id)?.published).toBe(false);
    expect(existsSync(join(dir, 'scopes', `${short.link.id}.json`))).toBe(false);
    expect(existsSync(join(dir, 'scopes', `${long.link.id}.json`))).toBe(true);
  });
});

describe('推到香港的脚本认得后端写的文件（deploy/france/fleet-demo-scopes.sh）', () => {
  // 那个脚本以 root 跑、只推「长得和后端写的一模一样」的文件：后端的写法一变、约定里加了模块，这里先红。
  // 脚本那头认文件的真代码由 deploy/test/demo-scopes.test.sh 拿同样样子的文件跑。
  const script = readFileSync(
    new URL('../../../deploy/france/fleet-demo-scopes.sh', import.meta.url),
    'utf8',
  );

  it('脚本认的模块、细节级别和约定里的一致', () => {
    expect(script.match(/^MODULES='([^']+)'/m)?.[1]?.split('|')).toEqual([...DEMO_MODULES]);
    expect(script.match(/\\"detail\\":\\"\(([a-z|]+)\)\\"/)?.[1]?.split('|')).toEqual(
      DemoDetailSchema.options,
    );
  });

  it('写出来的就是一行紧凑的 JSON、键的先后固定、末尾一个换行（脚本按这个样子认）', async () => {
    const { h, session, dir } = await setup();
    const created = CreateDemoLinkResponse.parse(
      await (
        await h.cockpit.request(
          '/api/demo/links',
          write('POST', session, {
            modules: [...DEMO_MODULES].reverse(),
            detail: 'process',
            expiresInDays: 1,
          }),
        )
      ).json(),
    );
    const expiresAt = new Date(h.clock.now.getTime() + 86_400_000).toISOString();
    expect(readFileSync(join(dir, 'scopes', `${created.link.id}.json`), 'utf8')).toBe(
      `${JSON.stringify({ v: 1, modules: [...DEMO_MODULES], detail: 'process', expiresAt })}\n`,
    );
    await h.cockpit.request('/api/demo/default', write('PUT', session, { modules: [], detail: 'status' }));
    expect(readFileSync(join(dir, 'scopes', 'default.json'), 'utf8')).toBe(
      '{"v":1,"modules":[],"detail":"status"}\n',
    );
  });
});

describe('演示版的配置', () => {
  const base = { FLEET_ENV: 'development' };
  it('发布目录要写绝对路径；没配就是没配', () => {
    expect(loadConfig({ ...base, FLEET_DEMO_DIR: '/var/lib/fleet-dao/demo' }).demoDir).toBe(
      '/var/lib/fleet-dao/demo',
    );
    expect(() => loadConfig({ ...base, FLEET_DEMO_DIR: 'relative/dir' })).toThrow(/FLEET_DEMO_DIR/);
    expect(loadConfig(base).demoDir).toBeNull();
  });
});
