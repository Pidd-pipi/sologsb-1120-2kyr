const OPERATOR_KEY = 'gbclockrepair:operator';

export function readOperator(): string {
  try {
    return window.localStorage.getItem(OPERATOR_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeOperator(operator: string): void {
  try {
    window.localStorage.setItem(OPERATOR_KEY, operator);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}
