// 验证旧档补录分支：已合格旧档自动封存 v1；沿革筛选分类正确
import 'fake-indexeddb/auto';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
if (typeof (globalThis as any).btoa !== 'function') {
  (globalThis as any).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
  (globalThis as any).atob = (s: string) => Buffer.from(s, 'base64').toString('binary');
}

import Dexie from 'dexie';

function assert(cond: any, msg: string) {
  if (!cond) {
    console.error('❌ FAIL:', msg);
    process.exit(1);
  }
  console.log('✅', msg);
}

async function main() {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('gbclockrepair');
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve();
  });

  const old = new Dexie('gbclockrepair');
  old.version(2).stores({
    clocks: 'id, clockNo, kind, caliber, conditionGrade, createdAt',
    parts: 'id, clockId, name, wearState, decision, sourceLot',
    steps: 'id, clockId, seq, stepType, state, startedAt',
    tests: 'id, clockId, testedAt, conclusion',
  });
  await old.open();
  const done = 'clk_done';
  const pending = 'clk_pending';
  await (old as any).clocks.bulkPut([
    { id: done, clockNo: 'CLK-DONE', kind: '怀表', caliber: 'C1', conditionGrade: '一级', createdAt: 1 },
    { id: pending, clockNo: 'CLK-PEND', kind: '挂钟', caliber: 'C2', conditionGrade: '二级', createdAt: 2 },
  ]);
  await (old as any).steps.bulkPut([
    { id: 's1', clockId: done, seq: 1, stepType: '调试', state: 'done', partIds: [], startedAt: 1, finishedAt: 2, operator: '甲' },
    { id: 's2', clockId: pending, seq: 1, stepType: '拆解', state: 'pending', partIds: [], startedAt: 1, operator: '乙' },
  ]);
  await (old as any).tests.put({
    id: 't1',
    clockId: done,
    testedAt: 3,
    amplitude: 260,
    beatError: 0.2,
    rate: 1,
    positions: [],
    powerReserve: 40,
    conclusion: '合格',
  });
  await old.close();

  const { db } = await import('./src/utils/db');
  const archives = await db.archives.orderBy('clockId').toArray();
  assert(archives.length === 2, '两台旧钟各补 1 个 v1');
  const aDone = archives.find((a) => a.clockId === done)!;
  const aPending = archives.find((a) => a.clockId === pending)!;
  assert(aDone.status === 'sealed' && aDone.source === 'backfill' && aDone.sealedAt > 0, '已合格旧档首次打开直接补成已封存正式 v1');
  assert(aDone.sealedBy === '系统迁移', '自动封存操作者为系统迁移');
  assert(aPending.status === 'baseline' && aPending.sealedAt === 0, '未达标旧档为待封存基线');

  const history = await db.history.toArray();
  assert(history.length === 2 && history.every((h) => h.category === 'archive'), '补录沿革均归为档案分类');
  const hDone = history.find((h) => h.clockId === done)!;
  assert(hDone.changes.some((c) => c.after === '已封存（正式档案）'), '已合格补录沿革写明档案状态');

  // 已自动封存的旧档立即处于写锁：用 store 验证
  const { createPinia, setActivePinia } = await import('pinia');
  setActivePinia(createPinia());
  const { useStepStore } = await import('./src/stores/stepStore');
  const { useArchiveStore } = await import('./src/stores/archiveStore');
  const stepStore = useStepStore();
  const archiveStore = useArchiveStore();
  await stepStore.load();
  await archiveStore.load();
  assert(!!archiveStore.sealedByClock(done) && !archiveStore.repairByClock(done), '自动封存版可被详情页识别为正式档案');

  let rejected = false;
  try {
    await stepStore.finish('s1');
  } catch (e: any) {
    rejected = e.name === 'ArchiveLockedError';
  }
  assert(rejected, '自动封存的旧档同样只读，须先开返修单');

  // 开返修单后可加零件决定类变更，且沿革可按分类筛选（模拟前端筛选）
  await archiveStore.openRepair(done, '翻新摆轮', '赵六');
  const { usePartStore } = await import('./src/stores/partStore');
  const partStore = usePartStore();
  await partStore.load();
  await partStore.add({
    clockId: done,
    name: '摆轮',
    qtyNeeded: 1,
    position: '夹板下',
    wearState: '磨损',
    decision: '换新',
    sourceLot: 'LOT-9',
    dimension: 14,
  });
  const h = await db.history.where('clockId').equals(done).toArray();
  const partsOnly = h.filter((x: any) => x.category === 'part');
  assert(partsOnly.length === 1 && partsOnly[0].action === '登记零件', '沿革可按「零件」分类筛选');
  assert(partsOnly[0].repairOrderId !== undefined, '返修期沿革挂返修单');
  assert(partsOnly[0].changes.find((c: any) => c.field.includes('决定'))?.after === '换新', '零件决定前后值被记录');

  console.log('\n🎉 补录/筛选分支断言通过');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
