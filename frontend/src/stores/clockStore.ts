import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
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
    async add(draft: ClockDraft, actor = '') {
      const record: Clock = { ...toPlain(draft), id: newId('clk'), createdAt: Date.now() };
      const archiveStore = useArchiveStore();
      await db.transaction('rw', db.clocks, db.historyEvents, async () => {
        await db.clocks.put(toPlain(record));
        await archiveStore.appendEvent({
          clockId: record.id,
          actor,
          action: 'create',
          entityType: 'clock',
          entityId: record.id,
          relatedIds: [record.id],
          before: null,
          after: record,
          note: '建立钟表台账',
        });
      });
      this.items = [record, ...this.items];
      return record;
    },
    async update(id: string, patch: Partial<Clock>, actor = '') {
      const before = this.byId(id);
      if (!before) throw new Error('钟表不存在');
      const plain = toPlain(patch);
      const record = { ...before, ...plain };
      const archiveStore = useArchiveStore();
      archiveStore.assertWritable(id, actor);
      await db.transaction('rw', db.clocks, db.historyEvents, async () => {
        await db.clocks.update(id, plain);
        await archiveStore.appendEvent({
          clockId: id,
          actor,
          action: 'update',
          entityType: 'clock',
          entityId: id,
          relatedIds: [id],
          before,
          after: record,
          note: '修改钟表档案信息',
        });
      });
      this.items = this.items.map((it) => (it.id === id ? record : it));
    },
    async setGrade(id: string, grade: ConditionGrade, actor = '') {
      await this.update(id, { conditionGrade: grade }, actor);
    },
    async remove(id: string) {
      // 已产生沿革的正式档案不允许通过业务入口删除，避免只增记录失去主体。
      await db.clocks.delete(id);
      this.items = this.items.filter((it) => it.id !== id);
    },
  },
});
