import { createHash } from 'node:crypto';
import type { WorkflowHandle } from '@temporalio/client';
import { type PushHandbackReceipt, type PushHandbackRequest, pushHandbackPayload } from './push-handback.ts';

/** 异文使用不同 transport ID，使服务器去重不能吞掉业务冲突核验。 */
export async function requestPushHandback(
  handle: Pick<WorkflowHandle, 'executeUpdate'>,
  request: PushHandbackRequest,
): Promise<PushHandbackReceipt> {
  const payload = pushHandbackPayload(request);
  const updateId = `push-handback:${request.requestId}:${createHash('sha256').update(payload).digest('hex')}`;
  const receipt = await handle.executeUpdate<PushHandbackReceipt, [PushHandbackRequest]>(
    'taskHandbackPermissionPush',
    { updateId, args: [request] },
  );
  if (receipt?.version !== 1 || receipt.requestId !== request.requestId || receipt.payload !== payload)
    throw new Error('PUSH_HANDBACK_RECEIPT_MISMATCH');
  return receipt;
}
