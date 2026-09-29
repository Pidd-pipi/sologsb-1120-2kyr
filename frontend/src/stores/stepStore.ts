import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { useArchiveStore } from './archiveStore';
import type { RepairStep, RepairStepDraft } from '../types/step';
import type { TimekeepingTest, TimekeepingTestDraft } from '../types/test';

interface StepState {
  items: RepairStep[];
  tests: TimekeepingTest[];
  loaded: boolean;
}

export const useStepStore = defineStore('step', {
  state: (): StepState => ({ items: [], tests: [], loaded: false }),
  getters: {
    byClock: (state) => (clockId: string) =>
      state.items.filter((it) => it.clockId === clockId).sort((a, b) => a.seq - b.seq),
    testsByClock: (state) => (clockId: string) =>
      state.tests.filter((it) => it.clockId === clockId).sort((a, b) => b.testedAt - a.testedAt),
  },
  actions: {
    async load() {
      const steps = await db.steps.toArray();
      steps.sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
      this.items = steps;
      const tests = await db.tests.toArray();
      this.tests = tests.sort((a, b) => b.testedAt - a.testedAt);
      this.loaded = true;
    },
    async add(draft: RepairStepDraft, actor = draft.operator) {
      const record: RepairStep = { ...toPlain(draft), id: newId('stp') };
      const archiveStore = useArchiveStore();
      const order = archiveStore.assertWritable(record.clockId, actor);
      await db.transaction(
        'rw',
        [db.steps, db.historyEvents, db.archives, db.clocks, db.parts, db.tests],
        async () => {
          await db.steps.put(toPlain(record));
          await archiveStore.appendEvent({
            clockId: record.clockId,
            actor,
            action: 'create',
            entityType: 'step',
            entityId: record.id,
            relatedIds: [record.id, ...record.partIds],
            repairOrderId: order?.id,
            before: null,
            after: record,
            note: `新增工序 #${record.seq} ${record.stepType}`,
          });
          await archiveStore.afterBusinessChange(record.clockId, actor);
        },
      );
      this.items = [...this.items, record];
      return record;
    },
    async finish(id: string, actor = '') {
      const before = this.items.find((it) => it.id === id);
      if (!before) throw new Error('工序不存在');
      const archiveStore = useArchiveStore();
      const order = archiveStore.assertWritable(before.clockId, actor);
      const record: RepairStep = { ...before, state: 'done', finishedAt: Date.now() };
      await db.transaction(
        'rw',
        [db.steps, db.historyEvents, db.archives, db.clocks, db.parts, db.tests],
        async () => {
          await db.steps.put(toPlain(record));
          await archiveStore.appendEvent({
            clockId: before.clockId,
            actor,
            action: 'finish',
            entityType: 'step',
            entityId: id,
            relatedIds: [id, ...before.partIds],
            repairOrderId: order?.id,
            before,
            after: record,
            note: `完成工序 #${before.seq} ${before.stepType}`,
          });
          await archiveStore.afterBusinessChange(before.clockId, actor);
        },
      );
      this.items = this.items.map((it) => (it.id === id ? record : it));
    },
    async rollback(id: string, actor = '') {
      const before = this.items.find((it) => it.id === id);
      if (!before) throw new Error('工序不存在');
      const archiveStore = useArchiveStore();
      const order = archiveStore.assertWritable(before.clockId, actor);
      const { finishedAt: _finishedAt, ...openStep } = before;
      const record: RepairStep = { ...openStep, state: 'rolledback' };
      await db.transaction('rw', db.steps, db.historyEvents, async () => {
        await db.steps.put(toPlain(record));
        await archiveStore.appendEvent({
          clockId: before.clockId,
          actor,
          action: 'rollback',
          entityType: 'step',
          entityId: id,
          relatedIds: [id, ...before.partIds],
          repairOrderId: order?.id,
          before,
          after: record,
          note: `回退工序 #${before.seq} ${before.stepType}`,
        });
      });
      this.items = this.items.map((it) => (it.id === id ? record : it));
    },
    /** 上下移动排序：交换两个相邻步骤的 seq */
    async swapSeq(aId: string, bId: string, actor = '') {
      const a = this.items.find((it) => it.id === aId);
      const b = this.items.find((it) => it.id === bId);
      if (!a || !b) return;
      if (a.clockId !== b.clockId) throw new Error('不能跨钟表调整工序顺序');
      const archiveStore = useArchiveStore();
      const order = archiveStore.assertWritable(a.clockId, actor);
      const before = toPlain([a, b]);
      const aNext: RepairStep = { ...a, seq: b.seq };
      const bNext: RepairStep = { ...b, seq: a.seq };
      await db.transaction('rw', db.steps, db.historyEvents, async () => {
        await db.steps.bulkPut([toPlain(aNext), toPlain(bNext)]);
        await archiveStore.appendEvent({
          clockId: a.clockId,
          actor,
          action: 'reorder',
          entityType: 'step',
          entityId: a.id,
          relatedIds: [a.id, b.id],
          repairOrderId: order?.id,
          before,
          after: toPlain([aNext, bNext]),
          note: `交换工序 #${a.seq} 与 #${b.seq}`,
        });
      });
      this.items = this.items.map((it) => {
        if (it.id === a.id) return aNext;
        if (it.id === b.id) return bNext;
        return it;
      });
    },
    async addTest(draft: TimekeepingTestDraft, actor = '') {
      const record: TimekeepingTest = { ...toPlain(draft), id: newId('tst') };
      const archiveStore = useArchiveStore();
      const order = archiveStore.assertWritable(record.clockId, actor);
      await db.transaction(
        'rw',
        [db.tests, db.historyEvents, db.archives, db.clocks, db.parts, db.steps],
        async () => {
          await db.tests.put(toPlain(record));
          await archiveStore.appendEvent({
            clockId: record.clockId,
            actor,
            action: 'create',
            entityType: 'test',
            entityId: record.id,
            relatedIds: [record.id],
            repairOrderId: order?.id,
            before: null,
            after: record,
            note: `新增走时测试，结论「${record.conclusion}」`,
          });
          await archiveStore.afterBusinessChange(record.clockId, actor);
        },
      );
      this.tests = [record, ...this.tests];
      return record;
    },
    async removeTest(id: string, actor = '') {
      const before = this.tests.find((it) => it.id === id);
      if (!before) throw new Error('测试记录不存在');
      const archiveStore = useArchiveStore();
      const order = archiveStore.assertWritable(before.clockId, actor);
      await db.transaction('rw', db.tests, db.historyEvents, async () => {
        await db.tests.delete(id);
        await archiveStore.appendEvent({
          clockId: before.clockId,
          actor,
          action: 'delete',
          entityType: 'test',
          entityId: id,
          relatedIds: [id],
          repairOrderId: order?.id,
          before,
          after: null,
          note: '删除走时测试记录',
        });
      });
      this.tests = this.tests.filter((it) => it.id !== id);
    },
  },
});
