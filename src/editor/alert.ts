/*
 * alert.ts — GitHub 风格 Alert 引用块（> [!NOTE] 等）支持
 *
 * 语法：引用块首行写 [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
 * （大小写不敏感，GitHub Alert 同款），渲染为带类型颜色/标题的提示盒子。
 *
 * 实现：
 * - $remark：markdown 解析阶段把「首段为 [!TYPE] 的 blockquote」改写为自定义
 *   mdast 节点 alert（携带 alertType 和可选 custom title）；
 * - $nodeSchema：alert 节点渲染为 <blockquote data-alert="note" ...>，正文仍可编辑；
 * - $view：提示头点击后显示 `[!TYPE] 自定义标题` 源码，在文档事务中提交；
 * - $inputRule：输入 `> [!TYPE]` 时即时把所在引用块转换为 alert 节点；
 * - 序列化：alert 输出回 `> [!TYPE] 标题\n> 内容`，导入导出往返无损。
 */
import type { MilkdownPlugin } from "@milkdown/ctx";
import type { MarkdownNode, RemarkPluginRaw } from "@milkdown/transformer";
import { $inputRule, $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import { Fragment } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { NodeViewConstructor } from "@milkdown/kit/prose/view";

export const ALERT_TYPES = ["note", "tip", "important", "warning", "caution"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

const ALERT_TITLE_REGEX =
  /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+(.*?))?\s*$/i;

const ALERT_LABELS: Record<AlertType, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

function normalizeAlertType(value: unknown): AlertType | null {
  const normalized = String(value ?? "").toLowerCase();
  return ALERT_TYPES.includes(normalized as AlertType)
    ? (normalized as AlertType)
    : null;
}

export function parseAlertSource(
  source: string
): { alertType: AlertType; title: string } | null {
  const match = ALERT_TITLE_REGEX.exec(source);
  const alertType = normalizeAlertType(match?.[1]);
  if (!alertType) return null;
  return {
    alertType,
    title: (match?.[2] ?? "").trim(),
  };
}

/**
 * 若 blockquote 首段以独占一行的 [!TYPE] 开头，改写为 alert 节点；否则返回 null。
 * `[!TYPE]` 后可选自定义标题，例如 `[!NOTE] 发布前检查`。
 *
 * 注意：`> [!NOTE]` 与 `> 内容` 会被 remark 解析进同一段落，软换行是 break 节点：
 *   paragraph: [text "[!NOTE]", break, text "内容"]
 */
function blockquoteToAlert(node: MarkdownNode): MarkdownNode | null {
  const first = node.children?.[0];
  if (first?.type !== "paragraph") return null;

  const kids = first.children ?? [];
  const titleNode = kids[0];
  if (titleNode?.type !== "text") return null;
  const match = ALERT_TITLE_REGEX.exec(String(titleNode.value));
  if (!match) return null;

  // 标题行必须独占一行：其后只能跟换行（break）或段落结束
  const after = kids.slice(1);
  if (after.length > 0 && after[0].type !== "break") return null;

  // 标题行之后的剩余 inline 内容重建为一个段落；
  // 跳过空段落（序列化多段落引用时会产生空的 `>` 行）
  const rest = after.slice(1);
  const newChildren: MarkdownNode[] = [];
  if (rest.length > 0) {
    newChildren.push({ type: "paragraph", children: rest });
  }
  for (const child of node.children?.slice(1) ?? []) {
    if (child.type === "paragraph" && !(child.children ?? []).length) continue;
    newChildren.push(child);
  }

  return {
    type: "alert",
    alertType: match[1].toLowerCase(),
    title: (match[2] ?? "").trim(),
    children: newChildren,
  };
}

const alertRemarkTransform: RemarkPluginRaw<never[]> = () => (tree) => {
  const visit = (node: MarkdownNode): void => {
    if (!Array.isArray(node.children)) return;
    for (let i = 0; i < node.children.length; i += 1) {
      const child = node.children[i];
      if (child.type === "blockquote") {
        const alert = blockquoteToAlert(child);
        if (alert) {
          node.children[i] = alert;
          continue;
        }
      }
      visit(child);
    }
  };
  visit(tree as unknown as MarkdownNode);
};

export const alertRemark = $remark("notemark-alert", () => alertRemarkTransform);

export const alertSchema = $nodeSchema("alert", () => ({
  group: "block",
  content: "block+",
  defining: true,
  attrs: {
    alertType: { default: "note" },
    title: { default: "" },
  },
  parseDOM: [
    {
      tag: "blockquote[data-alert]",
      getAttrs: (dom) => ({
        alertType: (dom as HTMLElement).getAttribute("data-alert") ?? "note",
        title: (dom as HTMLElement).getAttribute("data-alert-title") ?? "",
      }),
    },
  ],
  toDOM: (node) => [
    "blockquote",
    {
      class: `md-alert md-alert-${node.attrs.alertType}`,
      "data-alert": node.attrs.alertType,
      "data-alert-title": String(node.attrs.title ?? ""),
    },
    0,
  ],
  parseMarkdown: {
    match: (node) => node.type === "alert",
    runner: (state, node, type) => {
      const alertType =
        typeof node.alertType === "string" ? node.alertType.toLowerCase() : "note";
      const title = typeof node.title === "string" ? node.title : "";
      state
        .openNode(type, { alertType, title })
        .next(node.children)
        .closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "alert",
    runner: (state, node) => {
      const customTitle = String(node.attrs.title ?? "").trim();
      const title = `[!${String(node.attrs.alertType).toUpperCase()}]${
        customTitle ? ` ${customTitle}` : ""
      }`;
      state.openNode("blockquote");
      state.addNode("paragraph", [{ type: "text", value: title }]);
      state.next(node.content);
      state.closeNode();
    },
  },
}));

/**
 * GitHub Alert 的提示头可点击进入源码编辑态。
 *
 * `[!TYPE]` 不放进正文，而是由 alertType 属性持久化；因此这里用 NodeView
 * 单独提供标题控件，正文仍通过 contentDOM 交给 ProseMirror 原生编辑。
 * 这比给 CSS ::after 加 contenteditable 可靠：编辑结果能进入文档事务、
 * undo/redo 和 Markdown 序列化。
 */
export const createAlertNodeView: NodeViewConstructor = (
  initialNode,
  view,
  getPos
) => {
  let node = initialNode;
  let editing = false;
  let finishEditing: ((commit: boolean, moveToContent?: boolean) => void) | null =
    null;

  const dom = document.createElement("blockquote");
  dom.className = "md-alert";

  const title = document.createElement("span");
  title.className = "md-alert-title";
  title.setAttribute("role", "button");
  title.setAttribute("aria-label", "编辑提示类型");

  const content = document.createElement("div");
  content.className = "md-alert-content";

  dom.append(title, content);

  const currentType = () => normalizeAlertType(node.attrs.alertType) ?? "note";
  const currentTitle = () => String(node.attrs.title ?? "").trim();

  const syncDom = () => {
    const type = currentType();
    dom.className = `md-alert md-alert-${type}`;
    dom.dataset.alert = type;
    dom.dataset.alertTitle = currentTitle();
    if (!editing) {
      title.textContent = currentTitle() || ALERT_LABELS[type];
    }
  };

  const focusContent = () => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    const selection = TextSelection.near(view.state.doc.resolve(pos + 2), 1);
    view.dispatch(view.state.tr.setSelection(selection));
    view.focus();
  };

  const startEdit = () => {
    if (editing) return;
    editing = true;

    const customTitle = currentTitle();
    const source = `[!${currentType().toUpperCase()}]${
      customTitle ? ` ${customTitle}` : ""
    }`;
    const input = document.createElement("input");
    input.className = "md-alert-title-input";
    input.type = "text";
    input.value = source;
    input.spellcheck = false;
    input.size = Math.max(source.length, 10);
    title.replaceChildren(input);

    const stop = (event: Event) => event.stopPropagation();
    input.addEventListener("mousedown", stop);
    input.addEventListener("paste", stop);
    input.addEventListener("copy", stop);
    input.addEventListener("cut", stop);
    input.addEventListener("drop", stop);
    input.addEventListener("contextmenu", stop);

    const finish = (commit: boolean, moveToContent = false) => {
      if (!editing) return;
      editing = false;

      const previousType = currentType();
      const previousTitle = currentTitle();
      const parsed = commit ? parseAlertSource(input.value) : null;
      const nextType = parsed?.alertType ?? previousType;
      const nextTitle = parsed ? parsed.title : previousTitle;
      title.replaceChildren();
      document.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
      finishEditing = null;

      // Empty source means "remove the alert marker". Keep the content but
      // replace the alert node with an ordinary blockquote, so Markdown writes
      // `> 正文` instead of restoring a default Note label.
      if (commit && !input.value.trim()) {
        const pos = getPos();
        const blockquote = view.state.schema.nodes.blockquote;
        if (typeof pos === "number" && blockquote) {
          const tr = view.state.tr.replaceWith(
            pos,
            pos + node.nodeSize,
            blockquote.create(null, node.content)
          );
          if (moveToContent) {
            tr.setSelection(
              TextSelection.near(tr.doc.resolve(pos + 2), 1)
            );
          }
          view.dispatch(tr);
          if (moveToContent) view.focus();
          return;
        }
      }

      if (parsed && (nextType !== previousType || nextTitle !== previousTitle)) {
        const pos = getPos();
        if (typeof pos === "number") {
          view.dispatch(
            view.state.tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              alertType: nextType,
              title: nextTitle,
            })
          );
        }
      }

      syncDom();
      if (moveToContent) focusContent();
    };
    finishEditing = finish;

    const onOutside = (event: MouseEvent) => {
      if (!input.contains(event.target as Node)) finish(true);
    };
    const onViewportChange = () => finish(true);

    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true, true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false, true);
      } else if (event.key === "Tab") {
        finish(true);
      }
    });
    document.addEventListener("mousedown", onOutside, true);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);

    const focusSource = () => {
      if (!editing || !input.isConnected) return;
      input.focus({ preventScroll: true });
      // Put the insertion caret inside the marker, before its closing bracket:
      // [!NOTE|]. This keeps the editor in a normal text-editing state rather
      // than appearing as a block of selected text.
      const caret = currentTitle()
        ? input.value.length
        : Math.max(2, input.value.length - 1);
      input.setSelectionRange(caret, caret);
    };
    focusSource();
    requestAnimationFrame(focusSource);

  };

  title.addEventListener("mousedown", (event) => {
    // Start editing during mousedown, after suppressing the title's native
    // focus transfer. Waiting until click lets WebView2 restore the editor
    // focus in between, which immediately blurs the source input.
    event.preventDefault();
    event.stopPropagation();
    startEdit();
  });
  title.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if ((event.target as Element | null)?.matches("input")) return;
    startEdit();
  });
  title.addEventListener("keydown", (event) => {
    if (editing) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      startEdit();
    }
  });

  syncDom();

  return {
    dom,
    contentDOM: content,
    update: (updatedNode) => {
      if (updatedNode.type !== node.type) return false;
      node = updatedNode;
      syncDom();
      return true;
    },
    stopEvent: (event) =>
      event.target instanceof Node && title.contains(event.target),
    ignoreMutation: (mutation) => {
      if (mutation.type === "selection") return false;
      // Class/data attributes on the NodeView root are decorative: the source
      // node itself is unchanged. If these mutations are not ignored,
      // ProseMirror redraws the entire alert and destroys the active editor.
      if (mutation.type === "attributes" && mutation.target === dom) return true;
      return mutation.target instanceof Node && title.contains(mutation.target);
    },
    destroy: () => {
      if (editing) finishEditing?.(false);
    },
  };
};

