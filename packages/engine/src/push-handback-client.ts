import { createHash } from 'node:crypto';
import type { WorkflowHandle } from '@temporalio/client';
import {
  type PushHandbackReceipt,
  type PushHandbackRequest,
  pushHandbackPayload,
  validHandbackContract,
} from './push-handback.ts';

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
  if (
    receipt?.version !== request.version ||
    receipt.requestId !== request.requestId ||
    receipt.payload !== payload
  )
    throw new Error('PUSH_HANDBACK_RECEIPT_MISMATCH');
  if (
    request.version === 2 &&
    ((receipt.outcome === 'handed_back' && !receipt.acceptedContract) ||
      (receipt.acceptedContract !== undefined &&
        (!validHandbackContract(receipt.acceptedContract) ||
          receipt.acceptedContract.sha256 !== request.expectedContract.sha256)))
  )
    throw new Error('PUSH_HANDBACK_RECEIPT_MISMATCH');
  return receipt;
}
