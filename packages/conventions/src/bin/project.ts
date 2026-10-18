// pnpm project add|check <owner/仓>（= node packages/conventions/src/bin/project.ts）：加新项目一条命令做到底。判法、八步见 ../project.ts。
// 退出码：0 全绿；1 有没过的项（add 停在那一步，接活不开）；2 参数不对或没查成。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ghRunner } from '../issue-new.ts';
import {
  type AppInstallConfig,
  PROJECT_USAGE,
  parseProjectArgv,
  projectAdd,
  projectCheck,
} from '../project.ts';
import { franceSshHost, ghProjectWorld, sshFleetApi } from '../project-world.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseProjectArgv>;
  try {
    parsed = parseProjectArgv(process.argv.slice(2));
  } catch {
    console.error(PROJECT_USAGE);
    return 2;
  }
  const gh = ghRunner(root);
  const me = await gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  const standardRepo = me.stdout.trim();
  if (me.code !== 0 || !/^[\w.-]+\/[\w.-]+$/.test(standardRepo)) {
    console.error(`读不到本仓（标准仓）是哪个：${(me.stderr || me.stdout).trim()}`);
    return 2;
  }
  const apps = JSON.parse(
    readFileSync(new URL('../../github-apps.json', import.meta.url), 'utf8'),
  ) as AppInstallConfig;
  const ctx = {
    world: ghProjectWorld(
      gh,
      sshFleetApi(() => franceSshHost()),
    ),
    standardRepo,
    apps,
    out: (line: string) => console.log(line),
  };
  const r =
    parsed.action === 'add' ? await projectAdd(ctx, parsed.slug) : await projectCheck(ctx, parsed.slug);
  return r.code;
}

process.exitCode = await main();
