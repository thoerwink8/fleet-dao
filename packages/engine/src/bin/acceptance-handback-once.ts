// fleet-api acceptance-handback-once 的本体（#3630；法国上经 packages/api/bin/fleet-api 转过来，换成 fleet 身份、带 api.env 跑）：
//   node packages/engine/src/bin/acceptance-handback-once.ts [--apply]
// 一次性把还开着的旧验收责任交回原单（jobs/acceptance-handback-once.ts）：留言、贴「本机做」、行标成已交回。默认只读。
// 退出码：0 做完了（或只读列完）；1 有没做成的；2 参数不对（不连库）。
import { LOCAL_LABEL } from '@fleet-dao/conventions';
import { createDb, type Db, handBackAcceptanceDuty, listOpenAcceptanceDuties } from '@fleet-dao/db';
import { createGitHub, type GitHub } from '@fleet-dao/github';
import { pgLedger, pgLocker } from '@fleet-dao/store';
import { runAcceptanceHandbackOnce } from '../jobs/acceptance-handback-once.ts';

const refOf = (repo: string) => {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`仓名认不出：${repo}`);
  return { owner, name };
};

let opened: { db: Db; close(): Promise<void> } | undefined;
let gh: GitHub | undefined;
const db = () => {
  opened ??= createDb({ env: process.env });
  return opened.db;
};
const github = () => {
  gh ??= createGitHub({ ledger: pgLedger(db()), locker: pgLocker(db()) });
  return gh;
};

try {
  process.exitCode = await runAcceptanceHandbackOnce(process.argv.slice(2), {
    openDuties: () => listOpenAcceptanceDuties(db()),
    async comment({ repo, issueNumber, key, body }) {
      const r = await github().commentIssue({ repo: refOf(repo), issueNumber, key, body });
      return { url: r.url };
    },
    async label({ repo, issueNumber }) {
      await github().addIssueLabel({ repo: refOf(repo), issueNumber, label: LOCAL_LABEL });
    },
    markHandedBack: (input, at) => handBackAcceptanceDuty(db(), input, at),
    now: () => new Date(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
} finally {
  await opened?.close();
}