export const alertView = $view(alertSchema.node, () => createAlertNodeView);

/** 输入规则：在引用块第一段输入 [!TYPE] 后即时转换为 alert 节点 */
export const alertInputRule = $inputRule((ctx) => {
  const alertNodeType = alertSchema.type(ctx);
  return new InputRule(ALERT_TITLE_REGEX, (state, match, start) => {
    const alertType = normalizeAlertType(match[1]);
    if (!alertType) return null;
    const title = (match[2] ?? "").trim();

    // 仅在 blockquote 内生效
    const $start = state.doc.resolve(start);
    let depth = $start.depth;
    while (depth > 0 && $start.node(depth).type.name !== "blockquote") depth -= 1;
    if (depth <= 0) return null;

    const bqNode = $start.node(depth);
    if (bqNode.childCount === 0) return null;
    // 标题行必须是引用块的第一段，且是光标所在段落
    const titleParagraph = bqNode.child(0);
    if (titleParagraph.type.name !== "paragraph") return null;
    if ($start.parent !== titleParagraph) return null;

    // 移除标题段（第一个子节点）；空内容补一个空段落，保证 content: block+ 合法
    const firstSize = bqNode.content.child(0).nodeSize;
    let content = bqNode.content.cut(firstSize, bqNode.content.size);
    if (content.childCount === 0) {
      content = Fragment.from(state.schema.nodes.paragraph.create());
    }

    const alertNode = alertNodeType.create({ alertType, title }, content);
    const tr = state.tr.replaceWith($start.before(depth), $start.after(depth), alertNode);
    tr.setSelection(TextSelection.near(tr.doc.resolve($start.before(depth) + 1), 1));
    return tr;
  });
});

/** 注册给 getEditorPlugins() 的插件集合 */
export const alertPlugins: MilkdownPlugin[] = [
  ...alertSchema,
  ...alertRemark,
  alertView,
  alertInputRule,
];
