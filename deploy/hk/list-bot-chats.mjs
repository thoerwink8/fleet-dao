// 列出飞书机器人所在的群：一行一个「chat_id<TAB>群名」。deploy/hk.sh 用它补 feishu.env 里的团队群（只在一个群里时才补）。
// 凭据从环境变量读（FEISHU_APP_ID、FEISHU_APP_SECRET），不上命令行、不打印。只读：不建群、不发消息。
// 退出码：0 列出来了（可能一个都没有），1 没列成（凭据不对、网络不通、飞书返回错误）——不把没列成当成「一个群都没有」。
const BASE = 'https://open.feishu.cn/open-apis';
const TIMEOUT_MS = 10_000;

async function call(path, init) {
  const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.json();
  if (body.code !== 0) throw new Error(`${path}：飞书返回 ${body.code} ${body.msg ?? ''}`.trim());
  return body;
}

try {
  const { FEISHU_APP_ID: appId, FEISHU_APP_SECRET: appSecret } = process.env;
  if (!appId || !appSecret) throw new Error('没给 FEISHU_APP_ID / FEISHU_APP_SECRET');
  const auth = await call('/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const headers = { authorization: `Bearer ${auth.tenant_access_token}` };
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) });
    const { data } = await call(`/im/v1/chats?${query}`, { headers });
    for (const chat of data?.items ?? []) {
      process.stdout.write(`${chat.chat_id}\t${String(chat.name ?? '').replace(/\s+/g, ' ')}\n`);
    }
    if (!data?.has_more) process.exit(0);
    pageToken = data.page_token;
  }
  throw new Error('群太多，翻了 20 页还没翻完');
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
