// 影子启动自检（讨论稿第五节 3，#3775 验收）：三样缺一不起。每样是三态，查不了（unknown）按没过算，不当成没事。
// 1. 只读探测：工人身份对 GitHub 没有写权限（没有推送凭据、推送被拒）；
// 2. outbox 的真实处理器没有装配：影子只记「本来会做」；
// 3. 影子用户的出网规则在：默认拒，只放模型服务。

export type ProbeResult = 'pass' | 'fail' | 'unknown';

export interface ShadowProbes {
  noWriteAccess(): Promise<ProbeResult>;
  realHandlersAbsent(): Promise<ProbeResult>;
  egressRulesPresent(): Promise<ProbeResult>;
}

const NAMES: Record<keyof ShadowProbes, string> = {
  noWriteAccess: '只读探测（工人对 GitHub 没有写权限）',
  realHandlersAbsent: 'outbox 真实处理器未装配',
  egressRulesPresent: '影子用户出网规则在',
};

export type SelfCheck = { ok: true } | { ok: false; why: string[] };

export async function shadowSelfCheck(probes: ShadowProbes): Promise<SelfCheck> {
  const why: string[] = [];
  for (const key of Object.keys(NAMES) as (keyof ShadowProbes)[]) {
    let r: ProbeResult;
    try {
      r = await probes[key]();
    } catch (err) {
      r = 'unknown';
      why.push(`${NAMES[key]}：没查成（${err instanceof Error ? err.message : String(err)}）`);
      continue;
    }
    if (r === 'fail') why.push(`${NAMES[key]}：没过`);
    else if (r === 'unknown') why.push(`${NAMES[key]}：没查成`);
  }
  return why.length ? { ok: false, why } : { ok: true };
}

export class ShadowSelfCheckError extends Error {
  constructor(why: string[]) {
    super(`影子自检没过，不起工人：${why.join('；')}`);
    this.name = 'ShadowSelfCheckError';
  }
}
