// 生命周期验证脚本：v2 旧库 -> v3 补录基线 -> 完成工序 -> 封存 -> 写锁 -> 返修 -> 合并规则 -> v2
import 'fake-indexeddb/auto';

// localStorage 桩
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

// structuredClone 在较新 node 上存在；Dexie 还会用到 btoa/atob
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

async function buildV2() {
  // 用独立 Dexie 实例以 v2 结构写旧数据
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('gbclockrepair');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });

  const old = new Dexie('gbclockrepair');
  old.version(2).stores({
    clocks: 'id, clockNo, kind, caliber, conditionGrade, createdAt',
    parts: 'id, clockId, name, wearState, decision, sourceLot',
    steps: 'id, clockId, seq, stepType, state, startedAt',
    tests: 'id, clockId, testedAt, conclusion',
  });
  await old.open();

  const clk = 'clk_test1';
  await (old as any).clocks.put({
    id: clk,
    clockNo: 'CLK-TEST-01',
    kind: '座钟',
    caliber: 'Test C01',
    origin: '中国',
    maker: '测试厂',
    yearMade: '1900',
    caseMaterial: '木',
    size: '100',
    dialMark: '测试盘',
    acquireFrom: '测试来源',
    conditionGrade: '三级',
    storagePos: 'A-1',
    createdAt: 1000,
  });
  await (old as any).steps.bulkPut([
    {
      id: 'stp1',
      clockId: clk,
      stepType: '拆解',
      seq: 1,
      partIds: [],
      cleanSolvent: '',
      cleanMethod: '',
      oilType: '',
      oilPoints: '',
      torque: 0.5,
      troubleNote: '',
      operator: '张三',
      startedAt: 2000,
      finishedAt: 3000,
      state: 'done',
    },
    {
      id: 'stp2',
      clockId: clk,
      stepType: '润滑',
      seq: 2,
      partIds: [],
      cleanSolvent: '',
      cleanMethod: '',
      oilType: 'Moebius',
      oilPoints: '轴孔',
      torque: 0,
      troubleNote: '',
      operator: '张三',
      startedAt: 4000,
      state: 'pending',
    },
  ]);
  await (old as any).tests.put({
    id: 'tst1',
    clockId: clk,
    testedAt: 5000,
    amplitude: 262,
    beatError: 0.4,
    rate: 6.5,
    positions: [],
    powerReserve: 46,
    conclusion: '合格',
  });
  await old.close();
}

