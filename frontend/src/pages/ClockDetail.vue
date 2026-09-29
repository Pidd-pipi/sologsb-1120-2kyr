<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClockStore } from '../stores/clockStore';
import { usePartStore } from '../stores/partStore';
import { useStepStore } from '../stores/stepStore';
import { useArchiveStore } from '../stores/archiveStore';
import { findSeqGaps } from '../utils/id';
import { ArchiveLockedError, isSealable, type ClockSnapshot } from '../utils/archive';
import { getOperator, setOperator } from '../utils/operator';
import StepSequence from '../components/common/StepSequence.vue';
import RateChart from '../components/common/RateChart.vue';
import StateBadge from '../components/common/StateBadge.vue';
import HistoryTimeline from '../components/common/HistoryTimeline.vue';
import { CONDITION_GRADES, type ConditionGrade } from '../types/clock';
import { judgeTest } from '../types/test';

const route = useRoute();
const router = useRouter();
const clockStore = useClockStore();
const partStore = usePartStore();
const stepStore = useStepStore();
const archiveStore = useArchiveStore();

const clockId = computed(() => String(route.params.id ?? ''));
const liveClock = computed(() => clockStore.byId(clockId.value));

const sealed = computed(() => archiveStore.sealedByClock(clockId.value));
const baseline = computed(() => archiveStore.baselineByClock(clockId.value));
const repair = computed(() => archiveStore.repairByClock(clockId.value));
const versions = computed(() => archiveStore.versionsByClock(clockId.value));
const historyEntries = computed(() => archiveStore.historyByClock(clockId.value));

/** 有正式档案时默认看正式档案，可切到返修中实时数据 */
const showLive = ref(false);
const mode = computed<'official' | 'live'>(() => (sealed.value && !showLive.value ? 'official' : 'live'));
const readonly = computed(() => mode.value === 'official');

const viewClock = computed(() => (readonly.value && sealed.value ? sealed.value.clock : liveClock.value));
const viewParts = computed(() =>
  readonly.value && sealed.value ? sealed.value.parts : partStore.byClock(clockId.value),
);
const viewSteps = computed(() =>
  readonly.value && sealed.value
    ? [...sealed.value.steps].sort((a, b) => a.seq - b.seq)
    : stepStore.byClock(clockId.value),
);
const viewTests = computed(() =>
  readonly.value && sealed.value
    ? [...sealed.value.tests].sort((a, b) => b.testedAt - a.testedAt)
    : stepStore.testsByClock(clockId.value),
);

const done = computed(() => viewSteps.value.filter((it) => it.state === 'done').length);
const total = computed(() => viewSteps.value.length);
const percent = computed(() => (total.value === 0 ? 0 : Math.round((done.value / total.value) * 100)));
const current = computed(() => viewSteps.value.find((it) => it.state !== 'done'));
const gaps = computed(() => findSeqGaps(viewSteps.value.map((it) => it.seq)));

function liveSnapshot(): ClockSnapshot | undefined {
  const clock = liveClock.value;
  if (!clock) return undefined;
  return {
    clock,
    parts: partStore.byClock(clockId.value),
    steps: stepStore.byClock(clockId.value),
    tests: stepStore.testsByClock(clockId.value),
  };
}

const liveSealable = computed(() => {
  const snap = liveSnapshot();
  return snap ? isSealable(snap) : false;
});

/** 返修合并条件：返修期新完成 >=1 道工序、补 >=1 次合格测试，且当前整体仍满足封存条件 */
const mergeReady = computed(
  () =>
    !!repair.value &&
    repair.value.completedStepIds.length > 0 &&
    repair.value.passingTestIds.length > 0 &&
    liveSealable.value,
);

const activeTab = ref('steps');
const sealDialog = ref(false);
const repairDialog = ref(false);
const mergeDialog = ref(false);
const sealNote = ref('');
const repairReason = ref('');
const mergeNote = ref('');
const dialogOperator = ref(getOperator());

