// 给已经在跑的执行会话发后续消息：node send.mjs --to <会话key> --file <消息文件> [--report-to <指挥会话key>]
// 每条后续消息都自动追加「回报，必做」：只靠开场交代里的那一段，会话做完第二件事时会忘（11-16 #33 做完没回报）。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  callAtom,
  hostPort,
  mirasimServer,
  REPORT_TO_HOWTO,
  readCommanderRecords,
  realExec,
  reportFooter,
  resolveReportTo,
  Stop,
} from './dispatch.mjs';

export const USAGE = `用法：node send.mjs --to <会话key> --file <消息文件> [--report-to <指挥会话key>] [--port <端口>]
把消息文件的内容连同「回报，必做」一起发给一个在跑或已收轮的执行会话。
回报去向：--report-to，否则环境变量 MIRASIM_SESSION_KEY，再否则和 dispatch.mjs 一样猜指挥会话。`;

/**
 * @param {string[]} argv
 * @param {{ exec?: typeof realExec, env?: NodeJS.ProcessEnv, server?: string, records?: unknown[], readFile?: (p: string) => string, log?: (s: string) => void, now?: number }} [io]
 * @returns {number}
 */
export function sendRun(argv, io = {}) {
  const env = io.env ?? process.env;
  const log = io.log ?? ((s) => console.log(s));
  try {
    /** @type {Record<string, string>} */
    const a = {};
    for (let i = 0; i < argv.length; i++) {
      const k = argv[i];
      if (k?.startsWith('--')) a[k.slice(2)] = argv[++i] ?? '';
    }
    if (!a.to || !a.file) throw new Stop('参数', USAGE, 2);
    const reportTo = resolveReportTo(a['report-to'], env, () => io.records ?? readCommanderRecords(env));
    if (!reportTo) throw new Stop('发送', `找不到指挥会话。${REPORT_TO_HOWTO}；这次不发`, 2);
    const body = (io.readFile ?? ((p) => readFileSync(p, 'utf8')))(a.file);
    const server = io.server ?? mirasimServer(env);
    const port = hostPort(env, a.port);
    const res = callAtom(
      io.exec ?? realExec,
      process.execPath,
      server,
      port,
      'prompt',
      {
        clientRef: `s-${io.now ?? Date.now()}`,
        sessionKey: a.to,
        prompt: `${body}${reportFooter(reportTo)}`,
      },
      env,
    );
    if (res && res.ok === false) throw new Stop('发送', `prompt 没成：${JSON.stringify(res).slice(0, 300)}`);
    const accepted = res?.frames?.filter((frame) => frame.type === 'accepted');
    if (
      accepted?.length !== 1 ||
      accepted[0].sessionKey !== a.to ||
      typeof accepted[0].clientRef !== 'string' ||
      !accepted[0].clientRef.trim()
    ) {
      throw new Stop('发送结果', '宿主接受回执缺失或不符；消息可能已发送，不要重发，先查目标会话和队列', 2);
    }
    const receipt = accepted[0];
    log(
      JSON.stringify({
        sessionKey: receipt.sessionKey,
        clientRef: receipt.clientRef,
        taskId: receipt.taskId ?? null,
      }),
    );
    return 0;
  } catch (e) {
    if (e instanceof Stop) {
      console.error(e.message);
      return e.code;
    }
    throw e;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  process.exit(sendRun(process.argv.slice(2)));
