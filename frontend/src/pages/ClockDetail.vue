<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClockStore } from '../stores/clockStore';
import { usePartStore } from '../stores/partStore';
import { useStepStore } from '../stores/stepStore';
import { useArchiveStore } from '../stores/archiveStore';
import StepSequence from '../components/common/StepSequence.vue';
import RateChart from '../components/common/RateChart.vue';
import StateBadge from '../components/common/StateBadge.vue';
import { CONDITION_GRADES, type ConditionGrade } from '../types/clock';
import { judgeTest } from '../types/test';
import {
  HISTORY_ACTION_LABELS,
  HISTORY_ENTITY_LABELS,
  type HistoryEntityType,
  type HistoryEvent,
} from '../types/archive';
import { readOperator } from '../utils/operator';
import { isQualifyingTest } from '../utils/db';
import { findSeqGaps } from '../utils/id';

const route = useRoute();
const router = useRouter();
const clockStore = useClockStore();
const partStore = usePartStore();
const stepStore = useStepStore();
const archiveStore = useArchiveStore();

const clockId = computed(() => String(route.params.id ?? ''));
const liveClock = computed(() => clockStore.byId(clockId.value));
const liveParts = computed(() => partStore.byClock(clockId.value));
const liveTests = computed(() => stepStore.testsByClock(clockId.value));
const liveSteps = computed(() => stepStore.byClock(clockId.value));

const latestArchive = computed(() => archiveStore.latestArchive(clockId.value));
const sealedArchive = computed(() => archiveStore.latestSealedArchive(clockId.value));
const activeRepair = computed(() => archiveStore.activeRepairOrder(clockId.value));
const isSealed = computed(() => Boolean(sealedArchive.value));
const isFormalView = ref(true);
const viewingArchive = computed(() => (isFormalView.value ? sealedArchive.value : undefined));

const clock = computed(() => viewingArchive.value?.snapshot.clock ?? liveClock.value);
const parts = computed(() => viewingArchive.value?.snapshot.parts ?? liveParts.value);
const steps = computed(() => viewingArchive.value?.snapshot.steps ?? liveSteps.value);
const tests = computed(() => viewingArchive.value?.snapshot.tests ?? liveTests.value);
const canEdit = computed(() => !isSealed.value || Boolean(activeRepair.value));

const gaps = computed(() => findSeqGaps(steps.value.map((step) => step.seq)));
const activeTab = ref('steps');
const historyFilter = ref<HistoryEntityType | 'all'>('all');
const repairReason = ref('');
const mergeRunning = ref(false);

const displayedDone = computed(() => steps.value.filter((it) => it.state === 'done').length);
const displayedPercent = computed(() =>
  steps.value.length === 0 ? 0 : Math.round((displayedDone.value / steps.value.length) * 100),
);
const displayedCurrent = computed(() => steps.value.find((it) => it.state !== 'done'));

const filteredHistory = computed(() => {
  const events = archiveStore.eventsByClock(clockId.value);
  return historyFilter.value === 'all'
    ? events
    : events.filter((event) => event.entityType === historyFilter.value);
});

const canMerge = computed(() => {
  if (!activeRepair.value) return false;
  return (
    liveSteps.value.length > 0 &&
    liveSteps.value.every((step) => step.state === 'done') &&
    liveTests.value.some((test) => test.testedAt >= activeRepair.value!.openedAt && isQualifyingTest(test))
  );
});

watch(clockId, () => {
  isFormalView.value = true;
  activeTab.value = 'steps';
  historyFilter.value = 'all';
  repairReason.value = '';
});

function formatTime(value?: number): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—';
}

