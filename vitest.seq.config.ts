// 实验（不合并）：和 vitest.config.ts 一样，只多一个按耗时表排序的 sequencer。
import { mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';
import TimingsSequencer from './vitest.sequencer.ts';

export default mergeConfig(base, { test: { sequence: { sequencer: TimingsSequencer } } });
