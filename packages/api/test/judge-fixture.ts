// judge 项测试共用：一台机器的 /etc/fleet-dao（配置文件、钥匙文件）、照仓里样例装的目录（判断阶段排第一的是 TypeSafe 那条）、
// 不出网的假后端、往判断记录里记一次调用。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, loadCatalog, parseCatalog, seed } from '@fleet-dao/db';
import {
  type BackendResult,
  createJev,
  ERROR_NEXT,
  type JevBackend,
  type JevConfigLocation,
} from '@fleet-dao/jev';

export const JUDGE_MODEL = 'jev-1.13.0';
export const JUDGE_ROUTE = 'jev:jev-1.13:api-shell';
const repoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const EXAMPLE = 'deploy/examples/catalog.example.json';

export async function judgeCatalog(db: Db): Promise<void> {
  await seed(db);
  await loadCatalog(db, parseCatalog(repoFile(EXAMPLE), EXAMPLE));
}

/** 一台配好了判断题的机器；用完调 cleanup。 */
export function judgeMachine(): { location: JevConfigLocation; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-api-judge-'));
  const keyFile = join(dir, 'typesafe.key');
  writeFileSync(keyFile, 'k-api-test\n');
  const path = join(dir, 'jev.json');
  writeFileSync(path, JSON.stringify({ typesafe: { endpoint: 'https://jev.example.invalid/v1', keyFile } }));
  return {
    location: { path, explicit: false },
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function fakeJudgeBackend(result: BackendResult): JevBackend {
  return { kind: 'fake', model: JUDGE_MODEL, ask: async () => result };
}

/** 测试里不出网：路由对了就交一个答得上的假后端。 */
export const makeFakeBackend = async (): Promise<JevBackend> =>
  fakeJudgeBackend({
    ok: true,
    answers: { 'error-next': { option: 'retry', confidence: 0.9 } },
    model: JUDGE_MODEL,
    latencyMs: 5,
    inputTokens: 100,
    tokensEstimated: false,
  });

/** 在判断记录里记一次真调用（引擎的错误分流那道题）。 */
export async function recordJudgeCall(db: Db, result: BackendResult): Promise<void> {
  await createJev({ db, backend: fakeJudgeBackend(result), route: JUDGE_ROUTE }).ask(
    ERROR_NEXT,
    { step: '任务 t1 的 execute 阶段（会话失败）', message: 'socket hang up' },
    { subject: 'run:r1' },
  );
}
