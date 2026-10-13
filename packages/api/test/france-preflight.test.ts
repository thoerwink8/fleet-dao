// 发版预检：七项事实读到、读不到各一条；卡住 / 留意不靠子进程；正式读法不碰 home。
// node 的内置模块导出不可 spy，改成包一层：真被调用就计数，并仍走原来的实现。

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const procCalls = vi.hoisted(() => ({ execFile: 0, spawn: 0, homedir: 0 }));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      procCalls.execFile += 1;
      return (actual.execFile as (...a: unknown[]) => unknown)(...args);
    },
    spawn: (...args: unknown[]) => {
      procCalls.spawn += 1;
      return (actual.spawn as (...a: unknown[]) => unknown)(...args);
    },
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => {
      procCalls.homedir += 1;
      return actual.homedir();
    },
  };
});

import {
  DRAIN_STATUS_FILE,
  interpretOther,
  listEnginePids,
  liveFrancePreflightReaders,
  PREFLIGHT_FACT_NAMES,
  type PreflightReaders,
  readPreflightFacts,
  readSessionFact,
  readTrainDir,
  renderPreflight,
  sessionCountFromDrain,
} from '../src/france-preflight.ts';
import { TRAIN_DIR } from '../src/france-release.ts';
import { RELEASE_REQUEST_DIR, REQUEST_NAME } from '../src/release-request.ts';

const FACTS = [
  ['mainline', '主线头和 CI'],
  ['deployed', '法国在用提交'],
  ['gap', '落后几个'],
  ['other', '别的发布是否在走'],
  ['receiver', '发版接活单元'],
  ['master', '引擎总开关'],
  ['sessions', '法国在跑的会话数'],
] as const;

type FactKey = (typeof FACTS)[number][0];

function passing(): PreflightReaders {
  return {
    mainline: async () => ({ short: 'abcdef123456', title: '刷新耗时表', ci: 'green', ciDetail: '' }),
    deployed: async () => ({ short: 'bbbbbbbbbbbb', title: '上一版' }),
    gap: async () => ({ kind: 'ahead', count: 3 }),
    other: async () => ({ kind: 'clear', detail: '没有别的发布在走' }),
    receiver: async () => ({ installed: true }),
    master: async () => ({ on: true, detail: '开着：引擎在接活' }),
    sessions: async () => ({ count: 0, engineDown: false }),
  };
}

function withThrow(key: FactKey, why: string): PreflightReaders {
  const readers = passing();
  const fail = async (): Promise<never> => {
    throw new Error(why);
  };
  switch (key) {
    case 'mainline':
      return { ...readers, mainline: fail };
    case 'deployed':
      return { ...readers, deployed: fail };
    case 'gap':
      return { ...readers, gap: fail };
    case 'other':
      return { ...readers, other: fail };
    case 'receiver':
      return { ...readers, receiver: fail };
    case 'master':
      return { ...readers, master: fail };
    case 'sessions':
      return { ...readers, sessions: fail };
  }
}

function lineOf(stdout: string, name: string): string {
  const found = stdout.split('\n').find((line) => line.startsWith(`${name}：`));
  expect(found, stdout).toBeTruthy();
  return found ?? '';
}

describe('七项事实', () => {
  it.each(FACTS)('读到 %s', async (key, name) => {
    const rendered = renderPreflight(await readPreflightFacts(passing()));
    expect(rendered.code, key).toBe(0);
    expect(lineOf(rendered.stdout, name)).toContain('：通过');
    expect(lineOf(rendered.stdout, name)).not.toContain('读不到');
    expect(rendered.stdout.split('\n')).toHaveLength(PREFLIGHT_FACT_NAMES.length);
  });

  it.each(FACTS)('读不到 %s', async (key, name) => {
    const why = `EACCES ${name}`;
    const rendered = renderPreflight(await readPreflightFacts(withThrow(key, why)));
    expect(rendered.code).toBe(2);
    expect(lineOf(rendered.stdout, name)).toBe(`${name}：读不到 ${why}`);
    for (const other of FACTS) {
      if (other[0] === key) continue;
      expect(lineOf(rendered.stdout, other[1])).toContain('：通过');
    }
  });
});

