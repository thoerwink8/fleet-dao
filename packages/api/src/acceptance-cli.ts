import { userInfo } from 'node:os';
import type { Db } from '@fleet-dao/db';

export const ACCEPTANCE_USAGE =
  '用法：fleet-api acceptance status <owner/仓> <单号> | fleet-api acceptance settle <owner/仓> <单号> --id <责任号> --generation <代次> --pr <PR号，协调责任为0> --head <SHA，协调责任为-> --evidence "验收证据"';

export function parseAcceptanceArgs(args: readonly string[]) {
  const [action, repo, issue, ...rest] = args;
  if (
    (action !== 'status' && action !== 'settle') ||
    !repo ||
    !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) ||
    !issue ||
    !Number.isSafeInteger(Number(issue)) ||
    !/^[1-9]\d*$/.test(issue)
  )
    throw new Error(ACCEPTANCE_USAGE);
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (
      !key ||
      !['--id', '--generation', '--pr', '--head', '--evidence'].includes(key) ||
      value === undefined ||
      Object.hasOwn(values, key)
    )
      throw new Error(ACCEPTANCE_USAGE);
    values[key] = value;
  }
  if (action === 'status') {
    if (rest.length) throw new Error(ACCEPTANCE_USAGE);
    return { action, repo, issueNumber: Number(issue) } as const;
  }
  const positive = (key: string, zero = false) => {
    const value = values[key] ?? '';
    const n = Number(value);
    if (!(zero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(value) || !Number.isSafeInteger(n))
      throw new Error(ACCEPTANCE_USAGE);
    return n;
  };
  const prNumber = positive('--pr', true);
  const head = values['--head'];
  const evidence = values['--evidence']?.trim();
  if (!head || (prNumber ? !/^[a-f0-9]{40}$/.test(head) : head !== '-') || !evidence)
    throw new Error(ACCEPTANCE_USAGE);
  return {
    action,
    repo,
    issueNumber: Number(issue),
    id: positive('--id'),
    generation: positive('--generation'),
    prNumber,
    head: head === '-' ? '' : head,
    evidence,
  } as const;
}

export async function runAcceptance(args: readonly string[], db: Db, now: Date) {
  const input = parseAcceptanceArgs(args);
  const { readAcceptanceDutyRows, settleAcceptanceDuty } = await import('@fleet-dao/db');
  if (input.action === 'status') return readAcceptanceDutyRows(db, input);
  const { action: _, ...identity } = input;
  return settleAcceptanceDuty(db, { ...identity, by: `ops:acceptance:${userInfo().username}` }, now);
}
