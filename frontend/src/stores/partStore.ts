import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { getOperator } from '../utils/operator';
import { diffValues } from '../utils/archive';
import { useArchiveStore } from './archiveStore';
import type { MovementPart, MovementPartDraft } from '../types/part';
import { PART_FIELD_LABELS } from '../types/archive';

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
    /** 登记零件：封存后须先开返修单 */
    async add(draft: MovementPartDraft) {
      const archiveStore = useArchiveStore();
      const repair = archiveStore.assertWritable(draft.clockId, '档案已封存，零件登记请先开返修单');
      const record: MovementPart = { ...toPlain(draft), id: newId('prt') };
      await db.parts.put(toPlain(record));
      this.items = [...this.items, record];
      const changes = diffValues(
        {},
        {
          name: record.name,
          qtyNeeded: record.qtyNeeded,
          position: record.position,
          wearState: record.wearState,
          decision: record.decision,
          sourceLot: record.sourceLot || '—',
          dimension: record.dimension,
        },
        PART_FIELD_LABELS,
      );
      await archiveStore.record({
        clockId: record.clockId,
        category: 'part',
        action: '登记零件',
        operator: getOperator(),
        refs: [{ type: 'part', id: record.id, label: `${record.name} · ${record.position}` }],
        changes,
        repairOrderId: repair?.id,
      });
      return record;
    },
    /** 修改零件（如处理决定）：记前后值 */
    async update(id: string, patch: Partial<MovementPart>) {
      const archiveStore = useArchiveStore();
      const before = this.items.find((it) => it.id === id);
      if (!before) return;
      const repair = archiveStore.assertWritable(before.clockId, '档案已封存，零件修改请先开返修单');
      const plain = toPlain(patch);
      await db.parts.update(id, plain);
      const after = { ...before, ...plain };
      this.items = this.items.map((it) => (it.id === id ? after : it));
      const changes = diffValues(before as unknown as Record<string, unknown>, plain, PART_FIELD_LABELS);
      if (changes.length > 0) {
        await archiveStore.record({
          clockId: before.clockId,
          category: 'part',
          action: '修改零件信息',
          operator: getOperator(),
          refs: [{ type: 'part', id, label: `${after.name} · ${after.position}` }],
          changes,
          repairOrderId: repair?.id,
        });
      }
    },
    async remove(id: string) {
      const archiveStore = useArchiveStore();
      const before = this.items.find((it) => it.id === id);
      if (before) {
        const repair = archiveStore.assertWritable(before.clockId, '档案已封存，零件删除请先开返修单');
        await db.parts.delete(id);
        this.items = this.items.filter((it) => it.id !== id);
        await archiveStore.record({
          clockId: before.clockId,
          category: 'part',
          action: '删除零件',
          operator: getOperator(),
          refs: [{ type: 'part', id, label: `${before.name} · ${before.position}` }],
          changes: [
            { field: PART_FIELD_LABELS.name, before: before.name },
            { field: PART_FIELD_LABELS.decision, before: before.decision },
            { field: PART_FIELD_LABELS.wearState, before: before.wearState },
          ],
          repairOrderId: repair?.id,
        });
      }
    },
  },
});
