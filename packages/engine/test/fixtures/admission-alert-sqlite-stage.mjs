// 仅隔离测试：在真实SQLite语句边界停住，用父SIGKILL打断产品函数；不伪造任何COMMIT成功。
import { DatabaseSync } from 'node:sqlite';
import { admissionAlertKey } from '@fleet-dao/db';
import { recordAdmissionAlert, transferOneAdmissionAlert } from '../../src/real/admission-alert-spool.ts';

let request;
process.once('message', async (r) => {
  request = r;
  const original = DatabaseSync.prototype.exec;
  let writeTransaction = false;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === 'BEGIN IMMEDIATE') writeTransaction = true;
    if (sql === 'BEGIN') writeTransaction = false;
    if (
      (request.stage === 'before-commit' && sql === 'COMMIT' && writeTransaction) ||
      (request.stage === 'before-begin' && sql === 'BEGIN IMMEDIATE')
    ) {
      // IPC回调是异步的；这里先报stage，再同步停住，保证不执行目标语句。
      process.send({ stage: request.stage });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    const result = original.call(this, sql);
    if (
      (request.stage === 'after-schema' && sql.startsWith('CREATE TABLE pending')) ||
      (request.stage === 'after-version' && sql.startsWith('PRAGMA application_id=')) ||
      (request.stage === 'after-commit' && sql === 'COMMIT' && writeTransaction)
    ) {
      process.send({ stage: request.stage });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return result;
  };
  const result =
    request.operation === 'transferOne'
      ? await transferOneAdmissionAlert(request.path, request.databaseUrl, performance.now() + 30000)
      : recordAdmissionAlert(request.path, request.observation);
  process.send({ result, key: request.observation && admissionAlertKey(request.observation.identity) });
  process.disconnect();
});
