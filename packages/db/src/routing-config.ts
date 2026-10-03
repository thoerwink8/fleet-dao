// 路由两层的默认配置（packages/db/routing.default.json，进仓）：每个用途的模型顺序、每个模型的路由顺序（#574）。
// 读不到、不是 JSON、格式认不出、引用对不上都明确报错，不拿空配置或旧配置冒充（通用段底线第三条）。
// 这里只管读和校验；发布时只补缺写进库是 routing-apply.ts（deploy/release.sh 的 load_routing），选路读库里那两张表。
import { readFile } from 'node:fs/promises';
import { SESSION_EFFORTS } from '@fleet-dao/shared';
import { z } from 'zod';
import { STAGE_KINDS } from './schema/enums.ts';

export const ROUTING_DEFAULT_PATH = new URL('../routing.default.json', import.meta.url);

const Id = z.string().trim().min(1);

export const RoutingConfigSchema = z.strictObject({
  /** default 给没单列的用途用；单列的用途整串替换 default。 */
  purposes: z
    .partialRecord(z.enum(['default', ...STAGE_KINDS]), z.array(Id).min(1))
    .refine((p) => Object.keys(p).length > 0, '至少要有 default 或某个用途的模型顺序'),
  /**
   * 模型 → 路由顺序；enabled 是调度台上的开关（关着的照样挂着，不派）。effort 是这条路由的思考档位（#470），不写 = 没配
   * （起会话用 high）；这条路由的执行方式认不认这一档，装进库时对着库里的路由判（routing-apply.ts）。
   */
  models: z
    .record(
      Id,
      z
        .array(
          z.strictObject({
            routeId: Id,
            enabled: z.boolean(),
            effort: z
              .enum(SESSION_EFFORTS, { error: `思考档位只有 ${SESSION_EFFORTS.join(' / ')}` })
              .optional(),
          }),
        )
        .min(1),
    )
    .refine((m) => Object.keys(m).length > 0, '至少要有一个模型'),
});

export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

export class RoutingConfigError extends Error {
  readonly problems: string[];
  constructor(title: string, problems: string[]) {
    super([title, ...problems.map((p) => `- ${p}`)].join('\n'));
    this.name = 'RoutingConfigError';
    this.problems = problems;
  }
}

/** 以 _ 开头的键是注释（例如 _说明），校验前去掉；其余键写错了照样报错。 */
function stripComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith('_'))
        .map(([key, v]) => [key, stripComments(v)]),
    );
  }
  return value;
}

const dupes = (xs: readonly string[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];

/** 文本 → 配置；`source` 只用在报错里说是哪个文件。 */
export function parseRoutingConfig(text: string, source = 'routing.default.json'): RoutingConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new RoutingConfigError(`${source} 不是合法的 JSON`, [(err as Error).message]);
  }
  const parsed = RoutingConfigSchema.safeParse(stripComments(raw));
  if (!parsed.success) {
    throw new RoutingConfigError(
      `${source} 格式不对`,
      parsed.error.issues.map((i) => `${i.path.join('.') || '(根)'}：${i.message}`),
    );
  }
  const cfg = parsed.data;
  const problems: string[] = [];
  for (const [purpose, models] of Object.entries(cfg.purposes)) {
    for (const d of dupes(models)) problems.push(`用途 ${purpose} 里模型 ${d} 写了不止一次`);
    for (const m of models) {
      if (!(m in cfg.models)) problems.push(`用途 ${purpose} 里的模型 ${m} 在 models 里没有路由顺序`);
    }
  }
  const owner = new Map<string, string>();
  for (const [model, routes] of Object.entries(cfg.models)) {
    for (const d of dupes(routes.map((r) => r.routeId)))
      problems.push(`模型 ${model} 里路由 ${d} 写了不止一次`);
    for (const r of routes) {
      const seen = owner.get(r.routeId);
      if (seen !== undefined && seen !== model) {
        problems.push(`路由 ${r.routeId} 同时挂在模型 ${seen} 和 ${model} 下：一条路由只属于一个模型`);
      }
      owner.set(r.routeId, model);
    }
  }
  if (problems.length > 0) throw new RoutingConfigError(`${source} 里有对不上的地方`, problems);
  return cfg;
}

/** 读默认配置文件；读不到明确报错，不当成空配置。 */
export async function loadRoutingConfig(path: string | URL = ROUTING_DEFAULT_PATH): Promise<RoutingConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new RoutingConfigError(`读不到路由配置 ${String(path)}`, [(err as Error).message]);
  }
  return parseRoutingConfig(text, String(path));
}
