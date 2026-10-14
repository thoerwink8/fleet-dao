// pnpm work claim|renew|done <单号>（= node packages/conventions/src/bin/work.ts）：本机领单、续租、结束（决定 0096）。判法、退出码见 ../work.ts。
import { fileURLToPath } from 'node:url';
import { ghRunner } from '../issue-new.ts';
import { liveClaimsPost, readClaimsEndpoint, work } from '../work.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

process.exitCode = await work(process.argv.slice(2), {
  gh: ghRunner(root),
  post: liveClaimsPost(() => readClaimsEndpoint()),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
