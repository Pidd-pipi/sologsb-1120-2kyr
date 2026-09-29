import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { ArchiveLockedError, isPassingTest, isSealable, repairNoOf, type ClockSnapshot } from '../utils/archive';
import { getOperator } from '../utils/operator';
import type {
  ArchiveVersion,
  HistoryCategory,
  HistoryChange,
  HistoryEntry,
  HistoryRef,
  RepairOrder,
} from '../types/archive';

interface ArchiveState {
  history: HistoryEntry[];
  archives: ArchiveVersion[];
  repairs: RepairOrder[];
  loaded: boolean;
}

/** 记沿革的入参（clockId/category/action 必填，其余补默认值） */
export interface RecordHistoryInput {
  clockId: string;
  category: HistoryCategory;
  action: string;
  operator?: string;
  refs?: HistoryRef[];
  changes?: HistoryChange[];
  note?: string;
  at?: number;
  repairOrderId?: string;
}

export const useArchiveStore = defineStore('archive', {
  state: (): ArchiveState => ({ history: [], archives: [], repairs: [], loaded: false }),
  getters: {
    historyByClock: (state) => (clockId: string) =>
      state.history.filter((it) => it.clockId === clockId).sort((a, b) => b.at - a.at),
    versionsByClock: (state) => (clockId: string) =>
      state.archives.filter((it) => it.clockId === clockId).sort((a, b) => b.version - a.version),
    sealedByClock: (state) => (clockId: string) =>
      state.archives
        .filter((it) => it.clockId === clockId && it.status === 'sealed')
        .sort((a, b) => b.version - a.version)[0],
    baselineByClock: (state) => (clockId: string) =>
      state.archives
        .filter((it) => it.clockId === clockId && it.status === 'baseline')
        .sort((a, b) => b.version - a.version)[0],
    repairByClock: (state) => (clockId: string) =>
      state.repairs
        .filter((it) => it.clockId === clockId && it.status === 'open')
        .sort((a, b) => b.openedAt - a.openedAt)[0],
  },
  actions: {
    async load() {
      const [history, archives, repairs] = await Promise.all([
        db.history.toArray(),
        db.archives.toArray(),
        db.repairs.toArray(),
      ]);
      this.history = history;
      this.archives = archives;
      this.repairs = repairs;
      this.loaded = true;
    },

    /** 追加一条沿革（只增不改，业务写操作统一走这里） */
    async record(input: RecordHistoryInput): Promise<HistoryEntry> {
      const entry: HistoryEntry = {
        id: newId('hst'),
        clockId: input.clockId,
        category: input.category,
        action: input.action,
        operator: input.operator?.trim() || getOperator(),
        at: input.at ?? Date.now(),
        refs: input.refs ?? [],
        changes: input.changes ?? [],
        note: input.note,
        repairOrderId: input.repairOrderId,
      };
      await db.history.put(toPlain(entry));
      this.history = [...this.history, entry];
      return entry;
    },

    /**
     * 写锁守卫：存在正式封存档案且没有进行中的返修单时，禁止再改业务数据。
     * 未封存、仅有待封存基线、返修中均放行（返修单放行时返回其 id）。
     */
    assertWritable(clockId: string, detail?: string): RepairOrder | undefined {
      const sealed = this.sealedByClock(clockId);
      if (!sealed) return undefined;
      const repair = this.repairByClock(clockId);
      if (repair) return repair;
      throw new ArchiveLockedError(
        detail ?? `该钟表已封存为正式档案 v${sealed.version}，后续修改请先开返修单`,
      );
    },

    /**
     * 封存正式档案。
     * - 旧档补录基线（baseline）存在且未封存：占用 v1，资格达标时原地替换为已封存 v1；
     * - 其余情况（新建钟表或后续返修合并后再封存）按下一版本号封存。
     */
    async sealClock(snap: ClockSnapshot, operator: string, note?: string): Promise<ArchiveVersion> {
      const clockId = snap.clock.id;
      if (this.repairByClock(clockId)) {
        throw new ArchiveLockedError('返修单未合并，不能封存，请先在返修单内合并下一版');
      }
      if (!isSealable(snap)) {
        throw new ArchiveLockedError('封存条件不满足：需全部工序完成且至少一次合格走时测试');
      }
      const now = Date.now();
      const who = operator.trim() || getOperator();
      const baseline = this.baselineByClock(clockId);

      if (baseline && !this.sealedByClock(clockId)) {
        const sealed: ArchiveVersion = {
          ...baseline,
          status: 'sealed',
          source: 'seal',
          sealedAt: now,
          sealedBy: who,
          clock: snap.clock,
          parts: snap.parts,
          steps: snap.steps,
          tests: snap.tests,
          note: note?.trim() || '全部工序完成且已有合格测试，封存为正式档案',
        };
        await db.archives.put(toPlain(sealed));
        this.archives = this.archives.map((it) => (it.id === sealed.id ? sealed : it));
        await this.record({
          clockId,
          category: 'archive',
          action: '封存正式档案',
          operator: who,
          refs: [
            { type: 'clock', id: clockId, label: snap.clock.clockNo },
            { type: 'archive', id: sealed.id, label: 'v1' },
          ],
          changes: [
            { field: '版本', after: 'v1' },
            { field: '档案状态', after: '已封存（正式档案）' },
            { field: '工序数', after: snap.steps.length },
            { field: '合格测试次数', after: snap.tests.filter(isPassingTest).length },
          ],
          note: sealed.note,
        });
        return sealed;
      }

      const latest = this.versionsByClock(clockId)[0];
      const version = (latest?.version ?? 0) + 1;
      const sealed: ArchiveVersion = {
        id: newId('arc'),
        clockId,
        version,
        status: 'sealed',
        source: 'seal',
        sealedAt: now,
        sealedBy: who,
        clock: snap.clock,
        parts: snap.parts,
        steps: snap.steps,
        tests: snap.tests,
        note: note?.trim() || '全部工序完成且已有合格测试，封存为正式档案',
        createdAt: now,
      };
      await db.archives.put(toPlain(sealed));
      this.archives = [...this.archives, sealed];
      await this.record({
        clockId,
        category: 'archive',
        action: '封存正式档案',
        operator: who,
        refs: [
          { type: 'clock', id: clockId, label: snap.clock.clockNo },
          { type: 'archive', id: sealed.id, label: `v${version}` },
        ],
        changes: [
          { field: '版本', after: `v${version}` },
          { field: '档案状态', after: '已封存（正式档案）' },
          { field: '工序数', after: snap.steps.length },
          { field: '合格测试次数', after: snap.tests.filter(isPassingTest).length },
        ],
        note: sealed.note,
      });
      return sealed;
    },

    /** 开返修单：封存后的唯一修改入口 */
    async openRepair(clockId: string, reason: string, operator: string): Promise<RepairOrder> {
      const sealed = this.sealedByClock(clockId);
      if (!sealed) throw new ArchiveLockedError('该钟表尚无正式档案，无需开返修单，可直接修改');
      if (this.repairByClock(clockId)) throw new ArchiveLockedError('已有进行中的返修单');
      const who = operator.trim() || getOperator();
      const now = Date.now();
      const seq = this.repairs.filter((it) => it.clockId === clockId).length + 1;
      const order: RepairOrder = {
        id: newId('fx'),
        no: repairNoOf(now, seq),
        clockId,
        reason: reason.trim(),
        openedBy: who,
        openedAt: now,
        status: 'open',
        completedStepIds: [],
        passingTestIds: [],
      };
      await db.repairs.put(toPlain(order));
      this.repairs = [...this.repairs, order];
      await this.record({
        clockId,
        category: 'archive',
        action: '开立返修单',
        operator: who,
        refs: [
          { type: 'repair', id: order.id, label: order.no },
          { type: 'archive', id: sealed.id, label: `v${sealed.version}` },
        ],
        changes: [{ field: '返修原因', after: order.reason || '（未填写）' }],
        note: `基于正式档案 v${sealed.version} 开立`,
      });
      return order;
    },

    /**
     * 合并下一版：返修中新完成至少一道工序，并补一次合格测试后才可合并；
     * 条件不满足时详情页仍展示原正式档案，当前数据不进版本。
     */
    async mergeRepair(snap: ClockSnapshot, operator: string, note?: string): Promise<ArchiveVersion> {
      const clockId = snap.clock.id;
      const repair = this.repairByClock(clockId);
      if (!repair) throw new ArchiveLockedError('没有进行中的返修单');
      if (!isSealable(snap)) {
        throw new ArchiveLockedError('合并条件不满足：当前数据需全部工序完成且至少一次合格测试');
      }
      if (repair.completedStepIds.length === 0) {
        throw new ArchiveLockedError('返修中尚未新完成任何工序，不能合并下一版');
      }
      if (repair.passingTestIds.length === 0) {
        throw new ArchiveLockedError('返修中尚未补录合格走时测试，不能合并下一版');
      }
      const latest = this.versionsByClock(clockId)[0];
      const version = (latest?.version ?? 1) + 1;
      const now = Date.now();
      const who = operator.trim() || getOperator();
      const sealed: ArchiveVersion = {
        id: newId('arc'),
        clockId,
        version,
        status: 'sealed',
        source: 'repair',
        sealedAt: now,
        sealedBy: who,
        clock: snap.clock,
        parts: snap.parts,
        steps: snap.steps,
        tests: snap.tests,
        note: note?.trim() || `返修单 ${repair.no} 合并为正式档案 v${version}`,
        repairOrderId: repair.id,
        createdAt: now,
      };
      const closed: RepairOrder = {
        ...repair,
        status: 'merged',
        closedAt: now,
        mergedVersion: version,
      };
      await db.archives.put(toPlain(sealed));
      await db.repairs.put(toPlain(closed));
      this.archives = [...this.archives, sealed];
      this.repairs = this.repairs.map((it) => (it.id === closed.id ? closed : it));
      await this.record({
        clockId,
        category: 'archive',
        action: '返修合并下一版',
        operator: who,
        refs: [
          { type: 'repair', id: repair.id, label: repair.no },
          { type: 'archive', id: sealed.id, label: `v${version}` },
        ],
        changes: [
          { field: '新版本', after: `v${version}` },
          { field: '返修期新完成工序数', after: repair.completedStepIds.length },
          { field: '返修期合格测试次数', after: repair.passingTestIds.length },
          { field: '返修原因', before: repair.reason },
        ],
        note: sealed.note,
        repairOrderId: repair.id,
      });
      return sealed;
    },

    /** 返修期工序完成：登记合并依据 */
    async markStepCompleted(repairOrderId: string, stepId: string) {
      const repair = this.repairs.find((it) => it.id === repairOrderId);
      if (!repair) return;
      if (repair.completedStepIds.includes(stepId)) return;
      const next = { ...repair, completedStepIds: [...repair.completedStepIds, stepId] };
      await db.repairs.update(repair.id, { completedStepIds: next.completedStepIds });
      this.repairs = this.repairs.map((it) => (it.id === repair.id ? next : it));
    },

    /** 返修期合格测试补录：登记合并依据 */
    async markPassingTest(repairOrderId: string, testId: string) {
      const repair = this.repairs.find((it) => it.id === repairOrderId);
      if (!repair) return;
      if (repair.passingTestIds.includes(testId)) return;
      const next = { ...repair, passingTestIds: [...repair.passingTestIds, testId] };
      await db.repairs.update(repair.id, { passingTestIds: next.passingTestIds });
      this.repairs = this.repairs.map((it) => (it.id === repair.id ? next : it));
    },
  },
});
