// 飞书群聊理成的「意图」那几张表（db/schema/intents.ts）取值的写法。飞书收缩后（#2047 F1，决定 0090）群聊、私聊不再生成意图，
// 香港飞书网关、后端接口、`fleet-api intent` 命令和本机 `pnpm intents` 随决定 0093 都已删；表和已有数据留着（删表属删数据，
// 要创始人点头），这里只留表的列取值要对齐的三个枚举。
import { z } from 'zod';

export const IntentChatKindSchema = z.enum(['p2p', 'group']);
/** event：飞书推来的事件；backfill：网关补漏时翻飞书历史补送的。 */
export const IntentMessageSourceSchema = z.enum(['event', 'backfill']);
/** new 还没用过；linked 开成或并进了单；dropped 放下了（带理由）。 */
export const IntentStatusSchema = z.enum(['new', 'linked', 'dropped']);
