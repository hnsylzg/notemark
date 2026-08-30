/*
 * html-block.ts — 块级 HTML 节点（可编辑 + 实时渲染）
 *
 * 背景：milkdown commonmark 内置的 `html` 节点是【行内】节点（用于段落内的
 *   <u>/<mark> 等），没有块级 HTML 容器。此前 /html 斜杠命令借用该 inline
 *   节点走 insertAtom 当作 block 插入，因 schema 校验失败而“无法插入”。
 *
 * 本文件补一个真正的块级 HTML 节点：
 *   - schema：block + atom，源码存于 attrs.value；
 *   - NodeView：与公式块一致——默认直接显示渲染对象（无外框），点对象进入「HTML
 *     代码编辑框」（带框 textarea），输完（失焦 / Esc / Ctrl+Enter）编辑框消失、
 *     对象重新显示（复用 html-view 的 sanitizeHtml，仅渲染白名单内的安全标签 / iframe）；
 *   - markdown 往返：序列化输出裸 HTML 源码（mdast 块级 html 节点），
 *     解析时由本（block）节点的 parseMarkdown 接管，与行内 html 互不冲突。
 */
import type { NodeViewConstructor } from "@milkdown/kit/prose/view";
import { $nodeSchema, $view } from "@milkdown/kit/utils";
import { sanitizeHtmlBlock } from "./html-view";

export const htmlBlockSchema = $nodeSchema("htmlBlock", () => ({
  group: "block",
  atom: true,
  selectable: false,
  attrs: {
    value: { default: "" },
  },
  parseDOM: [
    {
      tag: 'div[data-type="htmlblock"]',
      getAttrs: (dom) => ({
        value: (dom as HTMLElement).dataset.value ?? "",
      }),
    },
  ],
  toDOM: (node) => [
    "div",
    { "data-type": "htmlblock", "data-value": node.attrs.value as string },
    "",
  ],
  parseMarkdown: {
    // 块级 html（独立成行的 html 片段）交给本节点；行内 <u> 仍由 inline htmlSchema 处理
    match: (node) => node.type === "html",
    runner: (state, node, type) => {
      state.openNode(type, { value: node.value as string }).closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "htmlBlock",
    runner: (state, node) => {
      state.addNode("html", undefined, node.attrs.value as string);
    },
  },
}));

export const htmlBlockView = $view(htmlBlockSchema.node, () => {
  const nodeView: NodeViewConstructor = (node, view, getPos) => {
    const dom = document.createElement("div");
    dom.className = "mt-html-block";
    dom.dataset.type = "htmlblock";

    // 渲染预览：默认态只显示它（与公式块一致，「只看结果」）
    const preview = document.createElement("div");
    preview.className = "mt-html-block-preview";

    // 源码编辑框：编辑态才显示（与公式块一致，编辑态只显示它）
    const ta = document.createElement("textarea");
    ta.className = "mt-html-block-body";
    ta.spellcheck = false;
    ta.placeholder = "在此输入 HTML 代码，例如 <div>...</div> 或 <iframe ...>";
    ta.style.display = "none";

    dom.append(ta, preview);

    let editing = false;

    // 渲染对象（块级 HTML 用更宽松的白名单）；空态给与公式块一致的占位提示
    const render = (value: string) => {
      if (!value.trim()) {
        preview.className = "mt-html-block-preview mt-html-block-empty";
        preview.textContent = "空 HTML（点击输入）";
        return;
      }
      preview.className = "mt-html-block-preview";
      preview.innerHTML = sanitizeHtmlBlock(value);
    };

    // 进入 / 退出编辑态（与公式块一致：编辑态只在 textarea 内本地操作，不每键
    // dispatch，避免 PM 事务抢占焦点 / 重置光标；退出时才提交，Esc 取消）。
    const setEditing = (on: boolean) => {
      editing = on;
      ta.style.display = on ? "" : "none";
      preview.style.display = on ? "none" : "";
      if (on) {
        ta.value = node.attrs.value as string;
        ta.focus();
        const len = ta.value.length;
        ta.setSelectionRange(len, len);
      } else {
        render(ta.value);
      }
    };

    // 退出编辑并提交 / 取消：commit=true 用 textarea 当前内容写回文档，
    // commit=false（Esc）恢复原值。与公式块 finish() 行为一致。
    const finish = (commit: boolean) => {
      if (!editing) return;
      const next = commit ? ta.value : (node.attrs.value as string);
      editing = false;
      ta.style.display = "none";
      preview.style.display = "";
      if (next !== node.attrs.value) {
        const pos = getPos();
        if (typeof pos === "number") {
          // setNodeMarkup 整体替换 attrs，需合并原 attrs（保留其他字段）
          view.dispatch(
            view.state.tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              value: next,
            }),
          );
          return; // update() 会触发重渲染
        }
      }
      render(next);
    };

    // 编辑区交互不要冒泡到 ProseMirror（atom 节点，PM 不管理其内部）
    const stop = (e: Event) => e.stopPropagation();
    ta.addEventListener("mousedown", stop);
    ta.addEventListener("touchstart", stop, { passive: true });
    ta.addEventListener("dragstart", stop);
    // 粘贴 / 复制 / 剪切 / 拖放 / 右键菜单都不要冒泡到 PM，交给 textarea 自身处理
    ta.addEventListener("paste", stop);
    ta.addEventListener("copy", stop);
    ta.addEventListener("cut", stop);
    ta.addEventListener("drop", stop);
    ta.addEventListener("contextmenu", stop);
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finish(true);
      } else if (
        (e.key === "Backspace" || e.key === "Delete") &&
        ta.value === "" &&
        ta.selectionStart === ta.selectionEnd
      ) {
        // 内容已清空时再按退格 / Delete：删掉整个 HTML 块。
        // 同 frontmatter：按键不冒泡，编辑器层兜不到，只能就地处理。
        const pos = getPos();
        if (typeof pos === "number") {
          e.preventDefault();
          editing = false; // 先退出编辑态，删除后 blur 触发的 finish 才不会再提交一次
          view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
          view.focus();
        }
      }
    });
    // 失焦即提交并退出编辑态（与公式块一致「输完就关闭」）
    ta.addEventListener("blur", () => finish(true));

    // 点击整块进入编辑；编辑态下忽略，且不抢 PM 选区
    dom.addEventListener("mousedown", stop);
    dom.addEventListener("click", () => {
      if (!editing) setEditing(true);
    });

    // 初始态：默认显示渲染对象（空内容时由 CSS 占位提示）；点整块再进入编辑
    render(node.attrs.value as string);

    return {
      dom,
      // 内容变化由 finish 提交，PM 不应把它当 mutation 重绘
      ignoreMutation: () => true,
      update: (updatedNode) => {
        if (updatedNode.type !== node.type) return false;
        node = updatedNode;
        // 仅非编辑态回写（外部改动：加载文件 / 撤销重做）；
        // 编辑态不碰 textarea，避免重置光标 / 选区
        if (!editing) render(node.attrs.value as string);
        return true;
      },
      destroy: () => {},
    };
  };
  return nodeView;
});

export const htmlBlockPlugins = [
  ...htmlBlockSchema,
  htmlBlockView,
];
