import type { Clock } from './clock';
import type { MovementPart } from './part';
import type { RepairStep } from './step';
import type { TimekeepingTest } from './test';

export type ArchiveStatus = 'draft' | 'sealed' | 'superseded';

export type RepairOrderStatus = 'open' | 'merged' | 'cancelled';

export type HistoryEntityType = 'clock' | 'step' | 'part' | 'test' | 'archive' | 'repair';

export type HistoryAction =
  | 'baseline'
  | 'create'
  | 'update'
  | 'delete'
  | 'reorder'
  | 'finish'
  | 'rollback'
  | 'archive'
  | 'repair_open'
  | 'repair_merge'
  | 'repair_cancel';

export interface ArchiveSnapshot {
  clock: Clock;
  parts: MovementPart[];
  steps: RepairStep[];
  tests: TimekeepingTest[];
}

/** 正式维修档案版本；封存后的 snapshot 不再改动 */
export interface ClockArchive {
  id: string;
  clockId: string;
  version: number;
  status: ArchiveStatus;
  /** baseline：旧数据首开补版；merge：返修合格后合并 */
  source: 'baseline' | 'initial' | 'merge';
  snapshot: ArchiveSnapshot;
  createdAt: number;
  sealedAt?: number;
  repairOrderId?: string;
  basedOnVersion?: number;
}

/** 返修单：封存后继续修改的唯一许可 */
export interface RepairOrder {
  id: string;
  clockId: string;
  status: RepairOrderStatus;
  reason: string;
  operator: string;
  createdAt: number;
  openedAt: number;
  mergedAt?: number;
  cancelledAt?: number;
  fromVersion: number;
  nextVersion: number;
  mergedArchiveId?: string;
}

export interface HistoryEvent {
  id: string;
  clockId: string;
  /** 操作时间 */
  at: number;
  /** 操作者 */
  actor: string;
  action: HistoryAction;
  entityType: HistoryEntityType;
  /** 主关联记录 ID */
  entityId?: string;
  /** 关联的工序/零件/测试等记录 ID */
  relatedIds?: string[];
  repairOrderId?: string;
  /** 变化前完整值；新建为 null */
  before?: unknown;
  /** 变化后完整值；删除为 null */
  after?: unknown;
  note?: string;
}

export type HistoryEventInput = Omit<HistoryEvent, 'id' | 'at'> & {
  id?: string;
  at?: number;
};

export const HISTORY_ENTITY_LABELS: Record<HistoryEntityType, string> = {
  clock: '钟表',
  step: '工序',
  part: '零件',
  test: '测试',
  archive: '档案',
  repair: '返修单',
};

export const HISTORY_ACTION_LABELS: Record<HistoryAction, string> = {
  baseline: '旧数据补版',
  create: '新增',
  update: '修改',
  delete: '删除',
  reorder: '调整顺序',
  finish: '完成工序',
  rollback: '回退工序',
  archive: '封存档案',
  repair_open: '开立返修单',
  repair_merge: '合并新版本',
  repair_cancel: '取消返修单',
};
