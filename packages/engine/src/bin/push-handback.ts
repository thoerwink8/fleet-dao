// 私有运维入口：默认只读；真正交还必须显式 --execute。check 报告不作 execute 准入凭据。
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import { type PushHandbackRequest, pushHandbackPayload } from '../push-handback.ts';
import { requestPushHandback } from '../push-handback-client.ts';
import { configFromEnv } from '../worker.ts';

export async function runPermissionPushHandback(args: string[]): Promise<number> {
  const flags = new Map<string, string>();
  let execute = false,
    check = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--execute') {
      if (execute) throw new Error('duplicate_execute');
      execute = true;
      continue;
    }
    if (key === '--check') {
      if (check) throw new Error('duplicate_check');
      check = true;
      continue;
    }
    if (
      !['--workflow-id', '--run-id', '--request-id', '--feedback-file', '--by'].includes(key) ||
      flags.has(key) ||
      !args[i + 1] ||
      args[i + 1]!.startsWith('--')
    )
      throw new Error('invalid_arguments');
    flags.set(key, args[++i]!);
  }
  const workflowId = flags.get('--workflow-id'),
    runId = flags.get('--run-id');
  if (
    !workflowId ||
    !runId ||
    (execute && check) ||
    (!execute && ['--request-id', '--feedback-file', '--by'].some((k) => flags.has(k)))
  )
    throw new Error('invalid_mode_or_identity');
  const signal = AbortSignal.timeout(execute ? 420_000 : 230_000);
  if (!execute) {
    const { realPortsFromEnv } = await import('../real/index.ts');
    const real = realPortsFromEnv();
    try {
      const result = await real.checkPushHandback(workflowId, runId, signal);
      console.log(JSON.stringify({ version: 1, mode: 'check', ...result }));
      return result.outcome === 'natural-retired' ? 0 : 2;
    } finally {
      await real.close();
    }
  }
  const fileName = flags.get('--feedback-file'),
    by = flags.get('--by'),
    requestId = flags.get('--request-id');
  if (!fileName || !by || !requestId) throw new Error('execute_requires_request_feedback_by');
  const file = await open(fileName, constants.O_RDONLY | constants.O_NOFOLLOW);
  let feedback: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('feedback_limit');
    const buffer = Buffer.alloc(64 * 1024 + 1),
      read = await file.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead !== stat.size) throw new Error('feedback_changed');
    feedback = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, read.bytesRead));
  } finally {
    await file.close();
  }
  const config = configFromEnv();
  const connection = await Connection.connect({
    address: config.address,
    interceptors: [],
    channelArgs: { 'grpc.max_receive_message_length': 2 * 1024 * 1024 },
  });
  try {
    const h = new Client({ connection, namespace: config.namespace }).workflow.getHandle(workflowId, runId);
    // 本协议只支持首次自然 hold；固定输入可在断线后逐字重试，不依赖已被消费的 query。
    // 服务端仍重读全部证据并核 token；这里不把 check 报告当成 bearer 凭据。
    const request: PushHandbackRequest = {
      version: 1,
      requestId,
      by,
      feedback,
      token: { version: 1, runId, kind: 'parked', generation: 1, continued: 0 },
    };
    pushHandbackPayload(request);
    const receipt = await connection.withAbortSignal(signal, () =>
      connection.withDeadline(Date.now() + 410_000, () => requestPushHandback(h, request)),
    );
    console.log(
      JSON.stringify({
        version: 1,
        mode: 'execute',
        requestId: receipt.requestId,
        outcome: receipt.outcome,
        ...(receipt.code ? { code: receipt.code } : {}),
      }),
    );
    return receipt.outcome === 'handed_back' ? 0 : 2;
  } finally {
    await connection.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runPermissionPushHandback(process.argv.slice(2));
  } catch {
    console.error(JSON.stringify({ version: 1, outcome: 'unknown', code: 'command_failed' }));
    process.exitCode = 2;
  }
}
