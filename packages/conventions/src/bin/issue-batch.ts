import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type BatchSpec, issueBatchNew, recoverIssueBatch } from '../issue-batch.ts';
import { ghRunner } from '../issue-new.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
try {
  const { values } = parseArgs({
    options: { spec: { type: 'string' }, recover: { type: 'string' } },
    strict: true,
  });
  if (Boolean(values.spec) === Boolean(values.recover))
    throw new Error('用法：pnpm issue:batch --spec <JSON文件> 或 --recover <恢复记录>');
  const cwd = process.env.INIT_CWD || process.cwd();
  const deps = { cwd, gh: ghRunner(root) };
  if (values.recover) {
    await recoverIssueBatch(resolve(cwd, values.recover), deps);
    console.log('本批失败产物已撤销。');
  } else {
    const spec = JSON.parse(readFileSync(resolve(cwd, values.spec ?? ''), 'utf8')) as BatchSpec;
    console.log(JSON.stringify(await issueBatchNew(spec, deps)));
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
