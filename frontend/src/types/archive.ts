import type { Clock } from './clock';
import type { MovementPart } from './part';
import type { RepairStep } from './step';
import type { TimekeepingTest } from './test';

/** 沿革分类：工序 / 零件 / 测试 / 档案（封存、返修、基线补录等） */
export type HistoryCategory = 'step' | 'part' | 'test' | 'archive';

export type HistoryRefType = 'clock' | 'step' | 'part' | 'test' | 'archive' | 'repair';

/** 沿革关联记录 */
export interface HistoryRef {
  type: HistoryRefType;
  id: string;
  /** 当时的可读名称，快照式保存，避免后续改名导致沿革失真 */
  label: string;
}

/** 单条前后值变化 */
export interface HistoryChange {
  /** 字段中文名 */
  field: string;
  /** 字段原始 key，用于识别时间字段等 */
  key?: string;
  before?: unknown;
  after?: unknown;
}

/** 维修沿革条目：只增不改 */
export interface HistoryEntry {
  id: string;
  clockId: string;
  category: HistoryCategory;
  /** 动作名，如「交换工序顺序」「变更零件处理决定」「录入走时测试」 */
  action: string;
  /** 操作者 */
  operator: string;
  /** 发生时间 ms */
  at: number;
  /** 关联记录（工序/零件/测试/返修单/档案版本） */
  refs: HistoryRef[];
  /** 前后值 */
  changes: HistoryChange[];
  note?: string;
  /** 该动作归属的返修单（如有） */
  repairOrderId?: string;
}

/** 正式档案版本：封存后不可变的快照 */
export interface ArchiveVersion {
  id: string;
  clockId: string;
  /** 版本号，从 1 起；基线与首个正式版都占 1 */
  version: number;
  /** baseline=旧数据补录的待封存基线；sealed=正式封存版 */
  status: 'baseline' | 'sealed';
  /** backfill=旧档补录；seal=首次封存；repair=返修合并 */
  source: 'backfill' | 'seal' | 'repair';
  /** 封存时间，基线为 0 */
  sealedAt: number;
  sealedBy: string;
  clock: Clock;
  parts: MovementPart[];
  steps: RepairStep[];
  tests: TimekeepingTest[];
  note?: string;
  /** 返修合并版关联的返修单 */
  repairOrderId?: string;
  createdAt: number;
}

/** 返修单 */
export interface RepairOrder {
  id: string;
  /** 返修单号 FX-YYYYMMDD-XXXX */
  no: string;
  clockId: string;
  reason: string;
  openedBy: string;
  openedAt: number;
  status: 'open' | 'merged';
  closedAt?: number;
  mergedVersion?: number;
  /** 返修期内新完成的工序 id（合并依据之一） */
  completedStepIds: string[];
  /** 返修期内补录的合格测试 id（合并依据之一） */
  passingTestIds: string[];
}

export const HISTORY_CATEGORY_META: Record<
  HistoryCategory,
  { label: string; tag: 'primary' | 'warning' | 'success' | 'info' }
> = {
  step: { label: '工序', tag: 'primary' },
  part: { label: '零件', tag: 'warning' },
  test: { label: '测试', tag: 'success' },
  archive: { label: '档案', tag: 'info' },
};

export const HISTORY_REF_META: Record<HistoryRefType, { label: string; tag: 'primary' | 'warning' | 'success' | 'info' | 'danger' }> = {
  clock: { label: '钟表', tag: 'info' },
  step: { label: '工序', tag: 'primary' },
  part: { label: '零件', tag: 'warning' },
  test: { label: '测试', tag: 'success' },
  archive: { label: '档案版本', tag: 'info' },
  repair: { label: '返修单', tag: 'danger' },
};

/** 工序字段中文名 */
export const STEP_FIELD_LABELS: Record<string, string> = {
  seq: '顺序号',
  stepType: '工序类型',
  partIds: '关联零件',
  cleanSolvent: '清洗液',
  cleanMethod: '清洗方式',
  oilType: '润滑油脂',
  oilPoints: '润滑点位',
  torque: '拧紧力矩(N·m)',
  troubleNote: '异常说明',
  operator: '责任人',
  startedAt: '开始时间',
  finishedAt: '完成时间',
  state: '工序状态',
};

export const STEP_STATE_TEXT: Record<string, string> = {
  pending: '待办',
  done: '已完成',
  rolledback: '已回退',
};

/** 零件字段中文名 */
export const PART_FIELD_LABELS: Record<string, string> = {
  name: '零件名称',
  qtyNeeded: '需要数量',
  position: '装配位置',
  wearState: '磨损状态',
  decision: '处理决定',
  sourceLot: '配换来源批号',
  dimension: '关键尺寸(mm)',
};

/** 测试字段中文名 */
export const TEST_FIELD_LABELS: Record<string, string> = {
  testedAt: '测试时间',
  amplitude: '摆幅(°)',
  beatError: '偏振(ms)',
  rate: '日差(s/d)',
  powerReserve: '动力储备(h)',
  conclusion: '测试结论',
  positions: '四方位读数',
};

/** 沿革中按时间本地化展示的字段 */
export const HISTORY_TIME_KEYS = new Set([
  'startedAt',
  'finishedAt',
  'testedAt',
  'sealedAt',
  'openedAt',
  'closedAt',
]);
