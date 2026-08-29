/*
 * index.ts — Milkdown 编辑器入口（配置层，不在此调用 create()）
 *
 * 职责：
 * - 引入 prosemirror 基础样式（@milkdown/kit 自带）
 * - 提供 createEditor() 工厂：配置 root 节点、默认值（dark/light 由外层控制）
 * - 注册 plugins.ts 中的插件集合
 * - 由 App.vue 在 onMounted 中调用并自行 .create()
 */
import { Editor } from "@milkdown/kit/core";
// defaultValueCtx 由 @milkdown/core 内部插件注册（随 @milkdown/kit/core 导出），
// 用于设置编辑器初始内容，不能用字符串 "defaultValue" 直接 set。
import { defaultValueCtx } from "@milkdown/kit/core";
// rootAttrsCtx：注入到 Milkdown 自动创建的 .milkdown 根节点的 HTML 属性，
// 用于承载 data-theme，使 tokens.css 的 [data-theme] 变量切换生效。
import { rootAttrsCtx } from "@milkdown/kit/core";
// codeBlockConfig：代码块组件（@milkdown/components/code-block）的配置 slice。
// 默认 languages 为空数组，导致语言选择器搜不到任何语言、也无法确定，
// 因此必须注入 @codemirror/language-data 提供的常见语言列表。
import { codeBlockConfig } from "@milkdown/kit/component/code-block";
// listItemBlockConfig：列表项 NodeView（list-item-block）的配置 slice。
// renderLabel 决定列表项“图标区”渲染什么：普通无序列表用圆点 SVG、
// 有序列表用数字文本、任务列表用勾选/未勾选 SVG 方块（list-item.ts）。
import { listItemBlockConfig } from "@milkdown/kit/component/list-item-block";
import { renderListItemLabel } from "./list-item";
import { languages } from "@codemirror/language-data";
// CM6 语法高亮：
// 关键①：@milkdown/components/code-block 默认不启用 syntaxHighlighting，
// 代码块一直以纯色（--mt-code-fg）渲染，tokens.css 的 --mt-token-* 变量
// 从未被消费——这就是“导入主题后代码颜色不变”的根因，必须先启用。
// 关键②：不能直接用 defaultHighlightStyle——它不生成 .tok-* 类名，而是
// style-mod 混淆类名（.ͼb 等），CSS 侧无法按类名覆盖。因此这里用
// HighlightStyle.define + CSS 变量（var(--mt-token-*)）自定义，使 CM 生成
// 的高亮规则直接消费主题变量，用户改主题即改代码配色。
// 注意：tags 由 @lezer/highlight 提供，@codemirror/language 不重新导出。
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const mtHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--mt-token-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--mt-token-string)" },
  { tag: [t.number, t.bool, t.atom], color: "var(--mt-token-number)" },
  // GitHub 官方观感：注释不上斜体
  { tag: [t.comment, t.meta], color: "var(--mt-token-comment)" },
  {
    tag: [t.function(t.variableName), t.definition(t.variableName)],
    color: "var(--mt-token-function)",
  },
  // GitHub 官方观感：运算符不上色（继承 --mt-code-fg）
  { tag: [t.variableName], color: "var(--mt-token-variable)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--mt-token-type)" },
  // GitHub 官方观感：属性名蓝色、HTML 标签绿色，两者分开
  { tag: [t.propertyName], color: "var(--mt-token-property)" },
  { tag: [t.tagName], color: "var(--mt-token-tag)" },
]);

// remark-stringify 的默认转义表（mdast-util-to-markdown 的 unsafe 规则）会把文本
// 中的 [ 和 ] 转义成 \[、\]（因它们可能是链接/图片/引用语法前缀），导致 [toc]、
// > [!NOTE]（Obsidian Callout）等被序列化成 \[toc]、\[!NOTE]，
// Typora/Obsidian 等外部编辑器无法再识别。
// 注意：mdast-util-to-markdown 对 options.unsafe 是"追加"而非替换，无法通过选项
// 清掉默认表，因此这里改为在 text handler 内调用 state.safe 前临时过滤 [ ] 规则。
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore mdast-util-to-markdown 导出的 Handle 类型
const customTextHandler: Handle = (node, _, state, info) => {
  const value = (node as { value?: string }).value ?? "";
  // 纯空白文本（不含 *、_、\）原样返回，与 milkdown 默认 text handler 一致
  if (/^[^*_\\]*\s+$/.test(value)) return value;
  const original = state.unsafe;
  state.unsafe = original.filter(
    (u) => !(u.character === "[" || u.character === "]")
  );
  try {
    return state.safe(value, { ...info, encode: [] });
  } finally {
    state.unsafe = original;
  }
};
// listenerCtx：注册内容变化监听，用于追踪“未保存修改”状态。
// 该 SliceType 由 listener 插件提供，必须在 .use(listener) 注册后生效。
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
// Milkdown v7 的 Markdown 读写通过两个内部上下文实现：
// - serializerCtx: 把 ProseMirror Node 序列化为 Markdown 字符串
// - parserCtx:     把 Markdown 字符串解析为 ProseMirror Node
// - editorViewCtx: 拿 ProseMirror 视图，用于派发文档替换事务
// 注意：editorViewCtx 在 @milkdown/kit/core 的运行时 JS 中确实导出（见 core 源码
// ctx.set(editorViewCtx, view)），但本安装版本的 .d.ts 遗漏了该声明，
// 因此用 @ts-ignore 抑制类型检查，运行时完全可用。
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore editorViewCtx 在运行时由 @milkdown/kit/core 导出（d.ts 遗漏声明）
import { serializerCtx, parserCtx, editorViewCtx } from "@milkdown/kit/core";
// remarkStringifyOptionsCtx：Milkdown 序列化 Markdown 时传给 remark-stringify 的
// 选项 slice，可在 config 阶段改写（init 在 ConfigReady 后才读取它创建 remark 实例）。
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
// 仅用于类型标注（type-only，不参与打包）
import type { Handle } from "mdast-util-to-markdown";
import { TextSelection } from "@milkdown/kit/prose/state";
import "@milkdown/kit/prose/view/style/prosemirror.css";

