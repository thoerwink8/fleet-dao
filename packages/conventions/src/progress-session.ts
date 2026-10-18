import { DirectiveRefused } from './directives.ts';

const hooks = (await import(new URL('../../../agents/hooks/unattended.mjs', import.meta.url).href)) as {
  selectSessionId(
    env: Record<string, string | undefined>,
  ): { ok: true; id: string } | { ok: false; missing?: boolean };
};
/** 和同步Stop认同一个来源；坏的高优先级来源不借其他会话号。 */
export function progressSessionId(env: Record<string, string | undefined>): string | null {
  const selected = hooks.selectSessionId(env);
  if (selected.ok) return selected.id;
  if (selected.missing) return null;
  throw new DirectiveRefused('本会话号无效，未借其他会话，未记录原话。');
}