async function main() {
  await buildV2();

  // 重新导入应用模块（模块级创建 db，会触发 v2 -> v3 升级）
  const { db, DB_VERSION } = await import('./src/utils/db');
  assert(DB_VERSION === 3, '结构版本为 v3');

  const archives = await db.archives.toArray();
  const history = await db.history.toArray();
  assert(archives.length === 1, '旧数据补录产生 1 个版本');
  assert(archives[0].version === 1 && archives[0].status === 'baseline', '旧档补成第 1 版基线（工序未全完，不自动封存）');
  assert(history.length === 1, '补录写入 1 条沿革');
  assert(history[0].action === '旧档补录为第 1 版' && history[0].operator === '系统迁移', '补录沿革操作者为系统迁移');

  // 旧档快照包含原数据
  assert(archives[0].steps.length === 2 && archives[0].tests.length === 1, '基线快照含 2 工序 1 测试');

  // ---- 用 Pinia store 跑业务流程 ----
  const { createPinia, setActivePinia } = await import('pinia');
  setActivePinia(createPinia());
  const { useStepStore } = await import('./src/stores/stepStore');
  const { useArchiveStore } = await import('./src/stores/archiveStore');
  const { ArchiveLockedError } = await import('./src/utils/archive');
  const stepStore = useStepStore();
  const archiveStore = useArchiveStore();
  await stepStore.load();
  await archiveStore.load();

  const clk = 'clk_test1';

  // 基线状态下可直接改：完成 stp2
  await stepStore.finish('stp2');
  const histAfterFinish = await db.history.where('clockId').equals(clk).toArray();
  assert(histAfterFinish.length === 2, '完成工序追加沿革（共 2 条）');
  assert(histAfterFinish.some((h: any) => h.action === '完成工序' && h.changes.some((c: any) => c.after === '已完成')), '完成工序记录状态前后值');

  // 封存
  const { useClockStore } = await import('./src/stores/clockStore');
  const { usePartStore } = await import('./src/stores/partStore');
  const clockStore = useClockStore();
  const partStore = usePartStore();
  await clockStore.load();
  await partStore.load();

  const snap = () => ({
    clock: clockStore.byId(clk)!,
    parts: partStore.byClock(clk),
    steps: stepStore.byClock(clk),
    tests: stepStore.testsByClock(clk),
  });
  const v1 = await archiveStore.sealClock(snap(), '李四', '首次封存');
  assert(v1.version === 1 && v1.status === 'sealed', '满足条件后封存占用 v1（替换基线）');
  const versionsAfterSeal = await db.archives.where('clockId').equals(clk).toArray();
  assert(versionsAfterSeal.length === 1 && versionsAfterSeal[0].status === 'sealed', '封存后仅保留 1 个 v1 正式版（基线被替换）');
  assert(v1.sealedBy === '李四', '封存操作者记录为李四');

  // 封存后写操作被拒
  let rejected = false;
  try {
    await stepStore.finish('stp1');
  } catch (e) {
    rejected = e instanceof ArchiveLockedError;
  }
  assert(rejected, '封存后完成工序被写锁拦截');

  rejected = false;
  try {
    await stepStore.addTest({
      clockId: clk,
      testedAt: Date.now(),
      amplitude: 260,
      beatError: 0.3,
      rate: 1,
      positions: [],
      powerReserve: 40,
      conclusion: '合格',
    });
  } catch (e) {
    rejected = e instanceof ArchiveLockedError;
  }
  assert(rejected, '封存后录入测试被写锁拦截');

  // 不开返修单不能再封存/合并
  rejected = false;
  try {
    await archiveStore.mergeRepair(snap(), '李四');
  } catch (e) {
    rejected = e instanceof ArchiveLockedError;
  }
  assert(rejected, '无返修单时合并被拒');

  // 开返修单
  const order = await archiveStore.openRepair(clk, '日差复检偏大', '王五');
  assert(order.no.startsWith('FX-'), `返修单号格式正确：${order.no}`);

  // 返修中改工序顺序、加新工序、完成新工序
  await stepStore.swapSeq('stp1', 'stp2');
  const newStep = await stepStore.add({
    clockId: clk,
    stepType: '调试',
    seq: 3,
    partIds: [],
    cleanSolvent: '',
    cleanMethod: '',
    oilType: '',
    oilPoints: '',
    torque: 0,
    troubleNote: '返修调试擒纵',
    operator: '王五',
    startedAt: Date.now(),
    state: 'pending',
  });

  // 合并资格不足：还没完成新工序
  rejected = false;
  try {
    await archiveStore.mergeRepair(snap(), '王五');
  } catch (e) {
    rejected = e instanceof ArchiveLockedError;
  }
  assert(rejected, '返修未完成新工序时合并被拒');

  await stepStore.finish(newStep.id);
  const openOrder = archiveStore.repairByClock(clk);
  assert(openOrder && openOrder.completedStepIds.length === 1, '返修单记录了 1 道新完成工序');

  // 仍缺合格测试
  rejected = false;
  try {
    await archiveStore.mergeRepair(snap(), '王五');
  } catch (e) {
    rejected = e instanceof ArchiveLockedError;
  }
  assert(rejected, '返修未补合格测试时合并被拒');

  // 补一次不合格测试也不行
  const badTest = await stepStore.addTest({
    clockId: clk,
    testedAt: Date.now(),
    amplitude: 200,
    beatError: 2,
    rate: 40,
    positions: [],
    powerReserve: 30,
    conclusion: '不合格',
  });
  rejected = false;
  try {
    await archiveStore.mergeRepair(snap(), '王五');
  } catch (e) {
    rejected = e instanceof ArchiveLockedError;
  }
  assert(rejected, '补的测试不合格时合并仍被拒');

  // 补合格测试
  await stepStore.addTest({
    clockId: clk,
    testedAt: Date.now(),
    amplitude: 270,
    beatError: 0.2,
    rate: 2,
    positions: [],
    powerReserve: 44,
    conclusion: '合格',
  });
  const openOrder2 = archiveStore.repairByClock(clk);
  assert(openOrder2 && openOrder2.passingTestIds.length === 1, '返修单记录了 1 次合格测试');

  // 但如果把工序回退导致不满足全完成，合并仍被拒
  await stepStore.rollback(newStep.id);
  rejected = false;
  try {
    await archiveStore.mergeRepair(snap(), '王五');
  } catch (e) {
    rejected = e instanceof ArchiveLockedError;
  }
  assert(rejected, '存在未完成工序时合并被拒（详情仍展示原正式档案）');
  await stepStore.finish(newStep.id);

  // 正式合并 v2
  const v2 = await archiveStore.mergeRepair(snap(), '王五', '返修调试完成');
  assert(v2.version === 2 && v2.status === 'sealed' && v2.source === 'repair', '合并生成 v2 正式档案（来源返修）');
  const mergedOrder = await db.repairs.get(order.id);
  assert(mergedOrder.status === 'merged' && mergedOrder.mergedVersion === 2, '返修单标记已合并到 v2');

  // 合并后再次写锁
  rejected = false;
  try {
    await stepStore.finish('stp1');
  } catch (e) {
    rejected = e instanceof ArchiveLockedError;
  }
  assert(rejected, 'v2 封存后再次进入只读');

  // 已合并返修单不能再开第二张（实际规则：没有 open 单可再开，这里验证状态归档）
  assert(!archiveStore.repairByClock(clk), '合并后无进行中返修单');

  // 沿革只增不改 & 筛选
  const all = await db.history.where('clockId').equals(clk).toArray();
  const categories = all.map((h: any) => h.category);
  assert(categories.includes('step') && categories.includes('test') && categories.includes('archive'), '沿革含工序/测试/档案分类');
  assert(all.every((h: any) => h.operator && typeof h.at === 'number'), '每条沿革有操作者与时间');
  const swap = all.find((h: any) => h.action === '交换工序顺序');
  assert(swap && swap.refs.length === 2 && swap.changes.length === 2 && swap.repairOrderId === order.id, '顺序调整记录关联工序、前后值并挂返修单');
  const partTest = all.find((h: any) => h.action === '录入走时测试');
  assert(partTest && partTest.changes.some((c: any) => c.field.includes('结论')), '测试沿革记录结论前后值');

  // v1/v2 快照都保留且不可变
  const vs = await db.archives.where('clockId').equals(clk).toArray();
  assert(vs.length === 2, '封存版 v1 + 返修合并版 v2 共 2 个不可变版本');
  assert(vs.every((v: any) => v.status === 'sealed'), '两个版本均为正式封存版');
  const v1Snap = vs.find((v: any) => v.version === 1);
  assert(v1Snap.steps.length === 2, 'v1 快照保持封存时的 2 道工序（后续返修不影响它）');

  console.log('\n🎉 全部生命周期断言通过');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