function openSealDialog() {
  dialogOperator.value = getOperator();
  sealNote.value = '';
  sealDialog.value = true;
}
function openRepairDialog() {
  dialogOperator.value = getOperator();
  repairReason.value = '';
  repairDialog.value = true;
}
function openMergeDialog() {
  dialogOperator.value = getOperator();
  mergeNote.value = '';
  mergeDialog.value = true;
}

async function confirmSeal() {
  try {
    const snap = liveSnapshot();
    if (!snap) return;
    setOperator(dialogOperator.value);
    const v = await archiveStore.sealClock(snap, dialogOperator.value, sealNote.value);
    sealDialog.value = false;
    showLive.value = false;
    ElMessage.success(`已封存为正式档案 v${v.version}`);
  } catch (err) {
    ElMessage.error(err instanceof ArchiveLockedError ? err.message : '封存失败');
  }
}

async function confirmRepair() {
  if (!repairReason.value.trim()) {
    ElMessage.warning('请填写返修原因');
    return;
  }
  try {
    setOperator(dialogOperator.value);
    const order = await archiveStore.openRepair(clockId.value, repairReason.value, dialogOperator.value);
    repairDialog.value = false;
    showLive.value = true;
    ElMessage.success(`返修单 ${order.no} 已开立，可在返修中数据上修改`);
  } catch (err) {
    ElMessage.error(err instanceof ArchiveLockedError ? err.message : '开立返修单失败');
  }
}

async function confirmMerge() {
  try {
    const snap = liveSnapshot();
    if (!snap) return;
    setOperator(dialogOperator.value);
    const v = await archiveStore.mergeRepair(snap, dialogOperator.value, mergeNote.value);
    mergeDialog.value = false;
    showLive.value = false;
    ElMessage.success(`已合并为正式档案 v${v.version}，详情展示最新正式档案`);
  } catch (err) {
    ElMessage.error(err instanceof ArchiveLockedError ? err.message : '合并失败');
  }
}

function guard(err: unknown, fallback: string) {
  if (err instanceof ArchiveLockedError) ElMessage.error(err.message);
  else {
    console.error(err);
    ElMessage.error(fallback);
  }
}

async function finish(id: string) {
  try {
    await stepStore.finish(id);
    ElMessage.success('步骤已完成');
  } catch (err) {
    guard(err, '操作失败');
  }
}
async function rollback(id: string) {
  try {
    await stepStore.rollback(id);
    ElMessage.warning('步骤已回退');
  } catch (err) {
    guard(err, '操作失败');
  }
}
async function move(payload: { id: string; direction: 'up' | 'down' }) {
  try {
    const list = viewSteps.value;
    const index = list.findIndex((it) => it.id === payload.id);
    const target = payload.direction === 'up' ? list[index - 1] : list[index + 1];
    if (!target) return;
    await stepStore.swapSeq(payload.id, target.id);
    ElMessage.success('顺序已调整');
  } catch (err) {
    guard(err, '操作失败');
  }
}
async function reorder(payload: { fromId: string; toId: string }) {
  try {
    await stepStore.swapSeq(payload.fromId, payload.toId);
    ElMessage.success('已按拖拽交换顺序');
  } catch (err) {
    guard(err, '操作失败');
  }
}
async function changeGrade(value: unknown) {
  try {
    const grade = String(value) as ConditionGrade;
    await clockStore.setGrade(clockId.value, grade);
    ElMessage.success(`品相等级已更新为「${grade}」`);
  } catch (err) {
    guard(err, '操作失败');
  }
}

function goAddStep() {
  if (readonly.value) {
    ElMessage.info('当前展示正式档案，返修中请先切到「返修中数据」');
    return;
  }
  void router.push(`/steps/new?clockId=${clockId.value}`);
}
function goAddTest() {
  if (readonly.value) {
    ElMessage.info('当前展示正式档案，返修中请先切到「返修中数据」');
    return;
  }
  void router.push(`/tests/${clockId.value}`);
}

