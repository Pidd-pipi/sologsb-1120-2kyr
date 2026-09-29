<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { readDbVersion } from './utils/db';
import { readOperator, writeOperator } from './utils/operator';
import { useArchiveStore } from './stores/archiveStore';

const route = useRoute();
const router = useRouter();
const archiveStore = useArchiveStore();
const operator = ref(readOperator());

const activeMenu = computed(() => {
  if (route.path.startsWith('/clocks')) return '/clocks';
  if (route.path.startsWith('/steps')) return '/steps/new';
  if (route.path.startsWith('/parts')) return '/parts';
  if (route.path.startsWith('/tests')) return '/tests';
  return '/clocks';
});

const version = readDbVersion();

function onSelect(index: string) {
  if (index === '/tests') {
    void router.push('/tests/');
    return;
  }
  void router.push(index);
}

function saveOperator(value: string) {
  operator.value = value.trim();
  writeOperator(operator.value);
}

onMounted(() => {
  void archiveStore.load();
});
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
      <el-input
        :model-value="operator"
        class="operator-input"
        placeholder="操作者姓名"
        clearable
        @change="saveOperator"
      />
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
.operator-input {
  width: 150px;
  margin-right: 10px;
}
:deep(.operator-input .el-input__wrapper) {
  background: #46525f;
  box-shadow: 0 0 0 1px #5f6b78 inset;
}
:deep(.operator-input .el-input__inner) {
  color: #f4f6f8;
}
:deep(.operator-input .el-input__inner::placeholder) {
  color: #b5bec8;
}
:deep(.menu .el-menu-item) {
  color: #d6dde5;
}
:deep(.menu .el-menu-item.is-active) {
  color: #ffffff;
  border-bottom-color: #e7c56b;
}
.app-main {
  padding: 18px 22px 40px;
}
</style>
