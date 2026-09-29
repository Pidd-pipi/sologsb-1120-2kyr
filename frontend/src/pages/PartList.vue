<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useClockStore } from '../stores/clockStore';
import { usePartStore } from '../stores/partStore';
import { useArchiveStore } from '../stores/archiveStore';
import StateBadge from '../components/common/StateBadge.vue';
import { readOperator } from '../utils/operator';
import {
  PART_DECISIONS,
  PART_NAMES,
  WEAR_STATES,
  type MovementPartDraft,
  type PartDecision,
  type PartName,
  type WearState,
} from '../types/part';

const clockStore = useClockStore();
const partStore = usePartStore();
const archiveStore = useArchiveStore();

const wearFilter = ref<WearState | 'all'>('all');
const clockFilter = ref('all');
const onlyPending = ref(false);
const dialogVisible = ref(false);
const error = ref('');

const form = reactive<MovementPartDraft>({
  clockId: '',
  name: '发条',
  qtyNeeded: 1,
  position: '',
  wearState: '磨损',
  decision: '修配',
  sourceLot: '',
  dimension: 1,
});

const rows = computed(() =>
  partStore.items.filter((p) => {
    if (wearFilter.value !== 'all' && p.wearState !== wearFilter.value) return false;
    if (clockFilter.value !== 'all' && p.clockId !== clockFilter.value) return false;
    if (onlyPending.value && !(p.decision !== '保留' && p.wearState !== '完好')) return false;
    return true;
  }),
);

const groups = computed(() =>
  WEAR_STATES.map((state) => ({ state, rows: rows.value.filter((p) => p.wearState === state) })),
);

const pendingCount = computed(
  () => partStore.items.filter((p) => p.decision !== '保留' && p.wearState !== '完好').length,
);

function clockNo(clockId: string): string {
  return clockStore.byId(clockId)?.clockNo ?? '未知钟表';
}

function lockedFor(clockId: string): boolean {
  return Boolean(archiveStore.latestSealedArchive(clockId)) && !archiveStore.activeRepairOrder(clockId);
}

const selectedLocked = computed(() => clockFilter.value !== 'all' && lockedFor(clockFilter.value));

function openDialog() {
  dialogVisible.value = true;
  error.value = '';
  form.clockId = clockFilter.value !== 'all' ? clockFilter.value : clockStore.items[0]?.id ?? '';
}

async function submit() {
  if (!form.clockId) {
    error.value = '请选择所属钟表';
    return;
  }
  if (!form.position.trim()) {
    error.value = '装配位置必填';
    return;
  }
  const operator = readOperator();
  if (!operator) {
    error.value = '请先在顶部填写操作者';
    return;
  }
  if (lockedFor(form.clockId)) {
    error.value = '正式档案已封存，请先在详情页开立返修单';
    return;
  }
  try {
    await partStore.add(
      {
        ...form,
        position: form.position.trim(),
        sourceLot: form.decision === '换新' ? form.sourceLot.trim() : form.sourceLot.trim(),
      },
      operator,
    );
    dialogVisible.value = false;
    ElMessage.success('已登记零件');
    form.position = '';
    form.sourceLot = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败';
  }
}

