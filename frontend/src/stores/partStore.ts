import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { useArchiveStore } from './archiveStore';
import type { MovementPart, MovementPartDraft } from '../types/part';

interface PartState {
  items: MovementPart[];
  loaded: boolean;
}

export const usePartStore = defineStore('part', {
  state: (): PartState => ({ items: [], loaded: false }),
  getters: {
    byClock: (state) => (clockId: string) => state.items.filter((it) => it.clockId === clockId),
    pendingRepair: (state) => state.items.filter((it) => it.decision !== '保留' && it.wearState !== '完好'),
  },
  actions: {
    async load() {
      this.items = await db.parts.toArray();
      this.loaded = true;
    },
    async add(draft: MovementPartDraft, actor = '') {
      const record: MovementPart = { ...toPlain(draft), id: newId('prt') };
      const archiveStore = useArchiveStore();
      const order = archiveStore.assertWritable(record.clockId, actor);
      await db.transaction('rw', db.parts, db.historyEvents, async () => {
        await db.parts.put(toPlain(record));
        await archiveStore.appendEvent({
          clockId: record.clockId,
          actor,
          action: 'create',
          entityType: 'part',
          entityId: record.id,
          relatedIds: [record.id],
          repairOrderId: order?.id,
          before: null,
          after: record,
          note: `登记零件「${record.name}」`,
        });
      });
      this.items = [...this.items, record];
      return record;
    },
    async update(id: string, patch: Partial<MovementPart>, actor = '') {
      const before = this.items.find((it) => it.id === id);
      if (!before) throw new Error('零件不存在');
      const plain = toPlain(patch);
      const record = { ...before, ...plain };
      const archiveStore = useArchiveStore();
      const order = archiveStore.assertWritable(before.clockId, actor);
      await db.transaction('rw', db.parts, db.historyEvents, async () => {
        await db.parts.update(id, plain);
        await archiveStore.appendEvent({
          clockId: before.clockId,
          actor,
          action: 'update',
          entityType: 'part',
          entityId: id,
          relatedIds: [id],
          repairOrderId: order?.id,
          before,
          after: record,
          note: `修改零件「${before.name}」`,
        });
      });
      this.items = this.items.map((it) => (it.id === id ? record : it));
    },
    async remove(id: string, actor = '') {
      const before = this.items.find((it) => it.id === id);
      if (!before) throw new Error('零件不存在');
      const archiveStore = useArchiveStore();
      const order = archiveStore.assertWritable(before.clockId, actor);
      await db.transaction('rw', db.parts, db.historyEvents, async () => {
        await db.parts.delete(id);
        await archiveStore.appendEvent({
          clockId: before.clockId,
          actor,
          action: 'delete',
          entityType: 'part',
          entityId: id,
          relatedIds: [id],
          repairOrderId: order?.id,
          before,
          after: null,
          note: `删除零件「${before.name}」`,
        });
      });
      this.items = this.items.filter((it) => it.id !== id);
    },
  },
});