onMounted(async () => {
  await Promise.all([clockStore.load(), partStore.load(), stepStore.load(), archiveStore.load()]);
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>钟表详情 · {{ viewClock?.clockNo ?? '未找到' }}</h2>
      <StateBadge v-if="viewClock" :grade="viewClock.conditionGrade" />
      <el-tag v-if="sealed" type="success" effect="dark">正式档案 v{{ sealed.version }}</el-tag>
      <el-tag v-else-if="baseline" type="info" effect="plain">第 1 版基线 · 待封存</el-tag>
      <el-tag v-if="gaps.length" type="danger">顺序号缺口：{{ gaps.join('、') }}</el-tag>
      <el-tag v-else type="success" effect="plain">顺序号连续</el-tag>
      <div class="spacer" />
      <el-radio-group v-if="sealed" v-model="showLive" size="small">
        <el-radio-button :value="false">正式档案 v{{ sealed.version }}</el-radio-button>
        <el-radio-button :value="true">{{ repair ? '返修中数据' : '实时数据' }}</el-radio-button>
      </el-radio-group>
      <el-button type="primary" :disabled="readonly" @click="goAddStep">追加维修工序</el-button>
      <el-button :disabled="readonly" @click="goAddTest">走时测试录入</el-button>
      <el-button @click="router.push('/clocks')">返回台账</el-button>
    </div>

    <el-alert v-if="!viewClock" type="warning" :closable="false" title="未找到该钟表（可能已被删除）" show-icon />

    <!-- 档案状态横幅 -->
    <template v-if="viewClock">
      <el-alert
        v-if="sealed && !repair"
        type="success"
        :closable="false"
        show-icon
        :title="`正式档案 v${sealed.version} 已封存（${new Date(sealed.sealedAt).toLocaleString('zh-CN')} · ${sealed.sealedBy}），档案只读`"
        description="后续修改须先开返修单；返修中新完成一道工序并补一次合格测试后，才能合并为下一版正式档案。"
      >
        <template #default>
          <div class="banner-row">
            <span>正式档案只读。后续修改须先开返修单；返修中新完成一道工序并补一次合格测试后，才能合并为下一版正式档案。</span>
            <el-button size="small" type="danger" plain @click="openRepairDialog">开返修单</el-button>
          </div>
        </template>
      </el-alert>

      <el-alert v-else-if="sealed && repair" type="warning" :closable="false" show-icon :title="`返修单 ${repair.no} 进行中`">
        <template #default>
          <div class="banner-row">
            <span>
              返修原因：{{ repair.reason || '（未填写）' }} ｜ 已新完成工序
              <strong>{{ repair.completedStepIds.length }}</strong> 道、补合格测试
              <strong>{{ repair.passingTestIds.length }}</strong> 次。
              {{ mergeReady ? '已满足合并条件，可合并下一版。' : '两项均至少 1 次才可合并，未合并前详情默认展示原正式档案。' }}
            </span>
            <el-button size="small" type="primary" :disabled="!mergeReady" @click="openMergeDialog">
              合并下一版
            </el-button>
          </div>
        </template>
      </el-alert>

      <el-alert
        v-else-if="liveSealable"
        type="success"
        :closable="false"
        show-icon
        title="全部工序已完成且已有合格走时测试，满足封存条件"
      >
        <template #default>
          <div class="banner-row">
            <span>封存后档案只读，后续修改须先开返修单。</span>
            <el-button size="small" type="success" @click="openSealDialog">封存正式档案</el-button>
          </div>
        </template>
      </el-alert>

      <el-alert
        v-else-if="baseline"
        type="info"
        :closable="false"
        show-icon
        title="旧档已补录为第 1 版基线，尚未封存"
        description="工序全部完成并补一次合格走时测试后可封存为正式档案，封存前仍可直接修改。"
      />
    </template>

    <div v-if="viewClock" class="grid">
      <el-card shadow="never">
        <template #header>
          <div class="card-head">
            <strong>机芯信息</strong>
            <el-tag v-if="readonly" size="small" type="info" effect="plain">封存快照 · 只读</el-tag>
          </div>
        </template>
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="藏品号">{{ viewClock.clockNo }}</el-descriptions-item>
          <el-descriptions-item label="种类">{{ viewClock.kind }}</el-descriptions-item>
          <el-descriptions-item label="机芯型号">{{ viewClock.caliber }}</el-descriptions-item>
          <el-descriptions-item label="国别 / 制作者">{{ viewClock.origin }} / {{ viewClock.maker }}</el-descriptions-item>
          <el-descriptions-item label="年代">{{ viewClock.yearMade }}</el-descriptions-item>
          <el-descriptions-item label="钟壳材质">{{ viewClock.caseMaterial }}</el-descriptions-item>
          <el-descriptions-item label="尺寸 mm">{{ viewClock.size }}</el-descriptions-item>
          <el-descriptions-item label="盘面标识">{{ viewClock.dialMark }}</el-descriptions-item>
          <el-descriptions-item label="来源">{{ viewClock.acquireFrom }}</el-descriptions-item>
          <el-descriptions-item label="存放位置">{{ viewClock.storagePos }}</el-descriptions-item>
          <el-descriptions-item label="零件条目">{{ viewParts.length }} 项</el-descriptions-item>
        </el-descriptions>
        <div class="grade-row">
          <span>品相等级：</span>
          <el-radio-group
            :model-value="viewClock.conditionGrade"
            size="small"
            :disabled="readonly"
            @change="changeGrade"
          >
            <el-radio-button v-for="g in CONDITION_GRADES" :key="g" :value="g">{{ g }}</el-radio-button>
          </el-radio-group>
          <el-tag v-if="readonly" size="small" type="info">封存后不可改</el-tag>
        </div>

        <div v-if="versions.length" class="versions">
          <div class="versions-title">档案版本沿革</div>
          <el-tag
            v-for="v in [...versions].reverse()"
            :key="v.id"
            :type="v.status === 'sealed' ? 'success' : 'info'"
            size="small"
            class="version-tag"
          >
            v{{ v.version }} {{ v.status === 'sealed' ? `正式 · ${new Date(v.sealedAt).toLocaleDateString('zh-CN')}` : '基线' }}
            <span v-if="v.source === 'backfill'" class="version-src">（旧档补录）</span>
            <span v-else-if="v.source === 'repair'" class="version-src">（返修合并）</span>
          </el-tag>
        </div>
      </el-card>

      <div class="right">
        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <strong>修复进度</strong>
              <el-tag size="small">{{ done }}/{{ total }} · {{ percent }}%</el-tag>
              <span v-if="current" class="muted">
                当前卡点：#{{ current.seq }} {{ current.stepType }}（{{ current.operator }}）
              </span>
              <span v-else class="muted">全部步骤已完成</span>
            </div>
          </template>
          <el-progress :percentage="percent" :stroke-width="12" />
          <el-tabs v-model="activeTab" style="margin-top: 12px">
            <el-tab-pane label="工序顺序" name="steps">
              <StepSequence
                :items="viewSteps"
                :sortable="!readonly"
                :readonly="readonly"
                @finish="finish"
                @rollback="rollback"
                @move="move"
                @reorder="reorder"
              />
            </el-tab-pane>
            <el-tab-pane :label="`零件清单（${viewParts.length}）`" name="parts">
              <el-table :data="viewParts" size="small" border>
                <el-table-column prop="name" label="零件" width="110" />
                <el-table-column prop="position" label="装配位置" min-width="150" />
                <el-table-column prop="wearState" label="磨损" width="90" />
                <el-table-column prop="decision" label="处理" width="90" />
                <el-table-column prop="sourceLot" label="来源批号" width="120" />
                <el-table-column prop="dimension" label="尺寸 mm" width="100" />
              </el-table>
              <el-empty v-if="viewParts.length === 0" description="暂无零件登记" :image-size="60" />
            </el-tab-pane>
            <el-tab-pane :label="`走时测试（${viewTests.length}）`" name="tests">
              <div v-for="t in viewTests" :key="t.id" class="test-block">
                <div class="card-head">
                  <strong>{{ new Date(t.testedAt).toLocaleString('zh-CN') }}</strong>
                  <el-tag size="small" type="success">{{ t.conclusion || judgeTest(t.rate, t.beatError, t.amplitude) }}</el-tag>
                  <span class="muted">日差 {{ t.rate }} s/d · 摆幅 {{ t.amplitude }}° · 偏振 {{ t.beatError }} ms</span>
                </div>
                <RateChart :readings="t.positions" />
              </div>
              <el-empty v-if="viewTests.length === 0" description="暂无走时测试记录" :image-size="60" />
            </el-tab-pane>
            <el-tab-pane :label="`维修沿革（${historyEntries.length}）`" name="history">
              <el-alert
                type="info"
                :closable="false"
                show-icon
                title="沿革只增不改：记录每一次工序顺序调整、零件决定与测试结论的操作者、时间、关联记录与前后值"
                style="margin-bottom: 12px"
              />
              <HistoryTimeline :entries="historyEntries" />
            </el-tab-pane>
          </el-tabs>
        </el-card>
      </div>
    </div>

    <!-- 封存对话框 -->
    <el-dialog v-model="sealDialog" title="封存正式档案" width="520px">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        :title="baseline ? '旧档基线满足条件，封存后占用第 1 版正式档案' : '封存后生成正式档案，档案只读'"
        style="margin-bottom: 12px"
      />
      <el-form label-width="90px">
        <el-form-item label="操作者" required>
          <el-input v-model="dialogOperator" placeholder="封存操作者" />
        </el-form-item>
        <el-form-item label="封存说明">
          <el-input v-model="sealNote" type="textarea" :rows="3" placeholder="可选，默认「全部工序完成且已有合格测试，封存为正式档案」" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="sealDialog = false">取消</el-button>
        <el-button type="success" @click="confirmSeal">确认封存</el-button>
      </template>
    </el-dialog>

    <!-- 返修单对话框 -->
    <el-dialog v-model="repairDialog" title="开立返修单" width="520px">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        :title="`基于正式档案 v${sealed?.version ?? ''} 开立，开立后方可修改工序、零件与测试`"
        description="返修中新完成一道工序并补一次合格测试，才能合并为下一版；未合并前详情仍展示原正式档案。"
        style="margin-bottom: 12px"
      />
      <el-form label-width="90px">
        <el-form-item label="操作者" required>
          <el-input v-model="dialogOperator" placeholder="返修负责人" />
        </el-form-item>
        <el-form-item label="返修原因" required>
          <el-input v-model="repairReason" type="textarea" :rows="3" placeholder="如 走时复检发现日差偏大，重新调试擒纵机构" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="repairDialog = false">取消</el-button>
        <el-button type="danger" @click="confirmRepair">开立返修单</el-button>
      </template>
    </el-dialog>

    <!-- 合并对话框 -->
    <el-dialog v-model="mergeDialog" title="返修合并下一版" width="520px">
      <el-alert
        type="success"
        :closable="false"
        show-icon
        :title="`合并后生成正式档案 v${(sealed?.version ?? 0) + 1}`"
        style="margin-bottom: 12px"
      />
      <el-descriptions :column="1" border size="small" style="margin-bottom: 12px">
        <el-descriptions-item label="返修单号">{{ repair?.no }}</el-descriptions-item>
        <el-descriptions-item label="新完成工序">{{ repair?.completedStepIds.length }} 道</el-descriptions-item>
        <el-descriptions-item label="补合格测试">{{ repair?.passingTestIds.length }} 次</el-descriptions-item>
      </el-descriptions>
      <el-form label-width="90px">
        <el-form-item label="操作者" required>
          <el-input v-model="dialogOperator" />
        </el-form-item>
        <el-form-item label="版本说明">
          <el-input v-model="mergeNote" type="textarea" :rows="3" :placeholder="`默认「返修单 ${repair?.no ?? ''} 合并为正式档案」`" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="mergeDialog = false">取消</el-button>
        <el-button type="primary" @click="confirmMerge">确认合并</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.header h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.grid {
  display: grid;
  grid-template-columns: 380px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.right {
  min-width: 0;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.grade-row {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.test-block {
  margin-bottom: 16px;
}
.banner-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.versions {
  margin-top: 14px;
}
.versions-title {
  font-size: 13px;
  color: #7b8592;
  margin-bottom: 6px;
}
.version-tag {
  margin: 0 6px 6px 0;
}
.version-src {
  color: #97a0ad;
  font-size: 12px;
}
</style>
