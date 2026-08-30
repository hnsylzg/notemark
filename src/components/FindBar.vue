<script setup lang="ts">
/*
 * FindBar.vue — 查找 / 替换浮层（Typora 风格，贴在工具栏右下方）
 *
 * 组件只负责展示与事件派发：
 * - 搜索词、匹配结果、高亮全部由 App.vue 通过 ProseMirror 插件维护；
 * - 本组件把「上一个 / 下一个 / 替换 / 全部替换 / 选项开关」原样抛出。
 *
 * 键盘：Enter 下一个、Shift+Enter 上一个、Esc 关闭（均由本组件拦截，
 * 焦点在输入框内时也不会冒泡到 App 的全局快捷键）。
 */
import { computed, ref, watch, nextTick } from "vue";

const props = defineProps<{
  /** 是否显示 */
  open: boolean;
  /** 是否展开替换行 */
  replaceMode: boolean;
  /** 当前查询词 */
  query: string;
  /** 替换文本 */
  replacement: string;
  /** 区分大小写 */
  caseSensitive: boolean;
  /** 全字匹配 */
  wholeWord: boolean;
  /** 匹配总数 */
  matchCount: number;
  /** 当前匹配下标（0 起；-1 表示无匹配） */
  matchIndex: number;
}>();

const emit = defineEmits<{
  (e: "update:query", value: string): void;
  (e: "update:replacement", value: string): void;
  /** 切换区分大小写（父组件持有状态，这里只通知翻转） */
  (e: "toggle-case"): void;
  /** 切换全字匹配 */
  (e: "toggle-word"): void;
  (e: "prev"): void;
  (e: "next"): void;
  (e: "replace"): void;
  (e: "replace-all"): void;
  (e: "close"): void;
}>();

const findInput = ref<HTMLInputElement | null>(null);

/** 结果计数文案；无查询词时留空，避免一打开就显示刺眼的「无结果」 */
const countText = computed(() => {
  if (!props.query) return "";
  if (props.matchCount === 0) return "无结果";
  return props.matchIndex >= 0
    ? `${props.matchIndex + 1}/${props.matchCount}`
    : `${props.matchCount} 个结果`;
});

/** 无匹配时计数文案转为警示色 */
const noResult = computed(() => !!props.query && props.matchCount === 0);

/** 打开时聚焦查找框并全选，方便直接覆盖上一次的查询词 */
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    nextTick(() => {
      findInput.value?.focus();
      findInput.value?.select();
    });
  },
  { immediate: true }
);

/** 供父组件在源码模式下把焦点从 textarea 收回来 */
function focusInput() {
  findInput.value?.focus();
}
defineExpose({ focusInput });

function onInput(e: Event, target: "query" | "replacement") {
  const value = (e.target as HTMLInputElement).value;
  if (target === "query") emit("update:query", value);
  else emit("update:replacement", value);
}
</script>

