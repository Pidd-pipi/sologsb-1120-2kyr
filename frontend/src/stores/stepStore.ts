import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { getOperator } from '../utils/operator';
import { diffValues, isPassingTest, stepStateText } from '../utils/archive';
import { useArchiveStore } from './archiveStore';
import { usePartStore } from './partStore';
import type { RepairStep, RepairStepDraft } from '../types/step';
import type { TimekeepingTest, TimekeepingTestDraft } from '../types/test';
import { STEP_FIELD_LABELS, TEST_FIELD_LABELS } from '../types/archive';

interface StepState {
  items: RepairStep[];
  tests: TimekeepingTest[];
  loaded: boolean;
}

/** 把关联零件 id 还原成「名称 · 位置」，用于沿革展示 */
function partLabels(ids: string[]): string {
  if (!ids || ids.length === 0) return '—';
  const partStore = usePartStore();
  return ids
    .map((id) => partStore.items.find((p) => p.id === id))
    .filter(Boolean)
    .map((p) => `${p!.name} · ${p!.position}`)
    .join('、');
}

/** 沿革展示用：工序关联零件 id 数组转名称；状态枚举转文案 */
function decorateChanges(changes: { field: string; key?: string; before?: unknown; after?: unknown }[], partIds: string[]) {
  return changes.map((c) => {
    if (c.key === 'partIds') {
      const b = Array.isArray(c.before) ? partLabels(c.before as string[]) : c.before;
      const a = Array.isArray(c.after) ? partLabels(c.after as string[]) : c.after;
      return { ...c, before: b, after: a };
    }
    if (c.key === 'state') {
      return {
        ...c,
        before: typeof c.before === 'string' ? stepStateText(c.before) : c.before,
        after: typeof c.after === 'string' ? stepStateText(c.after) : c.after,
      };
    }
    return c;
  });
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
    /** 追加维修工序：封存后须先开返修单 */
    async add(draft: RepairStepDraft) {
      const archiveStore = useArchiveStore();
      const repair = archiveStore.assertWritable(draft.clockId, '档案已封存，追加工序请先开返修单');
      const record: RepairStep = { ...toPlain(draft), id: newId('stp') };
      await db.steps.put(toPlain(record));
      this.items = [...this.items, record];
      const changes = decorateChanges(
        diffValues(
          {},
          {
            seq: record.seq,
            stepType: record.stepType,
            partIds: record.partIds,
            cleanSolvent: record.cleanSolvent || '—',
            cleanMethod: record.cleanMethod || '—',
            oilType: record.oilType || '—',
            oilPoints: record.oilPoints || '—',
            torque: record.torque || '—',
            troubleNote: record.troubleNote || '—',
            state: record.state,
          },
          STEP_FIELD_LABELS,
        ),
        record.partIds,
      );
      await archiveStore.record({
        clockId: record.clockId,
        category: 'step',
        action: '追加维修工序',
        operator: record.operator || getOperator(),
        refs: [{ type: 'step', id: record.id, label: `#${record.seq} ${record.stepType}` }],
        changes,
        repairOrderId: repair?.id,
      });
      return record;
    },
    /** 完成工序：返修期完成的工序计入返修单合并依据 */
    async finish(id: string) {
      const archiveStore = useArchiveStore();
      const before = this.items.find((it) => it.id === id);
      if (!before) return;
      const repair = archiveStore.assertWritable(before.clockId, '档案已封存，完成工序请先开返修单');
      const patch: Partial<RepairStep> = { state: 'done', finishedAt: Date.now() };
      await db.steps.update(id, patch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
      if (repair) await archiveStore.markStepCompleted(repair.id, id);
      await archiveStore.record({
        clockId: before.clockId,
        category: 'step',
        action: '完成工序',
        operator: getOperator(),
        refs: [{ type: 'step', id, label: `#${before.seq} ${before.stepType}` }],
        changes: decorateChanges(diffValues(before as unknown as Record<string, unknown>, patch, STEP_FIELD_LABELS), before.partIds),
        repairOrderId: repair?.id,
      });
    },
    async rollback(id: string) {
      const archiveStore = useArchiveStore();
      const before = this.items.find((it) => it.id === id);
      if (!before) return;
      const repair = archiveStore.assertWritable(before.clockId, '档案已封存，回退工序请先开返修单');
      const patch: Partial<RepairStep> = { state: 'rolledback', finishedAt: undefined };
      await db.steps.update(id, patch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
      await archiveStore.record({
        clockId: before.clockId,
        category: 'step',
        action: '回退工序',
        operator: getOperator(),
        refs: [{ type: 'step', id, label: `#${before.seq} ${before.stepType}` }],
        changes: decorateChanges(diffValues(before as unknown as Record<string, unknown>, patch, STEP_FIELD_LABELS), before.partIds),
        repairOrderId: repair?.id,
      });
    },
    /** 上下移动 / 拖拽排序：交换两个工序的 seq，记录顺序前后值 */
    async swapSeq(aId: string, bId: string) {
      const archiveStore = useArchiveStore();
      const a = this.items.find((it) => it.id === aId);
      const b = this.items.find((it) => it.id === bId);
      if (!a || !b) return;
      const repair = archiveStore.assertWritable(a.clockId, '档案已封存，调整工序顺序请先开返修单');
      const aSeq = a.seq;
      await db.steps.update(a.id, { seq: b.seq });
      await db.steps.update(b.id, { seq: aSeq });
      this.items = this.items.map((it) => {
        if (it.id === a.id) return { ...it, seq: b.seq };
        if (it.id === b.id) return { ...it, seq: aSeq };
        return it;
      });
      await archiveStore.record({
        clockId: a.clockId,
        category: 'step',
        action: '交换工序顺序',
        operator: getOperator(),
        refs: [
          { type: 'step', id: a.id, label: `${a.stepType}` },
          { type: 'step', id: b.id, label: `${b.stepType}` },
        ],
        changes: [
          { field: `${a.stepType} 顺序号`, before: aSeq, after: b.seq },
          { field: `${b.stepType} 顺序号`, before: b.seq, after: aSeq },
        ],
        repairOrderId: repair?.id,
      });
    },
    /** 录入走时测试：返修期补的合格测试计入合并依据 */
    async addTest(draft: TimekeepingTestDraft) {
      const archiveStore = useArchiveStore();
      const repair = archiveStore.assertWritable(draft.clockId, '档案已封存，录入测试请先开返修单');
      const record: TimekeepingTest = { ...toPlain(draft), id: newId('tst') };
      await db.tests.put(toPlain(record));
      this.tests = [record, ...this.tests];
      if (repair && isPassingTest(record)) await archiveStore.markPassingTest(repair.id, record.id);
      const positions = record.positions
        .map((p) => `${p.position}：日差${p.rate}/摆幅${p.amplitude}°/偏振${p.beatError}ms`)
        .join('；');
      await archiveStore.record({
        clockId: record.clockId,
        category: 'test',
        action: '录入走时测试',
        operator: getOperator(),
        refs: [{ type: 'test', id: record.id, label: new Date(record.testedAt).toLocaleDateString('zh-CN') }],
        changes: [
          { field: TEST_FIELD_LABELS.rate, after: record.rate },
          { field: TEST_FIELD_LABELS.amplitude, after: record.amplitude },
          { field: TEST_FIELD_LABELS.beatError, after: record.beatError },
          { field: TEST_FIELD_LABELS.powerReserve, after: record.powerReserve },
          { field: TEST_FIELD_LABELS.conclusion, after: record.conclusion },
          { field: TEST_FIELD_LABELS.positions, after: positions },
        ],
        repairOrderId: repair?.id,
      });
      return record;
    },
    async removeTest(id: string) {
      const archiveStore = useArchiveStore();
      const before = this.tests.find((it) => it.id === id);
      if (!before) return;
      const repair = archiveStore.assertWritable(before.clockId, '档案已封存，删除测试请先开返修单');
      await db.tests.delete(id);
      this.tests = this.tests.filter((it) => it.id !== id);
      await archiveStore.record({
        clockId: before.clockId,
        category: 'test',
        action: '删除走时测试',
        operator: getOperator(),
        refs: [{ type: 'test', id, label: new Date(before.testedAt).toLocaleDateString('zh-CN') }],
        changes: [
          { field: TEST_FIELD_LABELS.rate, before: before.rate },
          { field: TEST_FIELD_LABELS.conclusion, before: before.conclusion },
        ],
        repairOrderId: repair?.id,
      });
    },
  },
});
