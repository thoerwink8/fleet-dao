import { userInfo } from 'node:os';
import type { Db } from '@fleet-dao/db';
import { acceptanceDutyState } from '@fleet-dao/shared';

export const ACCEPTANCE_USAGE =
  '用法：fleet-api acceptance status <owner/仓> <单号> | fleet-api acceptance settle <owner/仓> <单号> --id <责任号> --generation <代次> --pr <PR号，协调责任为0> --head <SHA，协调责任为-> --evidence "验收证据" | fleet-api acceptance supersede <owner/仓> <单号> --id <旧责任号> --generation <代次> --pr <PR号> --head <旧头SHA> --target-id <最终责任号> --target-generation <代次> --target-pr <PR号> --target-head <最终头SHA> --evidence "替代依据"';

const FLAGS = {
  settle: ['--id', '--generation', '--pr', '--head', '--evidence'],
  supersede: [
    '--id',
    '--generation',
    '--pr',
    '--head',
    '--target-id',
    '--target-generation',
    '--target-pr',
    '--target-head',
    '--evidence',
  ],
} as const;

export function parseAcceptanceArgs(args: readonly string[]) {
  const [action, repo, issue, ...rest] = args;
  if (
    (action !== 'status' && action !== 'settle' && action !== 'supersede') ||
    !repo ||
    !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) ||
    !issue ||
    !Number.isSafeInteger(Number(issue)) ||
    !/^[1-9]\d*$/.test(issue)
  )
    throw new Error(ACCEPTANCE_USAGE);
  if (action === 'status') {
    if (rest.length) throw new Error(ACCEPTANCE_USAGE);
    return { action, repo, issueNumber: Number(issue) } as const;
  }
  const allowed: readonly string[] = FLAGS[action];
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key || !allowed.includes(key) || value === undefined || Object.hasOwn(values, key))
      throw new Error(ACCEPTANCE_USAGE);
    values[key] = value;
  }
  const positive = (key: string, zero = false) => {
    const value = values[key] ?? '';
    const n = Number(value);
    if (!(zero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(value) || !Number.isSafeInteger(n))
      throw new Error(ACCEPTANCE_USAGE);
    return n;
  };
  const evidence = values['--evidence']?.trim();
  if (!evidence) throw new Error(ACCEPTANCE_USAGE);
  const issueNumber = Number(issue);
  if (action === 'supersede') {
    const sha = (key: string) => {
      const value = values[key] ?? '';
      if (!/^[a-f0-9]{40}$/.test(value)) throw new Error(ACCEPTANCE_USAGE);
      return value;
    };
    return {
      action,
      repo,
      issueNumber,
      source: {
        id: positive('--id'),
        generation: positive('--generation'),
        repo,
        issueNumber,
        prNumber: positive('--pr'),
        head: sha('--head'),
      },
      target: {
        id: positive('--target-id'),
        generation: positive('--target-generation'),
        repo,
        issueNumber,
        prNumber: positive('--target-pr'),
        head: sha('--target-head'),
      },
      evidence,
    } as const;
  }
  const prNumber = positive('--pr', true);
  const head = values['--head'];
  if (!head || (prNumber ? !/^[a-f0-9]{40}$/.test(head) : head !== '-')) throw new Error(ACCEPTANCE_USAGE);
  return {
    action,
    repo,
    issueNumber,
    id: positive('--id'),
    generation: positive('--generation'),
    prNumber,
    head: head === '-' ? '' : head,
    evidence,
  } as const;
}

export async function runAcceptance(args: readonly string[], db: Db, now: Date) {
  const input = parseAcceptanceArgs(args);
  const { readAcceptanceDutyRows, settleAcceptanceDuty, supersedeAcceptanceDuty } = await import(
    '@fleet-dao/db'
  );
  const by = `ops:acceptance:${userInfo().username}`;
  if (input.action === 'status') {
    const rows = await readAcceptanceDutyRows(db, input);
    return rows.map((r) => ({ ...r, state: acceptanceDutyState(r, rows) }));
  }
  if (input.action === 'supersede')
    return supersedeAcceptanceDuty(
      db,
      { source: input.source, target: input.target, by, evidence: input.evidence },
      now,
    );
  const { action: _, ...identity } = input;
  return settleAcceptanceDuty(db, { ...identity, by }, now);
}
