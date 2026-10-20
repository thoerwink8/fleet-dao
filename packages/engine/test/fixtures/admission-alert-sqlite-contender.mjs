// 只隔离SQLite多进程竞争：先加载真实产品模块，ready之后才由父统一放行。
import { recordAdmissionAlert } from '../../src/real/admission-alert-spool.ts';

process.umask(0o077);
process.once('message', ({ path, observation }) => {
  const result = recordAdmissionAlert(path, observation);
  process.send({ result }, () => process.disconnect());
});
process.send({ ready: true });