describe('读到了，但是卡住或只要留意', () => {
  it('CI 红：卡住，退出码 2', async () => {
    const readers = passing();
    readers.mainline = async () => ({
      short: 'abcdef123456',
      title: '刷新耗时表',
      ci: 'red',
      ciDetail: '单测红',
    });
    const rendered = renderPreflight(await readPreflightFacts(readers));
    expect(rendered.code).toBe(2);
    expect(lineOf(rendered.stdout, '主线头和 CI')).toBe(
      '主线头和 CI：卡住 提交 abcdef123456「刷新耗时表」，CI 红：单测红',
    );
  });

  it('CI 还在跑：卡住，退出码 2', async () => {
    const readers = passing();
    readers.mainline = async () => ({
      short: 'abcdef123456',
      title: '刷新耗时表',
      ci: 'pending',
      ciDetail: '还没有结果',
    });
    const rendered = renderPreflight(await readPreflightFacts(readers));
    expect(rendered.code).toBe(2);
    expect(lineOf(rendered.stdout, '主线头和 CI')).toContain('CI 还在跑：还没有结果');
  });

  it('法国已经是最新：卡住，退出码 2', async () => {
    const readers = passing();
    readers.gap = async () => ({ kind: 'same' });
    const rendered = renderPreflight(await readPreflightFacts(readers));
    expect(rendered.code).toBe(2);
    expect(lineOf(rendered.stdout, '落后几个')).toBe('落后几个：卡住 法国已经是最新，没有要发的');
  });

  it('已有发版在走：卡住，退出码 2', async () => {
    const readers = passing();
    readers.other = async () => ({
      kind: 'busy',
      detail: '已有发版在走（第 4 步「发版」，提交 abcdef123456）',
    });
    const rendered = renderPreflight(await readPreflightFacts(readers));
    expect(rendered.code).toBe(2);
    expect(lineOf(rendered.stdout, '别的发布是否在走')).toContain('：卡住 已有发版在走');
  });

  it('接活单元没装：卡住，退出码 2', async () => {
    const readers = passing();
    readers.receiver = async () => ({ installed: false, why: '法国还没装发版接活单元（缺 /etc/x）' });
    const rendered = renderPreflight(await readPreflightFacts(readers));
    expect(rendered.code).toBe(2);
    expect(lineOf(rendered.stdout, '发版接活单元')).toBe(
      '发版接活单元：卡住 法国还没装发版接活单元（缺 /etc/x）',
    );
  });

  it('总开关关着：留意，退出码 0', async () => {
    const readers = passing();
    readers.master = async () => ({ on: false, detail: '关着（从没设过，默认关）' });
    const rendered = renderPreflight(await readPreflightFacts(readers));
    expect(rendered.code).toBe(0);
    expect(lineOf(rendered.stdout, '引擎总开关')).toBe(
      '引擎总开关：留意 关着（从没设过，默认关）。发完保持关',
    );
  });

  it('还有会话在跑：留意，退出码 0', async () => {
    const readers = passing();
    readers.sessions = async () => ({ count: 2, engineDown: false });
    const rendered = renderPreflight(await readPreflightFacts(readers));
    expect(rendered.code).toBe(0);
    expect(lineOf(rendered.stdout, '法国在跑的会话数')).toBe(
      '法国在跑的会话数：留意 2 个（发版会等它们做完这一步）',
    );
  });

  it('一项卡住时，留意还写着，退出码仍是 2', async () => {
    const readers = passing();
    readers.gap = async () => ({ kind: 'same' });
    readers.sessions = async () => ({ count: 2, engineDown: false });
    const rendered = renderPreflight(await readPreflightFacts(readers));
    expect(rendered.code).toBe(2);
    expect(lineOf(rendered.stdout, '法国在跑的会话数')).toContain('：留意');
  });
});

