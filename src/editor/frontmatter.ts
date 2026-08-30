/*
 * frontmatter.ts — YAML Front Matter 支持（可编辑块）
 *
 * 背景：Milkdown 默认完全不支持 front matter：
 *   - remark 层未注册 remark-frontmatter，文档开头的 `---\n...\n---` 被当作普通段落；
 *   - 即便注册，mdast 会产出 `yaml` 节点，而 milkdown 的 ParserState 对未知
 *     mdast 节点直接抛 parserMatchError（无兜底），导致整个文档解析崩溃。
 *
 * 本文件分三步补齐：
 *   - $remark：注册 remark-frontmatter。
 *     ★ 必须显式传 options `{ type: 'yaml', marker: '-' }`：
 *       remark-frontmatter@5 内部是 `options || 'yaml'`，而 milkdown 的 $remark
 *       默认 options 为 `{}`（truthy），会被原样传给 micromark-extension-frontmatter，
 *       抛出 `Missing type in matter {}`。
 *   - $nodeSchema('yaml')：注册 yaml 原子块节点（须声明 group: 'block'，否则
 *     prosemirror schema 校验失败），内容存于 attrs.value，提供
 *     parseMarkdown / toMarkdown 双向转换。
 *   - $view：NodeView 只读渲染，避免 ProseMirror 光标进入该原子节点。
 */
import type { NodeViewConstructor } from "@milkdown/kit/prose/view";
import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import type { RemarkPluginRaw } from "@milkdown/transformer";
import remarkFrontmatter from "remark-frontmatter";

/** remark-frontmatter 配置：yaml 块、`---` 分隔 */
const FRONTMATTER_OPTIONS = { type: "yaml", marker: "-" };

export const frontmatterRemark = $remark(
  "notemark-frontmatter",
  () => remarkFrontmatter as RemarkPluginRaw<typeof FRONTMATTER_OPTIONS>,
  FRONTMATTER_OPTIONS
);

export const frontmatterSchema = $nodeSchema("yaml", () => ({
  group: "block",
  atom: true,
  selectable: false,
  attrs: {
    value: { default: "" },
  },
  parseDOM: [
    {
      tag: "div.mt-frontmatter",
      getAttrs: (dom) => ({ value: dom.textContent ?? "" }),
    },
  ],
  toDOM: (node) => [
    "div",
    { class: "mt-frontmatter", "data-type": "yaml" },
    ["pre", { class: "mt-frontmatter-body" }, node.attrs.value as string],
  ],
  parseMarkdown: {
    match: (node) => node.type === "yaml",
    runner: (state, node, type) => {
      state.openNode(type, { value: node.value as string }).closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "yaml",
    runner: (state, node) => {
      state.addNode("yaml", undefined, node.attrs.value as string);
    },
  },
}));

export const frontmatterView = $view(frontmatterSchema.node, () => {
  const nodeView: NodeViewConstructor = (node, view, getPos) => {
    const dom = document.createElement("div");
    dom.className = "mt-frontmatter";
    dom.dataset.type = "yaml";

    const body = document.createElement("textarea");
    body.className = "mt-frontmatter-body";
    body.value = node.attrs.value as string;
    body.rows = 4;
    body.spellcheck = false;
    body.placeholder = "# 在此填写 YAML 元数据\ntitle: 我的笔记\ndate: 2026-08-30";

    dom.append(body);

    // 阻止 ProseMirror 接收编辑区内的鼠标交互：该节点是 atom，PM 不管理其内部，
    // 避免光标 / 选区被 PM 抢走
    const stop = (e: Event) => e.stopPropagation();
    body.addEventListener("mousedown", stop);
    body.addEventListener("touchstart", stop, { passive: true });
    body.addEventListener("dragstart", stop);

    // 键盘事件：无修饰键（退格 / 回车 / Tab / 普通字符）不要冒泡到 PM，
    // 否则会被编辑器的 keymap 拦截、导致 textarea 内退格等按键失效；
    // 带修饰键（Ctrl / Cmd / Alt，如 Ctrl+S 保存、Ctrl+C/V）则放行给全局快捷键
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 内容已清空时再按退格 / Delete：删掉整个元数据块。
      // 按键在这里就不再冒泡，编辑器层的 atomBlockDeletePlugin 收不到，
      // 只能就地兜底，否则清空后怎么按都还留着一个空块。
      if (
        (e.key === "Backspace" || e.key === "Delete") &&
        body.value === "" &&
        body.selectionStart === body.selectionEnd
      ) {
        const pos = getPos();
        if (typeof pos === "number") {
          e.preventDefault();
          view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
          view.focus();
        }
        return;
      }
      e.stopPropagation();
    };
    body.addEventListener("keydown", onKeyDown);

    // 输入时把内容同步到节点 attrs（保留 value 数据结构，便于序列化）
    const sync = () => {
      const pos = getPos();
      if (pos == null) return;
      view.dispatch(view.state.tr.setNodeAttribute(pos, "value", body.value));
    };
    body.addEventListener("input", sync);

    return {
      dom,
      // 文本变化由 input 事件同步，PM 不应把它当 mutation 重绘
      ignoreMutation: () => true,
      update: (updatedNode) => {
        if (updatedNode.type !== node.type) return false;
        node = updatedNode;
        // 仅当外部（加载文件 / 撤销重做）改变了 value 才回写，
        // 否则会覆盖用户正在输入的内容、导致光标跳动
        if (body.value !== (node.attrs.value as string)) {
          body.value = node.attrs.value as string;
        }
        return true;
      },
      destroy: () => {
        body.removeEventListener("input", sync);
        body.removeEventListener("keydown", onKeyDown);
      },
    };
  };
  return nodeView;
});

export const frontmatterPlugins = [
  ...frontmatterRemark,
  ...frontmatterSchema,
  frontmatterView,
];