function eventTitle(event: HistoryEvent): string {
  return `${HISTORY_ACTION_LABELS[event.action]} · ${HISTORY_ENTITY_LABELS[event.entityType]}`;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

async function finish(id: string) {
  try {
    await stepStore.finish(id, readOperator());
    ElMessage.success('步骤已完成');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败');
  }
}
async function rollback(id: string) {
  try {
    await stepStore.rollback(id, readOperator());
    ElMessage.warning('步骤已回退');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败');
  }
}
async function move(payload: { id: string; direction: 'up' | 'down' }) {
  const list = steps.value;
  const index = list.findIndex((it) => it.id === payload.id);
  const target = payload.direction === 'up' ? list[index - 1] : list[index + 1];
  if (!target) return;
  try {
    await stepStore.swapSeq(payload.id, target.id, readOperator());
    ElMessage.success('顺序已调整');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败');
  }
}
async function reorder(payload: { fromId: string; toId: string }) {
  try {
    await stepStore.swapSeq(payload.fromId, payload.toId, readOperator());
    ElMessage.success('已按拖拽交换顺序');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败');
  }
}
async function changeGrade(value: unknown) {
  const grade = String(value) as ConditionGrade;
  try {
    await clockStore.setGrade(clockId.value, grade, readOperator());
    ElMessage.success(`品相等级已更新为「${grade}」`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败');
  }
}

async function openRepair() {
  const operator = readOperator();
  if (!operator) {
    ElMessage.error('请先在顶部填写操作者');
    return;
  }
  try {
    const { value } = await ElMessageBox.prompt('请填写返修原因', `为 ${liveClock.value?.clockNo ?? ''} 开立返修单`, {
      confirmButtonText: '开立',
      cancelButtonText: '取消',
      inputValue: repairReason.value,
      inputValidator: (value) => Boolean(value?.trim()) || '返修原因必填',
    });
    repairReason.value = value;
    await archiveStore.openRepair(clockId.value, value, operator);
    ElMessage.success('返修单已开立，可继续修改');
  } catch (error) {
    if (error !== 'cancel' && error instanceof Error) ElMessage.error(error.message);
  }
}

async function cancelRepair() {
  try {
    await archiveStore.cancelRepair(clockId.value, readOperator());
    isFormalView.value = true;
    ElMessage.warning('返修单已取消，仍展示原正式档案');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败');
  }
}

async function mergeRepair() {
  mergeRunning.value = true;
  try {
    const archive = await archiveStore.mergeRepair(clockId.value, readOperator());
    isFormalView.value = true;
    ElMessage.success(`已合并并封存第 ${archive.version} 版`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '合并失败');
  } finally {
    mergeRunning.value = false;
  }
}

onMounted(async () => {
  await clockStore.load();
  await partStore.load();
  await stepStore.load();
  await archiveStore.load();
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>钟表详情 · {{ clock?.clockNo ?? '未找到' }}</h2>
      <StateBadge v-if="clock" :grade="clock.conditionGrade" />
      <el-tag v-if="latestArchive?.status === 'sealed'" type="success">
        正式档案 v{{ latestArchive.version }}
      </el-tag>
      <el-tag v-else-if="latestArchive?.status === 'draft'" type="warning">
        第 1 版待封存
      </el-tag>
      <el-tag v-if="activeRepair" type="warning">返修中 · 基于 v{{ activeRepair.fromVersion }}</el-tag>
      <el-tag v-if="gaps.length && !viewingArchive" type="danger">顺序号缺口：{{ gaps.join('、') }}</el-tag>
      <el-tag v-else type="success" effect="plain">顺序号连续</el-tag>
      <div class="spacer" />
      <el-radio-group v-if="isSealed" v-model="isFormalView" size="small">
        <el-radio-button :value="true">原正式档案</el-radio-button>
        <el-radio-button :value="false">当前返修数据</el-radio-button>
      </el-radio-group>
      <el-button v-if="isSealed && !activeRepair" type="warning" @click="openRepair">开返修单</el-button>
      <el-button v-if="activeRepair" type="success" :disabled="!canMerge" :loading="mergeRunning" @click="mergeRepair">
        合并下一版
      </el-button>
      <el-button v-if="activeRepair" @click="cancelRepair">取消返修</el-button>
      <el-button
        type="primary"
        :disabled="!canEdit || !isFormalView"
        @click="router.push(`/steps/new?clockId=${clockId}`)"
      >
        追加维修工序
      </el-button>
      <el-button
        :disabled="!canEdit || !isFormalView"
        @click="router.push(`/tests/${clockId}`)"
      >
        走时测试录入
      </el-button>
      <el-button @click="router.push('/clocks')">返回台账</el-button>
    </div>

    <el-alert
      v-if="latestArchive?.status === 'sealed' && !activeRepair"
      type="success"
      :closable="false"
      show-icon
      title="正式档案已封存；后续修改需先开立返修单。"
    />
    <el-alert
      v-else-if="activeRepair && isFormalView"
      type="warning"
      :closable="false"
      show-icon
      title="返修尚未合并，详情仍展示原正式档案；可切换查看当前返修数据。"
    />
    <el-alert
      v-else-if="activeRepair && !isFormalView"
      type="warning"
      :closable="false"
      show-icon
      title="当前为返修工作数据；完成一道新工序并补一次合格测试后才能合并下一版。"
    />

    <el-alert v-if="!clock" type="warning" :closable="false" title="未找到该钟表（可能已被删除）" show-icon />

    <div v-if="clock" class="grid">
      <el-card shadow="never">
        <template #header>
          <div class="card-head">
            <strong>机芯信息</strong>
            <el-tag v-if="viewingArchive" size="small" type="success">快照 v{{ viewingArchive.version }}</el-tag>
          </div>
        </template>
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="藏品号">{{ clock.clockNo }}</el-descriptions-item>
          <el-descriptions-item label="种类">{{ clock.kind }}</el-descriptions-item>
          <el-descriptions-item label="机芯型号">{{ clock.caliber }}</el-descriptions-item>
          <el-descriptions-item label="国别 / 制作者">{{ clock.origin }} / {{ clock.maker }}</el-descriptions-item>
          <el-descriptions-item label="年代">{{ clock.yearMade }}</el-descriptions-item>
          <el-descriptions-item label="钟壳材质">{{ clock.caseMaterial }}</el-descriptions-item>
          <el-descriptions-item label="尺寸 mm">{{ clock.size }}</el-descriptions-item>
          <el-descriptions-item label="盘面标识">{{ clock.dialMark }}</el-descriptions-item>
          <el-descriptions-item label="来源">{{ clock.acquireFrom }}</el-descriptions-item>
          <el-descriptions-item label="存放位置">{{ clock.storagePos }}</el-descriptions-item>
          <el-descriptions-item label="零件条目">{{ parts.length }} 项</el-descriptions-item>
        </el-descriptions>
        <div class="grade-row">
          <span>品相等级：</span>
          <el-radio-group
            :model-value="clock.conditionGrade"
            size="small"
            :disabled="!canEdit || Boolean(viewingArchive)"
            @change="changeGrade"
          >
            <el-radio-button v-for="g in CONDITION_GRADES" :key="g" :value="g">{{ g }}</el-radio-button>
          </el-radio-group>
        </div>
      </el-card>

      <div class="right">
        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <strong>修复进度</strong>
              <el-tag size="small">{{ displayedDone }}/{{ steps.length }} · {{ displayedPercent }}%</el-tag>
              <span v-if="displayedCurrent" class="muted">
                当前卡点：#{{ displayedCurrent.seq }} {{ displayedCurrent.stepType }}（{{ displayedCurrent.operator }}）
              </span>
              <span v-else class="muted">全部步骤已完成</span>
            </div>
          </template>
          <el-progress :percentage="displayedPercent" :stroke-width="12" />
          <el-tabs v-model="activeTab" style="margin-top: 12px">
            <el-tab-pane label="工序顺序" name="steps">
              <StepSequence
                :items="steps"
                :sortable="canEdit && !viewingArchive"
                :interactive="canEdit && !viewingArchive"
                @finish="finish"
                @rollback="rollback"
                @move="move"
                @reorder="reorder"
              />
            </el-tab-pane>
            <el-tab-pane :label="`零件清单（${parts.length}）`" name="parts">
              <el-table :data="parts" size="small" border>
                <el-table-column prop="name" label="零件" width="110" />
                <el-table-column prop="position" label="装配位置" min-width="150" />
                <el-table-column prop="wearState" label="磨损" width="90" />
                <el-table-column prop="decision" label="处理" width="90" />
                <el-table-column prop="sourceLot" label="来源批号" width="120" />
                <el-table-column prop="dimension" label="尺寸 mm" width="100" />
              </el-table>
              <el-empty v-if="parts.length === 0" description="暂无零件登记" :image-size="60" />
            </el-tab-pane>
            <el-tab-pane :label="`走时测试（${tests.length}）`" name="tests">
              <div v-for="t in tests" :key="t.id" class="test-block">
                <div class="card-head">
                  <strong>{{ formatTime(t.testedAt) }}</strong>
                  <el-tag size="small" :type="t.conclusion === '合格' ? 'success' : 'warning'">
                    {{ t.conclusion || judgeTest(t.rate, t.beatError, t.amplitude) }}
                  </el-tag>
                  <span class="muted">日差 {{ t.rate }} s/d · 摆幅 {{ t.amplitude }}° · 偏振 {{ t.beatError }} ms</span>
                </div>
                <RateChart :readings="t.positions" />
              </div>
              <el-empty v-if="tests.length === 0" description="暂无走时测试记录" :image-size="60" />
            </el-tab-pane>
            <el-tab-pane label="维修沿革" name="history">
              <div class="history-filter">
                <el-radio-group v-model="historyFilter" size="small">
                  <el-radio-button value="all">全部</el-radio-button>
                  <el-radio-button value="step">工序</el-radio-button>
                  <el-radio-button value="part">零件</el-radio-button>
                  <el-radio-button value="test">测试</el-radio-button>
                  <el-radio-button value="archive">档案</el-radio-button>
                  <el-radio-button value="repair">返修单</el-radio-button>
                  <el-radio-button value="clock">钟表</el-radio-button>
                </el-radio-group>
              </div>
              <el-timeline>
                <el-timeline-item
                  v-for="event in filteredHistory"
                  :key="event.id"
                  :timestamp="formatTime(event.at)"
                  placement="top"
                  :type="event.repairOrderId ? 'warning' : event.entityType === 'archive' ? 'success' : 'primary'"
                >
                  <el-card shadow="never" class="history-card">
                    <div class="card-head">
                      <strong>{{ eventTitle(event) }}</strong>
                      <el-tag size="small">{{ event.actor }}</el-tag>
                      <el-tag v-if="event.repairOrderId" size="small" type="warning">返修中</el-tag>
                    </div>
                    <p v-if="event.note" class="muted">{{ event.note }}</p>
                    <p class="muted">关联记录：{{ event.relatedIds?.join('、') || event.entityId || '—' }}</p>
                    <el-descriptions :column="1" size="small" border>
                      <el-descriptions-item label="前值">
                        <pre>{{ stringifyValue(event.before) }}</pre>
                      </el-descriptions-item>
                      <el-descriptions-item label="后值">
                        <pre>{{ stringifyValue(event.after) }}</pre>
                      </el-descriptions-item>
                    </el-descriptions>
                  </el-card>
                </el-timeline-item>
              </el-timeline>
              <el-empty v-if="filteredHistory.length === 0" description="暂无符合筛选的沿革" :image-size="60" />
            </el-tab-pane>
          </el-tabs>
        </el-card>
      </div>
    </div>
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
}
.test-block {
  margin-bottom: 16px;
}
.history-filter {
  margin-bottom: 14px;
}
.history-card {
  margin-bottom: 4px;
}
.history-card pre {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
}
</style>
