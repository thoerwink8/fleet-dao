export * from './schema.ts';
export * from './store.ts';

/** 迁移目录（发布时由部署脚本对 fleet2 跑；记账表在 fleet2.__migrations，不和旧库的混）。 */
export const MIGRATIONS_FOLDER = new URL('../migrations', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);
