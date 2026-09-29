import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { getOperator } from '../utils/operator';
import { useArchiveStore } from './archiveStore';
import type { Clock, ClockDraft, ConditionGrade } from '../types/clock';

interface ClockState {
  items: Clock[];
  loaded: boolean;
}

export const useClockStore = defineStore('clock', {
  state: (): ClockState => ({ items: [], loaded: false }),
  getters: {
    byId: (state) => (id: string) => state.items.find((it) => it.id === id),
    calibers: (state) => Array.from(new Set(state.items.map((it) => it.caliber))).filter(Boolean),
  },
  actions: {
    async load() {
      const rows = await db.clocks.orderBy('createdAt').reverse().toArray();
      this.items = rows;
      this.loaded = true;
    },
    async add(draft: ClockDraft) {
      const record: Clock = { ...toPlain(draft), id: newId('clk'), createdAt: Date.now() };
      await db.clocks.put(toPlain(record));
      this.items = [record, ...this.items];
      return record;
    },
    async update(id: string, patch: Partial<Clock>) {
      const plain = toPlain(patch);
      await db.clocks.update(id, plain);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...plain } : it));
    },
    /** 品相等级调整：封存档案上禁止直接改，走写锁守卫并记沿革 */
    async setGrade(id: string, grade: ConditionGrade) {
      const archiveStore = useArchiveStore();
      const before = this.byId(id);
      if (!before || before.conditionGrade === grade) return;
      const repair = archiveStore.assertWritable(id, '档案已封存，品相等级调整请先开返修单');
      await this.update(id, { conditionGrade: grade });
      await archiveStore.record({
        clockId: id,
        category: 'archive',
        action: '调整品相等级',
        operator: getOperator(),
        refs: [{ type: 'clock', id, label: before.clockNo }],
        changes: [{ field: '品相等级', before: before.conditionGrade, after: grade }],
        repairOrderId: repair?.id,
      });
    },
    async remove(id: string) {
      await db.clocks.delete(id);
      this.items = this.items.filter((it) => it.id !== id);
    },
  },
});
