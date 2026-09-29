import type { Clock } from '../types/clock';
import type { MovementPart } from '../types/part';
import type { RepairStep } from '../types/step';
import type { TimekeepingTest } from '../types/test';
import type { HistoryChange } from '../types/archive';

/** 已封存档案上的写操作被拦截 */
export class ArchiveLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveLockedError';
  }
}

/** 正式档案版本内的完整快照 */
export interface ClockSnapshot {
  clock: Clock;
  parts: MovementPart[];
  steps: RepairStep[];
  tests: TimekeepingTest[];
}

/** 走时测试是否合格 */
export function isPassingTest(t: TimekeepingTest): boolean {
  return (t.conclusion ?? '').includes('合格') && !t.conclusion.includes('不');
}

/** 封存资格：工序全部完成（无待办/回退）且至少一次合格测试 */
export function isSealable(s: ClockSnapshot): boolean {
  if (s.steps.length === 0) return false;
  const allDone = s.steps.every((it) => it.state === 'done');
  const hasPassing = s.tests.some(isPassingTest);
  return allDone && hasPassing;
}

/** 工序状态文案（回退等枚举在沿革里需要可读化） */
export function stepStateText(state: string): string {
  if (state === 'done') return '已完成';
  if (state === 'rolledback') return '已回退';
  return '待办';
}

/** 按字段标签表生成前后值变化（忽略两侧相同的字段） */
export function diffValues<T extends Record<string, unknown>>(
  before: Partial<T>,
  after: Partial<T>,
  labels: Record<string, string>,
): HistoryChange[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: HistoryChange[] = [];
  keys.forEach((key) => {
    const field = labels[key] ?? key;
    const b = before[key];
    const a = after[key];
    if (JSON.stringify(b) === JSON.stringify(a)) return;
    changes.push({ field, key, before: b, after: a });
  });
  return changes;
}

/** 沿革时间本地化 */
export function formatHistoryTime(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** 返修单号：FX-YYYYMMDD-XXXX */
export function repairNoOf(ms: number, seq: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  return `FX-${day}-${String(seq).padStart(4, '0')}`;
}