<template>
  <div v-if="open" class="mt-find" @keydown.esc.stop.prevent="emit('close')">
    <div class="mt-find__row">
      <input
        ref="findInput"
        class="mt-find__input"
        type="text"
        :value="query"
        placeholder="查找"
        spellcheck="false"
        aria-label="查找内容"
        @input="onInput($event, 'query')"
        @keydown.enter.exact.prevent="emit('next')"
        @keydown.enter.shift.prevent="emit('prev')"
      />
      <span
        class="mt-find__count"
        :class="{ 'mt-find__count--empty': noResult }"
        aria-live="polite"
      >{{ countText }}</span>

      <button
        class="mt-find__btn"
        type="button"
        title="上一个匹配（Shift+Enter）"
        aria-label="上一个匹配"
        :disabled="!matchCount"
        @click="emit('prev')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>
      <button
        class="mt-find__btn"
        type="button"
        title="下一个匹配（Enter）"
        aria-label="下一个匹配"
        :disabled="!matchCount"
        @click="emit('next')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      <button
        class="mt-find__btn mt-find__btn--text"
        :class="{ 'mt-find__btn--on': caseSensitive }"
        type="button"
        title="区分大小写"
        aria-label="区分大小写"
        :aria-pressed="caseSensitive"
        @click="emit('toggle-case')"
      >Aa</button>
      <button
        class="mt-find__btn mt-find__btn--text"
        :class="{ 'mt-find__btn--on': wholeWord }"
        type="button"
        title="全字匹配"
        aria-label="全字匹配"
        :aria-pressed="wholeWord"
        @click="emit('toggle-word')"
      >[ab]</button>

      <button
        class="mt-find__btn"
        type="button"
        title="关闭（Esc）"
        aria-label="关闭查找"
        @click="emit('close')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>

    <div v-if="replaceMode" class="mt-find__row">
      <input
        class="mt-find__input"
        type="text"
        :value="replacement"
        placeholder="替换为"
        spellcheck="false"
        aria-label="替换为"
        @input="onInput($event, 'replacement')"
        @keydown.enter.exact.prevent="emit('replace')"
      />
      <button
        class="mt-find__btn mt-find__btn--wide"
        type="button"
        title="替换当前匹配"
        :disabled="!matchCount"
        @click="emit('replace')"
      >替换</button>
      <button
        class="mt-find__btn mt-find__btn--wide"
        type="button"
        title="替换全部匹配（可一次撤销）"
        :disabled="!matchCount"
        @click="emit('replace-all')"
      >全部替换</button>
    </div>
  </div>
</template>

<style scoped>
/* 浮层：绝对定位于应用外壳（.notemark-app 为 fixed），紧贴工具栏下沿 */
.mt-find {
  position: absolute;
  top: 46px;
  right: 12px;
  z-index: 500;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background: var(--mt-bg, #ffffff);
  border: 1px solid var(--mt-border, #e0e0e0);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16);
  font-size: 13px;
  color: var(--mt-fg, #333);
  user-select: none;
}

.mt-find__row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.mt-find__input {
  width: 200px;
  padding: 4px 8px;
  font-family: inherit;
  font-size: 13px;
  color: var(--mt-fg, #333);
  background: var(--mt-bg, #ffffff);
  border: 1px solid var(--mt-border, #e0e0e0);
  border-radius: 4px;
  outline: none;
}

.mt-find__input:focus {
  border-color: var(--mt-accent, #2563eb);
}

.mt-find__input::placeholder {
  color: var(--mt-muted, #888);
}

/* 计数：等宽数字，避免切换匹配时文字宽度跳动 */
.mt-find__count {
  min-width: 54px;
  text-align: center;
  font-size: 12px;
  color: var(--mt-muted, #888);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.mt-find__count--empty {
  color: var(--mt-danger, #d33);
}

.mt-find__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  padding: 0 4px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  font-family: inherit;
  font-size: 12px;
  color: var(--mt-fg, #333);
  cursor: pointer;
  white-space: nowrap;
}

.mt-find__btn:hover:not(:disabled) {
  background: var(--mt-hover, #f0f0f0);
}

.mt-find__btn:disabled {
  color: var(--mt-muted, #aaa);
  cursor: not-allowed;
  opacity: 0.55;
}

/* 文字型开关（Aa / [ab]）：激活时浅底 + 主题色，与图标按钮区分开 */
.mt-find__btn--text {
  font-weight: 600;
}

.mt-find__btn--on {
  background: var(--mt-active, #e6e6e6);
  border-color: var(--mt-border, #e0e0e0);
  color: var(--mt-accent, #2563eb);
}

.mt-find__btn--wide {
  padding: 0 8px;
}

/* 窄窗口压缩查找框宽度，保证整条不溢出 */
@media (max-width: 680px) {
  .mt-find__input {
    width: 140px;
  }
  .mt-find__count {
    min-width: 44px;
  }
}
</style>
