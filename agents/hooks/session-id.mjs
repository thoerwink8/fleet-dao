// 原生会话号的纯校验，不读取或写入会话状态。
/** @param {unknown} id @returns {string|null} */
export const cleanSessionId = (id) => (typeof id === 'string' && /^[\w-]{1,128}$/.test(id) ? id : null);
