// 总轮数到顶交还本机（#3603，task-contract.ts 的 HandBackLocalInput）：在单子上留一句话，再贴「本机做」。
// 先留言后贴标签（和拉单的 holdForLocal 同一个次序）：留言没成就不贴，下次整件事重来；标签没成，下次留言按键幂等、只重贴标签。
// 哪一步没成都抛，工作流记下没贴上，照旧停下等人，不装作贴过。

import { LOCAL_LABEL } from '@fleet-dao/conventions';
import type { GitHub } from '@fleet-dao/github';
import type { PortContext } from '../ports.ts';
import { PortError } from '../ports.ts';
import type { HandBackLocalInput, HandBackLocalResult } from '../task-contract.ts';

export function createHandBackLocal(
  gh: Pick<GitHub, 'commentIssue' | 'addIssueLabel'>,
): (input: HandBackLocalInput, ctx: PortContext) => Promise<HandBackLocalResult> {
  return async (input) => {
    if (
      input?.schemaVersion !== 1 ||
      !input.repo?.owner ||
      !input.repo?.name ||
      !Number.isSafeInteger(input.issueNumber) ||
      input.issueNumber <= 0 ||
      typeof input.key !== 'string' ||
      input.key.trim() === '' ||
      typeof input.body !== 'string' ||
      input.body.trim() === ''
    ) {
      throw new PortError('INVALID_INPUT', '交还本机：要有仓、单号、留言的键和正文', { retryable: false });
    }
    const repo = { owner: input.repo.owner, name: input.repo.name };
    const posted = await gh.commentIssue({
      repo,
      issueNumber: input.issueNumber,
      key: input.key,
      body: input.body,
    });
    await gh.addIssueLabel({ repo, issueNumber: input.issueNumber, label: LOCAL_LABEL });
    return { commented: posted.created };
  };
}