import { getEditorPlugins } from "./plugins";

/** 当前编辑器文档导出为 Markdown 文本 */
export function getMarkdown(editor: Editor): string {
  return editor.action((ctx) => {
    const serializer = ctx.get(serializerCtx);
    const view = ctx.get(editorViewCtx);
    return serializer(view.state.doc);
  });
}

/** 用新的 Markdown 文本整体替换编辑器内容 */
export function setMarkdown(editor: Editor, markdown: string): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const parser = ctx.get(parserCtx);
    const doc = parser(markdown);
    // 用新 doc 替换整棵文档树，保持 schema 合法
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content)
    );
  });
}

/**
 * 获取当前光标在文档中的相对位置（0~1 比例）。
 * 用于 WYSIWYG ⇄ 源码模式切换时近似还原光标位置：
 * Markdown 与解析后的文档存在语法损耗，逐字符精确映射不可行，
 * 按光标在文档总长度中的比例映射到另一侧，位置基本不漂移。
 * 文档为空或无法获取时返回 null。
 */
export function getCaretRatio(editor: Editor): number | null {
  return editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const docSize = view.state.doc.content.size;
    if (docSize <= 0) return null;
    const head = view.state.selection.head;
    return Math.min(1, Math.max(0, head / docSize));
  });
}

/** 把光标设置到文档总长度对应比例的位置，并聚焦编辑器 */
export function setCaretByRatio(editor: Editor, ratio: number): void {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const docSize = view.state.doc.content.size;
    if (docSize <= 0) return;
    const pos = Math.round(Math.min(1, Math.max(0, ratio)) * docSize);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, Math.min(pos, docSize))
      )
    );
    view.focus();
  });
}

/**
 * 创建一个已配置插件、但未 create 的 Milkdown Editor 实例。
 * @param root 挂载的 DOM 容器（必须是带 .milkdown 类的元素）
 * @param defaultValue 初始 Markdown / HTML 内容（默认空）
 * @param onChange 内容变化回调（markdownUpdated 事件，参数为当前 Markdown 文本）
 */
export function createEditor(
  root: HTMLElement,
  defaultValue: string = "",
  onChange?: (markdown: string) => void
): Editor {
  const editor = Editor.make()
    .config((ctx) => {
      // 挂载根节点
      ctx.set("root", root);
      // 默认值：空文档（使用 defaultValueCtx，而非字符串 key）
      ctx.set(defaultValueCtx, defaultValue);
      // 给 Milkdown 自动生成的 .milkdown 根节点注入 data-theme，
      // 让 tokens.css 的 [data-theme] 变量切换生效。
      ctx.set(rootAttrsCtx, { "data-theme": "light" });
      // 覆盖 text handler：序列化文本时不再转义 [ 和 ]，
      // 使 [toc]、> [!NOTE]（Obsidian Callout）等语法能原样导出，
      // 外部编辑器（Typora/Obsidian 等）可以正常识别。
      // highlight handler：把 highlight mark（==高亮==）序列化回 ==text==。
      const extraHandlers: Record<string, Handle> = {
        text: customTextHandler,
        highlight: (node, _parent, state, info) =>
          `==${state.containerPhrasing(node, info)}==`,
      };
      ctx.update(remarkStringifyOptionsCtx, (options) => ({
        ...options,
        handlers: {
          ...options.handlers,
          ...extraHandlers,
        },
      }));
      // 代码块配置：注入语言列表 + 启用语法高亮。
      // - languages：让语言选择器可搜索/选择 160+ 种语言。
      // - extensions: [syntaxHighlighting(mtHighlightStyle)]：启用 CM6 语法高亮，
      //   高亮颜色直接引用 --mt-token-* / --mt-color-primary 变量，
      //   用户主题改变量即改代码配色。
      // 注意：codeBlockConfig 是 $Ctx（createSlice 的封装），
      // 必须通过 .key（SliceType）传给 ctx.get/set，直接传 $Ctx 会抛 contextNotFound。
      ctx.set(codeBlockConfig.key, {
        ...ctx.get(codeBlockConfig.key),
        extensions: [syntaxHighlighting(mtHighlightStyle)],
        languages,
        // 扁平化现代图标（Lucide 线性风格，stroke 跟随文字颜色）
        copyIcon:
          `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
        searchIcon:
          `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
        clearSearchIcon:
          `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
        expandIcon:
          `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
      });
      // 列表项 NodeView 配置：任务列表渲染为 SVG 复选框（点击切换由组件内置）
      ctx.set(listItemBlockConfig.key, {
        ...ctx.get(listItemBlockConfig.key),
        renderLabel: renderListItemLabel,
      });
      // 内容变化监听：供外层做“未保存修改”追踪
      if (onChange) {
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          onChange(markdown);
        });
      }
    })
    // 注册所有插件（commonmark/gfm/history/math/diagram/code-block/listener）
    .use(getEditorPlugins())
    .use(listener);

  return editor;
}
