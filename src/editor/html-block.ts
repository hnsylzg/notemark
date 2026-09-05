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
import type { MilkdownPlugin } from "@milkdown/ctx";
import type { RemarkPluginRaw } from "@milkdown/transformer";
import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import { sanitizeHtmlBlock } from "./html-view";
import { exitToNextLine } from "./block-exit";

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
    // 块级 html（独立成行的 <center>/<div>/<img>/<hr ...>/<table> 等）在 remark 阶段
    // 已被 htmlBlockRemark 改写为 type "htmlBlock"；行内 html（<u>/<sub>/<span> 等）
    // 仍保持 type "html"，由内置 inline htmlSchema 处理。两者类型不同，互不抢匹配。
    // 注：Milkdown parser 用 Object.values(schema.nodes).find(match) 取第一个匹配，
    // 并不读 priority；此前 priority:100 无效，根因是块级/行内 html 的 mdast type
    // 都是 "html" 无法区分。改为 mdast 阶段改写类型即彻底解决。
    match: (node) => node.type === "htmlBlock",
    runner: (state, node, type) => {
      const v = (node.value as string ?? "");
      state.addNode(type, { value: v });
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
      const safe = sanitizeHtmlBlock(value);
      if (!value.trim()) {
        preview.className = "mt-html-block-preview mt-html-block-empty";
        preview.textContent = "空 HTML（点击输入）";
        return;
      }
      preview.className = "mt-html-block-preview";
      preview.innerHTML = safe;
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
        // 与表格 / 代码块一致：保存后光标跳到块后的下一行，可直接接着写
        const curPos = getPos();
        if (typeof curPos === "number") {
          exitToNextLine(view, curPos, node.nodeSize);
        }
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

/*
 * htmlBlockRemark — 在 mdast 阶段把「块级 HTML」与「行内 HTML」区分开。
 *
 * 背景：remark 把独立成行的 <center>/<img>/<hr ...>/<table> 与段落内的 <u>/<sub>
 * 都解析成 type:"html" 的 mdast 节点。Milkdown 的 parser 用
 * Object.values(schema.nodes).find(match) 取【第一个】match 的节点，并不读
 * priority，因此块级 / 行内无法靠 priority 分流——内置 inline html 节点总会抢先
 * 匹配块级 html，而 inline 节点无法在 block 位置创建 → 块级 html 被整段丢弃。
 *
 * 解法：不依赖父节点类型（Milkdown 的 mdast 树结构与标准 remark 可能不同，
 * 父节点判定不可靠），而是直接按 html 节点【自身的起始标签】判断：命中块级标签
 * 集合（center/div/table/...）的改为 type "htmlBlock"，由 htmlBlock 的
 * parseMarkdown 接手；其余（<u>/<sub>/<span>...）保留 type "html"，由内置 inline
 * html 接手。两者类型不同，互不抢匹配。
 */
// 块级 HTML 标签：命中这些起始标签的 html 节点判定为块级（改写为 htmlBlock）。
// 直接按标签判断，避免依赖父节点类型带来的误判。
const BLOCK_HTML_START =
  /^\s*<\s*(center|div|p|section|article|header|footer|nav|aside|main|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|blockquote|pre|hr|figure|figcaption|details|summary|dl|dt|dd|address|iframe|img|h[1-6]|canvas)\b/i;

const htmlBlockRemarkTransform: RemarkPluginRaw<never[]> = () => (tree) => {
  const root = tree as unknown as { [k: string]: any };
  // 关键修复：remark 把 <center> 这类"块级 html"解析进 paragraph 的 children
  // （当作行内 html = type:"html"）。只把 type 改成 "htmlBlock" 会破坏树结构——
  // htmlBlock 成了 paragraph 的"块级子节点"，而 paragraph 的 content 不允许它，
  // Milkdown parser 创建 paragraph 时即报 "Cannot create node for paragraph"
  // （Content: ["htmlBlock"]），导致该段整段丢失 → 视觉上"空行"。
  // 正确做法：把块级 html 从 paragraph 中"提升"为顶层兄弟块，其余行内内容各自
  // 重新组成 paragraph；嵌套（blockquote / listItem）自底向上递归处理。
  const liftBlockHtmlOutOfParagraphs = (children: any[]): any[] => {
    const out: any[] = [];
    for (const child of children) {
      // 先递归处理子节点（自底向上，覆盖 blockquote / listItem 等嵌套容器）
      if (child.children && Array.isArray(child.children)) {
        child.children = liftBlockHtmlOutOfParagraphs(child.children);
      }
      // 仅当 paragraph 内混有块级 html 时才需拆分
      if (child.type === "paragraph" && Array.isArray(child.children)) {
        const hasBlock = child.children.some(
          (c: any) => c.type === "html" && typeof c.value === "string" && BLOCK_HTML_START.test(c.value)
        );
        if (hasBlock) {
          let inline: any[] = [];
          for (const c of child.children) {
            if (c.type === "html" && typeof c.value === "string" && BLOCK_HTML_START.test(c.value)) {
              if (inline.length > 0) {
                out.push({ type: "paragraph", children: inline });
                inline = [];
              }
              out.push({ ...c, type: "htmlBlock" });
            } else {
              inline.push(c);
            }
          }
          if (inline.length > 0) out.push({ type: "paragraph", children: inline });
          continue;
        }
      }
      out.push(child);
    }
    return out;
  };

  if (Array.isArray(root)) {
    root.length = 0;
    root.push(...liftBlockHtmlOutOfParagraphs(root));
  } else if (root.children && Array.isArray(root.children)) {
    root.children = liftBlockHtmlOutOfParagraphs(root.children);
  }

};

export const htmlBlockRemark = $remark("notemark-html-block", () => htmlBlockRemarkTransform);

export const htmlBlockPlugins: MilkdownPlugin[] = [
  ...htmlBlockSchema,
  htmlBlockView,
  ...htmlBlockRemark,
];