async function setDecision(id: string, decision: PartDecision) {
  try {
    await partStore.update(id, { decision }, readOperator());
    ElMessage.success(`处理决定已改为「${decision}」`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败');
  }
}

onMounted(async () => {
  await clockStore.load();
  await partStore.load();
  await archiveStore.load();
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>零件与配换清单</h2>
      <el-tag>共 {{ partStore.items.length }} 项</el-tag>
      <el-tag type="warning">待修配 {{ pendingCount }} 项</el-tag>
      <div class="spacer" />
      <el-button type="primary" @click="openDialog">登记零件</el-button>
    </div>

    <el-card shadow="never">
      <el-form :inline="true" @submit.prevent>
        <el-form-item label="钟表">
          <el-select v-model="clockFilter" style="width: 220px">
            <el-option label="全部" value="all" />
            <el-option v-for="c in clockStore.items" :key="c.id" :label="c.clockNo" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="磨损状态">
          <el-select v-model="wearFilter" style="width: 140px">
            <el-option label="全部" value="all" />
            <el-option v-for="w in WEAR_STATES" :key="w" :label="w" :value="w" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="onlyPending">只看待修配</el-checkbox>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card v-for="group in groups" :key="group.state" shadow="never">
      <template #header>
        <div class="card-head">
          <strong>{{ group.state }}</strong>
          <el-tag size="small" type="info">{{ group.rows.length }} 项</el-tag>
        </div>
      </template>
      <el-table :data="group.rows" size="small" border>
        <el-table-column label="钟表" width="150">
          <template #default="{ row }">{{ clockNo(row.clockId) }}</template>
        </el-table-column>
        <el-table-column prop="name" label="零件" width="110" />
        <el-table-column prop="qtyNeeded" label="数量" width="80" />
        <el-table-column prop="position" label="装配位置" min-width="160" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <StateBadge :label="row.wearState" :tone="row.wearState === '完好' ? 'success' : 'danger'" />
          </template>
        </el-table-column>
        <el-table-column label="处理决定" width="200">
          <template #default="{ row }">
            <el-radio-group
              :model-value="row.decision"
              size="small"
              :disabled="lockedFor(row.clockId)"
              @change="(v: unknown) => setDecision(row.id, String(v) as PartDecision)"
            >
              <el-radio-button v-for="d in PART_DECISIONS" :key="d" :value="d">{{ d }}</el-radio-button>
            </el-radio-group>
          </template>
        </el-table-column>
        <el-table-column prop="sourceLot" label="配换来源批号" width="150" />
        <el-table-column prop="dimension" label="关键尺寸 mm" width="120" />
        <el-table-column label="档案状态" width="110">
          <template #default="{ row }">
            <el-tag v-if="lockedFor(row.clockId)" type="success" size="small">已封存</el-tag>
            <el-tag v-else-if="archiveStore.activeRepairOrder(row.clockId)" type="warning" size="small">返修中</el-tag>
            <el-tag v-else type="info" size="small">可修改</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="待配" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.decision !== '保留' && row.wearState !== '完好'" type="warning" size="small">待修配</el-tag>
            <span v-else>—</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="group.rows.length === 0" description="该状态暂无零件" :image-size="60" />
    </el-card>

    <el-dialog v-model="dialogVisible" title="登记零件" width="560px">
      <el-alert v-if="error" :title="error" type="error" :closable="false" style="margin-bottom: 10px" />
      <el-alert
        v-if="selectedLocked"
        title="该钟表正式档案已封存，请先在详情页开立返修单。"
        type="error"
        :closable="false"
        style="margin-bottom: 10px"
      />
      <el-form :model="form" label-width="110px" :disabled="selectedLocked">
        <el-form-item label="所属钟表">
          <el-select v-model="form.clockId" style="width: 100%">
            <el-option v-for="c in clockStore.items" :key="c.id" :label="c.clockNo" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="零件名称">
          <el-select v-model="form.name" style="width: 100%">
            <el-option v-for="n in PART_NAMES" :key="n" :label="n" :value="n" />
          </el-select>
        </el-form-item>
        <el-form-item label="数量">
          <el-input-number v-model="form.qtyNeeded" :min="1" :max="999" />
        </el-form-item>
        <el-form-item label="装配位置" required>
          <el-input v-model="form.position" placeholder="如 二轮上下轴孔" />
        </el-form-item>
        <el-form-item label="磨损状态">
          <el-select v-model="form.wearState" style="width: 100%">
            <el-option v-for="w in WEAR_STATES" :key="w" :label="w" :value="w" />
          </el-select>
        </el-form-item>
        <el-form-item label="处理决定">
          <el-select v-model="form.decision" style="width: 100%">
            <el-option v-for="d in PART_DECISIONS" :key="d" :label="d" :value="d" />
          </el-select>
        </el-form-item>
        <el-form-item label="来源批号">
          <el-input v-model="form.sourceLot" placeholder="如 MS-2024-07" />
        </el-form-item>
        <el-form-item label="关键尺寸 mm">
          <el-input-number v-model="form.dimension" :min="0" :max="200" :step="0.1" :precision="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
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
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
</style>
