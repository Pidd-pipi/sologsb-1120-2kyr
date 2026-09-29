/** 当前操作者（本地记忆，无登录体系时作为沿革操作者默认值） */
const KEY = 'gbclockrepair:operator';
const FALLBACK = '修复师';

export function getOperator(): string {
  try {
    return window.localStorage.getItem(KEY)?.trim() || FALLBACK;
  } catch {
    return FALLBACK;
  }
}

export function setOperator(name: string): void {
  const v = name.trim();
  if (!v) return;
  try {
    window.localStorage.setItem(KEY, v);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}
