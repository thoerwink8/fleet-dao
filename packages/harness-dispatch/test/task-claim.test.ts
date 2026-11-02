// 新内核认领一张单（#3783，决定 0124 的认领表）：对旧库 tasks 那一行条件更新。PGlite 里按旧库的形状建 repos、tasks 和
// 触发器 tasks_bump_fencing（owner、executor、claimed_by 变了令牌加一，写方传的值被盖回），认领函数用的就是真列名。
// 旧库真实的表和触发器在 packages/db 的迁移里，那边的 test/task-owner.test.ts 守着；这里的形状是对着它抄的。
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb, type TestDb } from '@fleet-dao/harness-store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireTask, currentFencing, releaseTask } from '../src/task-claim.ts';

let t: TestDb;
const ref = { repo: 'Owner/App', issue: 7 };

beforeAll(async () => {
  t = await createTestDb();
  await (t.pg as PGlite).exec(`
    create type public.task_state as enum ('queued','triaging','asking','planning','running','merging','done','stopped','failed','stalled');
    create table public.repos (id uuid primary key default gen_random_uuid(), owner text not null, name text not null);
    create table public.tasks (
      id uuid primary key default gen_random_uuid(),
      repo_id uuid not null references public.repos(id),
      issue_number integer not null,
      title text not null,
      raw_request text not null,
      requested_by text not null,
      state public.task_state not null default 'queued',
      priority integer not null,
      phase text, doing text,
      updated_at timestamptz,
      executor text not null default 'engine',
      claimed_by text,
      owner text not null default 'v1',
      fencing bigint not null default 0,
      constraint tasks_repo_issue_unique unique (repo_id, issue_number)
    );
    create function public.tasks_bump_fencing() returns trigger language plpgsql as $$
    begin
      if tg_op = 'INSERT' then new.fencing := 0; return new; end if;
      if new.owner is distinct from old.owner or new.executor is distinct from old.executor
         or new.claimed_by is distinct from old.claimed_by then
        new.fencing := old.fencing + 1;
      else
        new.fencing := old.fencing;
      end if;
      return new;
    end $$;
    create trigger tasks_bump_fencing before insert or update on public.tasks
      for each row execute function public.tasks_bump_fencing();
  `);
}, 60_000);
afterAll(() => t.close());
beforeEach(async () => {
  await t.pg.exec('truncate public.tasks, public.repos cascade');
  await t.pg.exec("insert into public.repos (owner, name) values ('owner', 'app')");
});

const row = async () =>
  (
    await t.pg.query<{
      owner: string;
      state: string;
      executor: string;
      fencing: string;
      doing: string | null;
      requested_by: string;
    }>(
      'select owner, state, executor, fencing::text, doing, requested_by from public.tasks where issue_number = 7',
    )
  ).rows[0];

const seed = (cols: string) =>
  t.pg.exec(
    `insert into public.tasks (repo_id, issue_number, title, raw_request, requested_by, priority${cols ? `, ${cols.split('|')[0]}` : ''})
     select id, 7, 't', 't', 'u', 1${cols ? `, ${cols.split('|')[1]}` : ''} from public.repos`,
  );

describe('acquireTask', () => {
  it('没有行：插一行，owner = harness，仓名大小写不计', async () => {
    const got = await acquireTask(t.db, ref, '改一行');
    expect(got).toMatchObject({ ok: true, created: true, fencing: 0 });
    expect(await row()).toMatchObject({ owner: 'harness', state: 'running', requested_by: 'harness' });
  });

  it('旧引擎还没开始的行（queued、归引擎）：改成 harness，令牌加一；再认领是幂等的，回同一个令牌', async () => {
    await seed('');
    const got = await acquireTask(t.db, ref, 't');
    expect(got).toMatchObject({ ok: true, created: false, fencing: 1 });
    expect(await acquireTask(t.db, ref, 't')).toMatchObject({ ok: true, fencing: 1 });
    expect(await currentFencing(t.db, ref)).toBe(1);
  });

  it.each([
    ['旧引擎在做', "state|'running'"],
    ['本机领着', "executor, state|'local', 'running'"],
    ['停下等人', "state|'stopped'"],
  ])('%s：不抢，回 held，行不变', async (_name, cols) => {
    const [names, values] = cols.split('|') as [string, string];
    await t.pg.exec(
      `insert into public.tasks (repo_id, issue_number, title, raw_request, requested_by, priority, ${names})
       select id, 7, 't', 't', 'u', 1, ${values} from public.repos`,
    );
    const before = await row();
    const got = await acquireTask(t.db, ref, 't');
    expect(got).toMatchObject({ ok: false, code: 'held' });
    expect(await row()).toEqual(before);
  });

  it('仓旧库里没有：回 unknown_repo', async () => {
    expect(await acquireTask(t.db, { repo: 'nobody/none', issue: 1 }, 't')).toMatchObject({
      ok: false,
      code: 'unknown_repo',
    });
  });
});

describe('currentFencing / releaseTask', () => {
  it('归新内核的回令牌；放回旧系统后令牌加一，旧令牌的外部动作对不上', async () => {
    await acquireTask(t.db, ref, 't');
    expect(await currentFencing(t.db, ref)).toBe(0);
    expect(await releaseTask(t.db, ref, 0, { state: 'queued', doing: '切回' })).toBe(true);
    expect(await row()).toMatchObject({ owner: 'v1', state: 'queued', doing: '切回', fencing: '1' });
    // 不归新内核了：回一个永远对不上的数
    expect(await currentFencing(t.db, ref)).toBe(-1);
  });

  it('令牌对不上不放（别人先动过）', async () => {
    await acquireTask(t.db, ref, 't');
    expect(await releaseTask(t.db, ref, 99, { state: 'queued', doing: 'x' })).toBe(false);
    expect((await row())?.owner).toBe('harness');
  });

  it('行不存在读不到令牌：抛错，不当成对得上', async () => {
    await expect(currentFencing(t.db, ref)).rejects.toThrow('读不到令牌');
    await expect(currentFencing(t.db, { repo: 'x/y', issue: 1 })).rejects.toThrow('没有仓');
  });
});
