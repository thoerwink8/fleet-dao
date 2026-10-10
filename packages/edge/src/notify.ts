// 飞书群机器人发一条文本。地址由调用方从 Worker 的 secret 读来，这里不写死域名或密钥。
// 没配、地址不认、飞书没回 code 0：抛。抛出的话里不带地址。调用方把这一轮记成没查成，不许当成推过。

const ALLOWED_PREFIXES = [
  'https://open.feishu.cn/open-apis/bot/v2/hook/',
  'https://open.larksuite.com/open-apis/bot/v2/hook/',
];

function hide(text: string, secret: string): string {
  return secret ? text.split(secret).join('（地址已隐去）') : text;
}

/** 空的算没配。认不出的地址抛「地址不认」，话里不带原文。 */
export function feishuWebhookUrl(raw: string | undefined): string {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (url === '') throw new Error('飞书推送没配：读不到密钥');
  const prefix = ALLOWED_PREFIXES.find((p) => url.startsWith(p));
  if (!prefix || url.length <= prefix.length || /\s/.test(url)) {
    throw new Error('飞书推送的地址不认');
  }
  return url;
}

export async function pushFeishu(webhook: string, text: string, fetchImpl: typeof fetch): Promise<void> {
  const url = feishuWebhookUrl(webhook);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(hide(`飞书没推成：${why}`, url));
  }
  const raw = await res.text();
  let code: unknown;
  try {
    const body = JSON.parse(raw) as { code?: unknown; StatusCode?: unknown };
    code = body.code ?? body.StatusCode;
  } catch {
    code = undefined;
  }
  if (res.ok && code === 0) return;
  throw new Error(`飞书没推成：HTTP ${res.status}，code=${String(code)}`);
}