describe('别的发布、会话数的读法', () => {
  it('没有记录、没有请求：通过', () => {
    expect(interpretOther({ stateJson: null, marker: false }, false)).toEqual({
      kind: 'clear',
      detail: '没有别的发布在走',
    });
  });

  it('请求还在：卡住', () => {
    expect(interpretOther({ stateJson: null, marker: false }, true).kind).toBe('busy');
  });

  it('上一趟卡住：留意，不当成正在走', () => {
    const stateJson = JSON.stringify({
      schema: 1,
      phase: 3,
      status: 'blocked',
      why: '还有会话',
      target: { kind: 'sha', value: 'abcdef1234567890' },
    });
    const fact = interpretOther({ stateJson, marker: true }, false);
    expect(fact.kind).toBe('note');
    if (fact.kind !== 'note') throw new Error('该是留意');
    expect(fact.detail).toContain('上一趟卡住');
    expect(fact.detail).toContain('再点发布会另开一趟');
  });

  it('记录不是 JSON：抛错，不当成没有发布', () => {
    expect(() => interpretOther({ stateJson: '{', marker: false }, false)).toThrow(/JSON/);
  });

  it('引擎进程不在：0 个，不读 drain.json', async () => {
    let drainReads = 0;
    const fact = await readSessionFact({
      enginePids: async () => [],
      drainText: async () => {
        drainReads += 1;
        return '{"schema":2,"pid":1,"sessions":[{}]}';
      },
    });
    expect(fact).toEqual({ count: 0, engineDown: true });
    expect(drainReads).toBe(0);
  });

  it('引擎在跑、drain.json 不在：读不到，不当成 0', async () => {
    await expect(
      readSessionFact({ enginePids: async () => [7], drainText: async () => null }),
    ).rejects.toThrow(/drain.json 不在/);
  });

  it('drain.json 是上一个进程留下的：读不到', () => {
    const parsed = sessionCountFromDrain(JSON.stringify({ schema: 2, pid: 1, sessions: [] }), [7]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('该是读不到');
    expect(parsed.why).toContain('留下的');
  });

  it('进程号对得上：数 sessions', () => {
    const parsed = sessionCountFromDrain(
      JSON.stringify({ schema: 2, pid: 7, sessions: [{ runId: 'a' }, { runId: 'b' }] }),
      [7],
    );
    expect(parsed).toEqual({ ok: true, count: 2 });
  });

  it('argv 对上才算引擎进程；读不了 /proc 抛错', async () => {
    const pids = await listEnginePids(
      async () => ['1', '9', 'nope'],
      async (pid) => (pid === '9' ? `node\0/srv/x/${'packages/engine/src/main.ts'}\0` : 'other'),
    );
    expect(pids).toEqual([9]);
    await expect(
      listEnginePids(async () => Promise.reject(Object.assign(new Error('no'), { code: 'EACCES' }))),
    ).rejects.toThrow(/读 \/proc 没成/);
  });
});

describe('正式读法不起子进程、不碰 home', () => {
  it('源码里没有子进程，预检文件也不读 home', () => {
    const release = readFileSync(new URL('../src/france-release.ts', import.meta.url), 'utf8');
    const preflight = readFileSync(new URL('../src/france-preflight.ts', import.meta.url), 'utf8');
    expect(release).not.toMatch(/child_process|\bexecFile\b|release:onekey preflight/);
    expect(preflight).not.toMatch(/child_process|\bexecFile\b|\bhomedir\b|release:onekey/);
  });

  it('读事实时不调用 child_process，也不读 home', async () => {
    const before = { ...procCalls };
    const reads: string[] = [];
    const enginePid = 4242;
    const readText = async (path: string) => {
      reads.push(path);
      if (path === `/proc/${enginePid}/cmdline`) {
        return 'node\0/srv/fleet-dao-releases/current/packages/engine/src/main.ts\0';
      }
      if (path === DRAIN_STATUS_FILE) {
        return JSON.stringify({
          schema: 2,
          pid: enginePid,
          sessions: [{ runId: 'abc', stage: 'implement' }],
        });
      }
      throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
    };
    const readers = liveFrancePreflightReaders({
      distance: async () => ({
        mainline: {
          state: 'ok',
          commit: {
            sha: 'a'.repeat(40),
            short: 'aaaaaaaaaaaa',
            title: '主线',
            at: '2026-10-13T00:00:00.000Z',
          },
          ci: { state: 'green' },
        },
        deployed: {
          state: 'ok',
          sha: 'b'.repeat(40),
          short: 'bbbbbbbbbbbb',
          title: '在用',
          titleWhy: null,
          deployedAt: null,
          deployedAtWhy: null,
        },
        gap: { state: 'ahead', count: 2, prs: [], nonPr: 0 },
      }),
      master: async () => ({ on: true }),
      receiver: async () => ({ ok: true }),
      readText,
      listProc: async () => ['1', String(enginePid)],
    });
    const rendered = renderPreflight(await readPreflightFacts(readers));
    expect(rendered.code).toBe(0);
    expect(lineOf(rendered.stdout, '法国在跑的会话数')).toContain('留意 1 个');
    expect(lineOf(rendered.stdout, '主线头和 CI')).toContain('：通过');
    expect(reads.some((path) => path.startsWith('/home') || path.includes('.config/pnpm'))).toBe(false);
    expect(reads.some((path) => path.startsWith(TRAIN_DIR))).toBe(true);
    expect(procCalls.execFile).toBe(before.execFile);
    expect(procCalls.spawn).toBe(before.spawn);
    expect(procCalls.homedir).toBe(before.homedir);
  });

  it('进度目录读不到：这一项读不到，不退回去读 home', async () => {
    const reads: string[] = [];
    const readText = async (path: string) => {
      reads.push(path);
      throw Object.assign(new Error(`EACCES ${path}`), { code: 'EACCES' });
    };
    await expect(readTrainDir(TRAIN_DIR, readText)).rejects.toThrow(/EACCES/);
    expect(reads).toEqual([`${TRAIN_DIR}/release-train.json`]);
    expect(reads.some((path) => path.includes('/home'))).toBe(false);
  });

  it('主线读不到时，在用提交和落后几个各自写读不到', async () => {
    const readers = liveFrancePreflightReaders({
      distance: async () => ({
        mainline: { state: 'unreadable', why: '读主线头失败：超时' },
        deployed: { state: 'unreadable', why: '读法国在用的提交失败：没有 current' },
        gap: { state: 'unreadable', why: '主线头、法国在用的提交没读到，差几个算不出（不当成「已是最新」）' },
      }),
      master: async () => ({ on: false, why: 'never_set' }),
      receiver: async () => ({ ok: false, why: '法国还没装发版接活单元（缺单元）' }),
      readText: async (path) => {
        if (path === `${TRAIN_DIR}/release-train.json` || path === `${TRAIN_DIR}/release-train.paused`) {
          throw Object.assign(new Error('no'), { code: 'ENOENT' });
        }
        if (path === `${RELEASE_REQUEST_DIR}/${REQUEST_NAME}`) {
          throw Object.assign(new Error('no'), { code: 'ENOENT' });
        }
        throw Object.assign(new Error(`意外的路径 ${path}`), { code: 'ENOENT' });
      },
      listProc: async () => [],
    });
    const rendered = renderPreflight(await readPreflightFacts(readers));
    expect(rendered.code).toBe(2);
    expect(lineOf(rendered.stdout, '主线头和 CI')).toContain('读不到 读主线头失败：超时');
    expect(lineOf(rendered.stdout, '法国在用提交')).toContain('读不到 读法国在用的提交失败：没有 current');
    expect(lineOf(rendered.stdout, '落后几个')).toContain('读不到');
    expect(lineOf(rendered.stdout, '落后几个')).toContain('不当成「已是最新」');
    expect(lineOf(rendered.stdout, '发版接活单元')).toContain('：卡住');
    expect(lineOf(rendered.stdout, '引擎总开关')).toContain('：留意');
    expect(lineOf(rendered.stdout, '法国在跑的会话数')).toContain('0 个（引擎没在跑）');
    expect(lineOf(rendered.stdout, '别的发布是否在走')).toContain('：通过');
  });

  it('提交读到了、CI 读不到：这一行写读不到，并带上提交号', async () => {
    const readers = liveFrancePreflightReaders({
      distance: async () => ({
        mainline: {
          state: 'ok',
          commit: {
            sha: 'a'.repeat(40),
            short: 'aaaaaaaaaaaa',
            title: '主线',
            at: '2026-10-13T00:00:00.000Z',
          },
          ci: { state: 'unreadable', why: '检查列表超时' },
        },
        deployed: {
          state: 'ok',
          sha: 'b'.repeat(40),
          short: 'bbbbbbbbbbbb',
          title: null,
          titleWhy: '读它的标题失败：超时',
          deployedAt: null,
          deployedAtWhy: null,
        },
        gap: { state: 'ahead', count: 1, prs: [], nonPr: 0 },
      }),
      master: async () => ({ on: true }),
      receiver: async () => ({ ok: true }),
      readText: async () => {
        throw Object.assign(new Error('no'), { code: 'ENOENT' });
      },
      listProc: async () => [],
    });
    const rendered = renderPreflight(await readPreflightFacts(readers));
    expect(lineOf(rendered.stdout, '主线头和 CI')).toBe(
      '主线头和 CI：读不到 提交 aaaaaaaaaaaa 读到了，CI 读不到：检查列表超时',
    );
    expect(lineOf(rendered.stdout, '法国在用提交')).toBe('法国在用提交：通过 提交 bbbbbbbbbbbb');
    expect(rendered.code).toBe(2);
  });
});
