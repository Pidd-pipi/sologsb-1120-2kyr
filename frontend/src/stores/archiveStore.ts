import { defineStore } from 'pinia';
import { db, isArchiveReady, isQualifyingTest, loadSnapshot, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import type {
  ClockArchive,
  HistoryEvent,
  HistoryEventInput,
  RepairOrder,
} from '../types/archive';

interface ArchiveState {
  archives: ClockArchive[];
  repairOrders: RepairOrder[];
  events: HistoryEvent[];
  loaded: boolean;
}

export class ArchivePermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchivePermissionError';
  }
}

export const useArchiveStore = defineStore('archive', {
  state: (): ArchiveState => ({
    archives: [],
    repairOrders: [],
    events: [],
    loaded: false,
  }),
  getters: {
    archivesByClock: (state) => (clockId: string) =>
      state.archives
        .filter((it) => it.clockId === clockId)
        .sort((a, b) => a.version - b.version),
    latestArchive: (state) => (clockId: string) =>
      state.archives
        .filter((it) => it.clockId === clockId)
        .sort((a, b) => b.version - a.version)[0],
    latestSealedArchive: (state) => (clockId: string) =>
      state.archives
        .filter((it) => it.clockId === clockId && it.status === 'sealed')
        .sort((a, b) => b.version - a.version)[0],
    activeRepairOrder: (state) => (clockId: string) =>
      state.repairOrders.find((it) => it.clockId === clockId && it.status === 'open'),
    eventsByClock: (state) => (clockId: string) =>
      state.events
        .filter((it) => it.clockId === clockId)
        .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)),
  },
  actions: {
    async load() {
      const [archives, repairOrders, events] = await Promise.all([
        db.archives.toArray(),
        db.repairOrders.toArray(),
        db.historyEvents.toArray(),
      ]);
      this.archives = archives;
      this.repairOrders = repairOrders;
      this.events = events;
      this.loaded = true;
    },

    async appendEvent(input: HistoryEventInput): Promise<HistoryEvent> {
      const actor = input.actor.trim();
      if (!actor) throw new Error('缺少操作者，无法记录维修沿革');
      const event: HistoryEvent = {
        ...input,
        id: input.id ?? newId('hst'),
        at: input.at ?? Date.now(),
        actor,
      };
      await db.historyEvents.add(toPlain(event));
      this.events = [...this.events, event];
      return event;
    },

    /** 已封存且无进行中的返修单时，业务数据不可直接写入。 */
    assertWritable(clockId: string, actor: string): RepairOrder | undefined {
      const operator = actor.trim();
      if (!operator) throw new Error('请先填写操作者');
      const latest = this.latestSealedArchive(clockId);
      if (!latest) return undefined;
      const order = this.activeRepairOrder(clockId);
      if (!order) {
        throw new ArchivePermissionError('正式档案已封存，请先开立返修单后再修改');
      }
      return order;
    },

    async openRepair(clockId: string, reason: string, actor: string): Promise<RepairOrder> {
      const operator = actor.trim();
      if (!operator) throw new Error('请先填写操作者');
      const trimmedReason = reason.trim();
      if (!trimmedReason) throw new Error('返修原因必填');
      const latest = this.latestSealedArchive(clockId);
      if (!latest) throw new Error('尚无已封存正式档案，无需开立返修单');
      if (this.activeRepairOrder(clockId)) throw new Error('该钟表已有进行中的返修单');

      const now = Date.now();
      const order: RepairOrder = {
        id: newId('rpo'),
        clockId,
        status: 'open',
        reason: trimmedReason,
        operator,
        createdAt: now,
        openedAt: now,
        fromVersion: latest.version,
        nextVersion: latest.version + 1,
      };
      await db.transaction('rw', db.repairOrders, db.historyEvents, async () => {
        await db.repairOrders.add(toPlain(order));
        await this.appendEvent({
          clockId,
          actor: operator,
          action: 'repair_open',
          entityType: 'repair',
          entityId: order.id,
          relatedIds: [latest.id],
          before: null,
          after: order,
          note: trimmedReason,
        });
      });
      this.repairOrders = [...this.repairOrders, order];
      return order;
    },

    async cancelRepair(clockId: string, actor: string): Promise<void> {
      const operator = actor.trim();
      const order = this.activeRepairOrder(clockId);
      if (!order) throw new Error('没有进行中的返修单');
      const now = Date.now();
      const before = { ...order };
      const cancelled: RepairOrder = {
        ...order,
        status: 'cancelled',
        cancelledAt: now,
      };
      await db.transaction('rw', db.repairOrders, db.historyEvents, async () => {
        await db.repairOrders.put(toPlain(cancelled));
        await this.appendEvent({
          clockId,
          actor: operator || order.operator,
          action: 'repair_cancel',
          entityType: 'repair',
          entityId: order.id,
          before,
          after: cancelled,
        });
      });
      this.repairOrders = this.repairOrders.map((it) => (it.id === order.id ? cancelled : it));
    },

    /**
     * 业务写入后调用：
     * - 首次满足条件：封存第 1 版；
     * - 旧数据补的 draft 第 1 版：补齐后封存；
     * - 返修中：不自动合并，必须显式执行 mergeRepair。
     */
    async afterBusinessChange(clockId: string, actor: string): Promise<void> {
      if (this.activeRepairOrder(clockId)) return;
      const existing = this.latestArchive(clockId);
      if (existing?.status === 'sealed') return;

      const snapshot = await loadSnapshot(clockId);
      if (!snapshot.clock || !isArchiveReady(snapshot.steps, snapshot.tests)) return;

      const now = Date.now();
      if (existing && existing.status === 'draft') {
        const before = toPlain(existing);
        const sealed: ClockArchive = {
          ...existing,
          snapshot: {
            clock: snapshot.clock,
            parts: snapshot.parts,
            steps: snapshot.steps,
            tests: snapshot.tests,
          },
          status: 'sealed',
          sealedAt: now,
        };
        await db.transaction('rw', db.archives, db.historyEvents, async () => {
          await db.archives.put(toPlain(sealed));
          await this.appendEvent({
            clockId,
            actor: actor.trim() || '系统',
            action: 'archive',
            entityType: 'archive',
            entityId: sealed.id,
            relatedIds: [clockId],
            before,
            after: sealed,
            note: `第 ${sealed.version} 版正式封存`,
          });
        });
        this.archives = this.archives.map((it) => (it.id === sealed.id ? sealed : it));
        return;
      }

      if (!existing) {
        const archive: ClockArchive = {
          id: newId('arc'),
          clockId,
          version: 1,
          status: 'sealed',
          source: 'initial',
          snapshot: {
            clock: snapshot.clock,
            parts: snapshot.parts,
            steps: snapshot.steps,
            tests: snapshot.tests,
          },
          createdAt: now,
          sealedAt: now,
        };
        await db.transaction('rw', db.archives, db.historyEvents, async () => {
          await db.archives.add(toPlain(archive));
          await this.appendEvent({
            clockId,
            actor: actor.trim() || '系统',
            action: 'archive',
            entityType: 'archive',
            entityId: archive.id,
            relatedIds: [
              clockId,
              ...snapshot.parts.map((p) => p.id),
              ...snapshot.steps.map((s) => s.id),
              ...snapshot.tests.map((t) => t.id),
            ],
            before: null,
            after: archive,
            note: '工序全部完成且已有合格测试，第 1 版正式封存',
          });
        });
        this.archives = [...this.archives, archive];
      }
    },

    async mergeRepair(clockId: string, actor: string): Promise<ClockArchive> {
      const operator = actor.trim();
      if (!operator) throw new Error('请先填写操作者');
      const order = this.activeRepairOrder(clockId);
      if (!order) throw new Error('没有可合并的返修单');

      const snapshot = await loadSnapshot(clockId);
      if (!snapshot.clock) throw new Error('钟表不存在');
      if (snapshot.steps.length === 0 || !snapshot.steps.every((step) => step.state === 'done')) {
        throw new Error('所有工序完成后才能合并新版本');
      }
      const newTest = snapshot.tests.find(
        (test) => test.testedAt >= order.openedAt && isQualifyingTest(test),
      );
      if (!newTest) throw new Error('返修开立后还需补一次合格测试');

      const finishedStepEvents = await db.historyEvents
        .where('clockId')
        .equals(clockId)
        .filter((event) => event.repairOrderId === order.id && event.action === 'finish')
        .count();
      if (finishedStepEvents === 0) {
        throw new Error('返修中还需新完成一道工序');
      }

      const previous = this.latestSealedArchive(clockId);
      if (!previous || previous.version !== order.fromVersion) {
        throw new Error('返修基准版本已变化，请刷新后重试');
      }

      const now = Date.now();
      const merged: ClockArchive = {
        id: newId('arc'),
        clockId,
        version: order.nextVersion,
        status: 'sealed',
        source: 'merge',
        snapshot: {
          clock: snapshot.clock,
          parts: snapshot.parts,
          steps: snapshot.steps,
          tests: snapshot.tests,
        },
        createdAt: now,
        sealedAt: now,
        repairOrderId: order.id,
        basedOnVersion: order.fromVersion,
      };
      const superseded: ClockArchive = { ...previous, status: 'superseded' };
      const mergedOrder: RepairOrder = {
        ...order,
        status: 'merged',
        mergedAt: now,
        mergedArchiveId: merged.id,
      };

      await db.transaction(
        'rw',
        [
          db.archives,
          db.repairOrders,
          db.historyEvents,
          db.clocks,
          db.parts,
          db.steps,
          db.tests,
        ],
        async () => {
          await db.archives.put(toPlain(superseded));
          await db.archives.add(toPlain(merged));
          await db.repairOrders.put(toPlain(mergedOrder));
          await this.appendEvent({
            clockId,
            actor: operator,
            action: 'repair_merge',
            entityType: 'repair',
            entityId: order.id,
            repairOrderId: order.id,
            relatedIds: [merged.id, previous.id],
            before: { archive: previous, order },
            after: { archive: merged, order: mergedOrder },
            note: `返修内容合格，合并为第 ${merged.version} 版`,
          });
          await this.appendEvent({
            clockId,
            actor: operator,
            action: 'archive',
            entityType: 'archive',
            entityId: merged.id,
            repairOrderId: order.id,
            relatedIds: [
              clockId,
              ...snapshot.parts.map((p) => p.id),
              ...snapshot.steps.map((s) => s.id),
              ...snapshot.tests.map((t) => t.id),
            ],
            before: previous,
            after: merged,
            note: `第 ${merged.version} 版正式封存`,
          });
        },
      );

      this.archives = [...this.archives.map((it) => (it.id === previous.id ? superseded : it)), merged];
      this.repairOrders = this.repairOrders.map((it) => (it.id === order.id ? mergedOrder : it));
      return merged;
    },
  },
});
