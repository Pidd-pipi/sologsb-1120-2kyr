<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { readDbVersion } from './utils/db';
import { getOperator, setOperator } from './utils/operator';
import { db } from './utils/db';

const route = useRoute();
const router = useRouter();

const activeMenu = computed(() => {
  if (route.path.startsWith('/clocks')) return '/clocks';
  if (route.path.startsWith('/steps')) return '/steps/new';
  if (route.path.startsWith('/parts')) return '/parts';
  if (route.path.startsWith('/tests')) return '/tests';
  return '/clocks';
});

const version = readDbVersion();
const operator = ref(getOperator());
const operatorOptions = ref<string[]>([]);

onMounted(async () => {
  try {
    const entries = await db.history.toArray();
    operatorOptions.value = Array.from(new Set(entries.map((e) => e.operator).filter(Boolean)));
  } catch {
    /* 沿革表不可用时忽略 */
  }
});

function onOperator(value: string) {
  setOperator(value);
  operator.value = getOperator();
}

function onSelect(index: string) {
  if (index === '/tests') {
    void router.push('/tests/');
    return;
  }
  void router.push(index);
}
</script>

<template>
  <el-container class="app">
    <el-header class="app-header">
      <div class="brand">古钟表维修工序档案</div>
      <el-menu :default-active="activeMenu" mode="horizontal" class="menu" @select="onSelect">
        <el-menu-item index="/clocks">钟表台账</el-menu-item>
        <el-menu-item index="/steps/new">工序录入</el-menu-item>
        <el-menu-item index="/parts">零件清单</el-menu-item>
        <el-menu-item index="/tests">走时测试</el-menu-item>
      </el-menu>
      <div class="operator" title="当前操作者：维修沿革以此人记录">
        <span class="operator-label">操作者</span>
        <el-select
          :model-value="operator"
          size="small"
          filterable
          allow-create
          default-first-option
          placeholder="选择或输入操作者"
          style="width: 150px"
          @change="onOperator"
        >
          <el-option v-for="n in operatorOptions" :key="n" :label="n" :value="n" />
        </el-select>
      </div>
      <el-tag size="small" effect="plain">本地结构版本 v{{ version }}</el-tag>
    </el-header>
    <el-main class="app-main">
      <router-view />
    </el-main>
  </el-container>
</template>

<style scoped>
.app {
  min-height: 100vh;
  background: #f6f8fa;
}
.app-header {
  display: flex;
  align-items: center;
  gap: 18px;
  background: #2f3a46;
  color: #f4f6f8;
  height: 60px;
}
.brand {
  font-size: 18px;
  font-weight: 700;
  white-space: nowrap;
}
.menu {
  flex: 1;
  border-bottom: none;
  background: transparent;
}
:deep(.menu .el-menu-item) {
  color: #d6dde5;
}
:deep(.menu .el-menu-item.is-active) {
  color: #ffffff;
  border-bottom-color: #e7c56b;
}
.operator {
  display: flex;
  align-items: center;
  gap: 6px;
}
.operator-label {
  font-size: 13px;
  color: #c4ccd5;
  white-space: nowrap;
}
.app-main {
  padding: 18px 22px 40px;
}
</style>
