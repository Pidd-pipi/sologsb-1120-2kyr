<script setup lang="ts">
import { computed, ref } from 'vue';
import type { HistoryEntry, HistoryCategory } from '../../types/archive';
import { HISTORY_CATEGORY_META, HISTORY_REF_META, HISTORY_TIME_KEYS } from '../../types/archive';
import { formatHistoryTime } from '../../utils/archive';

const props = defineProps<{
  entries: HistoryEntry[];
}>();

const categoryFilter = ref<HistoryCategory | 'all'>('all');

const filtered = computed(() =>
  categoryFilter.value === 'all'
    ? props.entries
    : props.entries.filter((it) => it.category === categoryFilter.value),
);

const counts = computed(() => ({
  step: props.entries.filter((it) => it.category === 'step').length,
  part: props.entries.filter((it) => it.category === 'part').length,
  test: props.entries.filter((it) => it.category === 'test').length,
  archive: props.entries.filter((it) => it.category === 'archive').length,
}));

function valueText(value: unknown, key?: string): string {
  if (value === undefined || value === null || value === '') return '—';
  if (key && HISTORY_TIME_KEYS.has(key) && typeof value === 'number') return formatHistoryTime(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}
</script>

<template>
  <div class="history">
    <div class="filters">
      <el-radio-group v-model="categoryFilter" size="small">
        <el-radio-button value="all">全部（{{ entries.length }}）</el-radio-button>
        <el-radio-button value="step">工序（{{ counts.step }}）</el-radio-button>
        <el-radio-button value="part">零件（{{ counts.part }}）</el-radio-button>
        <el-radio-button value="test">测试（{{ counts.test }}）</el-radio-button>
        <el-radio-button value="archive">档案（{{ counts.archive }}）</el-radio-button>
      </el-radio-group>
    </div>

    <el-empty v-if="filtered.length === 0" description="暂无该分类的维修沿革" :image-size="70" />

    <el-timeline v-else>
      <el-timeline-item
        v-for="e in filtered"
        :key="e.id"
        :timestamp="formatHistoryTime(e.at)"
        placement="top"
        :type="HISTORY_CATEGORY_META[e.category].tag"
      >
        <el-card shadow="never" class="entry" :data-testid="`history-${e.category}`">
          <div class="entry-head">
            <el-tag size="small" :type="HISTORY_CATEGORY_META[e.category].tag">
              {{ HISTORY_CATEGORY_META[e.category].label }}
            </el-tag>
            <strong>{{ e.action }}</strong>
            <el-tag size="small" effect="plain">操作者：{{ e.operator }}</el-tag>
            <el-tag v-if="e.repairOrderId" size="small" type="danger" effect="plain">返修期</el-tag>
          </div>
          <div v-if="e.refs.length" class="refs">
            <el-tag
              v-for="r in e.refs"
              :key="`${r.type}-${r.id}`"
              size="small"
              :type="HISTORY_REF_META[r.type].tag"
              effect="light"
              class="ref-tag"
            >
              {{ HISTORY_REF_META[r.type].label }}：{{ r.label }}
            </el-tag>
          </div>
          <el-table :data="e.changes" size="small" border class="changes">
            <el-table-column prop="field" label="项目" min-width="150" />
            <el-table-column label="变更前" min-width="160">
              <template #default="{ row }">
                <span class="before">{{ valueText(row.before, row.key) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="变更后" min-width="160">
              <template #default="{ row }">
                <span class="after">{{ valueText(row.after, row.key) }}</span>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="e.note" class="note">备注：{{ e.note }}</div>
        </el-card>
      </el-timeline-item>
    </el-timeline>
  </div>
</template>

<style scoped>
.filters {
  margin-bottom: 14px;
}
.entry {
  background: #fbfcfe;
}
.entry-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.refs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.ref-tag {
  max-width: 100%;
}
.changes {
  width: 100%;
}
.before {
  color: #a35a52;
}
.after {
  color: #2f7a3d;
  font-weight: 600;
}
.note {
  margin-top: 6px;
  color: #7b8592;
  font-size: 13px;
}
</style>
