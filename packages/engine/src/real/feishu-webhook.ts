// 群机器人 webhook 发一条文本（#954 整池暂停到期、#766 主线红：推一次、失败重试、地址不进日志）。
// 引擎环境变量 FLEET_FEISHU_WEBHOOK。没配、地址不认、推不出去都抛，调用方记没查成，不许当成推过。
// 不写进 deploy/france/desired-config.json：那是密钥，对账见到多出来的键会报警；法国 engine.env 由人放。
import { errMessage } from '@fleet-dao/shared/util';

export const FEISHU_WEBHOOK_ENV = 'FLEET_FEISHU_WEBHOOK';

const ALLOWED_PREFIXES = [
  'https://open.feishu.cn/open-apis/bot/v2/hook/',
  'https://open.larksuite.com/open-apis/bot/v2/hook/',
];

const hide = (text: string, secret: string): string =>
  secret ? text.split(secret).join('（地址已隐去）') : text;

/** 只收飞书 / Lark 群机器人的 webhook。认不出就抛，抛出的话里不带地址。 */
export function feishuWebhookUrl(raw: string | undefined): string {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (url === '') throw new Error(`飞书推送没配：引擎环境里没有 ${FEISHU_WEBHOOK_ENV}，这条推不出去`);
  const prefix = ALLOWED_PREFIXES.find((p) => url.startsWith(p));
  if (!prefix || url.length <= prefix.length || /\s/.test(url)) {
    throw new Error('飞书推送的地址不认（只收飞书、Lark 群机器人 webhook），这条推不出去');
  }
  return url;
}

export function feishuWebhookSender(
  opts: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): (text: string) => Promise<void> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  return async (text: string) => {
    const url = feishuWebhookUrl(env[FEISHU_WEBHOOK_ENV]);
    let last = '没推成';
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ msg_type: 'text', content: { text } }),
          signal: AbortSignal.timeout(8_000),
        });
        const raw = await res.text();
        let code: unknown;
        try {
          const body = JSON.parse(raw) as { code?: unknown; StatusCode?: unknown };
          code = body.code ?? body.StatusCode;
        } catch {
          code = undefined;
        }
        if (res.ok && code === 0) return;
        last = `飞书回了 HTTP ${res.status}，code=${String(code)}`;
      } catch (err) {
        last = hide(errMessage(err), url);
      }
      if (i < attempts) await sleep(200);
    }
    throw new Error(hide(`飞书推了 ${attempts} 次都没成：${last}`, url));
  };
}
