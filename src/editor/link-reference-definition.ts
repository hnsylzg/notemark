/*
 * link-reference-definition.ts — Markdown 引用式链接定义 `[id]: url`
 *
 * 该节点只负责保存引用定义本身；正文中的 `[text][id]` 仍由普通文本承载。
 * 定义与脚注定义分开，并且可以在可视化模式中直接编辑、在源码模式中保存。
 */
import type { MilkdownPlugin } from "@milkdown/ctx";
import type {
  MarkdownNode,
  RemarkPluginRaw,
} from "@milkdown/transformer";
import {
  $markSchema,
  $nodeSchema,
  $remark,
  $view,
} from "@milkdown/kit/utils";
import {
  TextSelection,
  type EditorState,
} from "@milkdown/kit/prose/state";
import type {
  EditorView,
  NodeViewConstructor,
} from "@milkdown/kit/prose/view";
import {
  deleteEmptyEditableBlock,
  exitToNextLine,
} from "./block-exit";

export const LINK_REFERENCE_DEFINITION_NAME =
  "link_reference_definition";
export const LINK_REFERENCE_MARK_NAME = "link_reference";

export interface ParsedLinkReferenceDefinition {
  identifier: string;
  label: string;
  url: string;
  title: string | null;
}

export function normalizeLinkReferenceIdentifier(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

export function parseLinkReferenceDefinitionSource(
  source: string
): ParsedLinkReferenceDefinition | null {
  const match =
    /^\s{0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|(\S+))(?:[ \t]+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\(((?:[^)\\]|\\.)*)\)))?[ \t]*$/.exec(
      source
    );
  if (!match) return null;
  const label = match[1].trim();
  const url = (match[2] ?? match[3] ?? "").trim();
  if (!label || label.startsWith("^") || !url) return null;
  const rawTitle = match[4] ?? match[5] ?? match[6] ?? "";
  return {
    identifier: normalizeLinkReferenceIdentifier(label),
    label,
    url,
    title: rawTitle ? rawTitle.replace(/\\(["'()])/g, "$1") : null,
  };
}

export function formatLinkReferenceDefinition(
  definition: ParsedLinkReferenceDefinition
): string {
  const title = definition.title
    ? ` "${definition.title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : "";
  return `[${definition.label}]: ${definition.url}${title}`;
}

export function linkReferenceDefinitionFromAttrs(
  attrs: Readonly<Record<string, unknown>>
): ParsedLinkReferenceDefinition | null {
  const label = String(attrs.label ?? attrs.identifier ?? "").trim();
  const url = String(attrs.url ?? "").trim();
  if (!label || !url) return null;
  return {
    identifier: normalizeLinkReferenceIdentifier(
      String(attrs.identifier ?? label)
    ),
    label,
    url,
    title:
      typeof attrs.title === "string" && attrs.title
        ? attrs.title
        : null,
  };
}

export const createLinkReferenceDefinitionNodeView: NodeViewConstructor = (
  initialNode,
  view,
  getPos
) => {
  let node = initialNode;
  const dom = document.createElement("div");
  dom.className = "mt-link-reference-definition";
  dom.dataset.type = LINK_REFERENCE_DEFINITION_NAME;

  const identifier = document.createElement("input");
  identifier.className = "mt-link-reference-definition__identifier";
  identifier.placeholder = "name";
  identifier.dataset.field = "identifier";
  identifier.setAttribute("aria-label", "引用 ID");
  identifier.spellcheck = false;

  const url = document.createElement("input");
  url.className = "mt-link-reference-definition__url";
  url.placeholder = "input link url here";
  url.dataset.field = "url";
  url.setAttribute("aria-label", "引用链接地址");
  url.spellcheck = false;

  const titleGroup = document.createElement("span");
  titleGroup.className = "mt-link-reference-definition__title-group";
  titleGroup.append(document.createTextNode('"'));
  const title = document.createElement("input");
  title.className = "mt-link-reference-definition__title";
  title.placeholder = "title (optional)";
  title.dataset.field = "title";
  title.setAttribute("aria-label", "引用链接标题");
  title.spellcheck = false;
  titleGroup.append(title, document.createTextNode('"'));

  const open = document.createElement("span");
  open.className = "mt-link-reference-definition__delimiter";
  open.textContent = "[";
  const closeLabel = document.createElement("span");
  closeLabel.className = "mt-link-reference-definition__delimiter";
  closeLabel.textContent = "]:";
  dom.append(open, identifier, closeLabel, url, titleGroup);

  const sync = () => {
    const identifierValue = String(node.attrs.identifier ?? "");
    const urlValue = String(node.attrs.url ?? "");
    const titleValue = String(node.attrs.title ?? "");
    if (document.activeElement !== identifier) {
      identifier.value = identifierValue;
    }
    if (document.activeElement !== url) url.value = urlValue;
    if (document.activeElement !== title) title.value = titleValue;
    dom.classList.toggle(
      "is-empty",
      !identifierValue.trim() && !urlValue.trim() && !titleValue.trim()
    );
    dom.classList.toggle("is-title-empty", !titleValue.trim());
  };
  sync();

  const syncEmptyState = (): void => {
    dom.classList.toggle(
      "is-empty",
      !identifier.value.trim() &&
        !url.value.trim() &&
        !title.value.trim()
    );
    dom.classList.toggle("is-title-empty", !title.value.trim());
  };

  const commitAttrs = (): void => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    const live = view.state.doc.nodeAt(pos);
    if (live?.type.name !== LINK_REFERENCE_DEFINITION_NAME) return;
    const identifierValue = identifier.value.trim();
    const attrs = {
      ...live.attrs,
      identifier: identifierValue,
      label: identifierValue,
      url: url.value.trim(),
      title: title.value.trim() || null,
    };
    if (
      String(live.attrs.identifier ?? "") === attrs.identifier &&
      String(live.attrs.label ?? "") === attrs.label &&
      String(live.attrs.url ?? "") === attrs.url &&
      String(live.attrs.title ?? "") === String(attrs.title ?? "")
    ) {
      return;
    }
    view.dispatch(
      view.state.tr.setNodeMarkup(pos, undefined, attrs)
    );
  };

  const hasAnyDefinitionInput = (): boolean =>
    !!identifier.value.trim() ||
    !!url.value.trim() ||
    !!title.value.trim();

  const removeIncompleteDefinition = (focusEditor: boolean): boolean => {
    const pos = getPos();
    if (typeof pos !== "number") return false;
    const live = view.state.doc.nodeAt(pos);
    if (live?.type.name !== LINK_REFERENCE_DEFINITION_NAME) {
      return false;
    }
    return deleteEmptyEditableBlock(
      view,
      pos,
      live.nodeSize,
      focusEditor
    );
  };

  const replaceStaleDefinitionSelection = (): void => {
    const selection = view.state.selection;
    if (selection.$from.parent.isTextblock) return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    const live = view.state.doc.nodeAt(pos);
    if (live?.type.name !== LINK_REFERENCE_DEFINITION_NAME) return;
    const after = pos + live.nodeSize;
    const next = view.state.doc.resolve(after).nodeAfter;
    let tr = view.state.tr;
    if (next?.isTextblock) {
      const selection = TextSelection.near(
        tr.doc.resolve(after + 1),
        1
      );
      if (!selection) return;
      tr = tr.setSelection(selection);
    } else {
      const paragraph = view.state.schema.nodes.paragraph;
      if (!paragraph) return;
      tr = tr.insert(after, paragraph.create());
      tr = tr.setSelection(
        TextSelection.create(tr.doc, after + 1)
      );
    }
    view.dispatch(tr.setMeta("addToHistory", false));
  };

  const moveOut = (direction: -1 | 1): void => {
    if (!hasAnyDefinitionInput()) {
      removeIncompleteDefinition(true);
      return;
    }
    commitAttrs();
    const pos = getPos();
    if (typeof pos !== "number") return;
    if (direction > 0) {
      exitToNextLine(view, pos, node.nodeSize);
      return;
    }
    const selection = TextSelection.near(
      view.state.doc.resolve(Math.max(1, pos)),
      -1
    );
    if (selection) {
      view.dispatch(
        view.state.tr.setSelection(selection).scrollIntoView()
      );
    }
    view.focus();
  };

  const onInput = (event: Event): void => {
    event.stopPropagation();
    syncEmptyState();
  };
  const onFocusOut = (event: FocusEvent): void => {
    event.stopPropagation();
    queueMicrotask(() => {
      if (
        dom.contains(document.activeElement) ||
        !dom.isConnected
      ) {
        return;
      }
      if (hasAnyDefinitionInput()) commitAttrs();
      else removeIncompleteDefinition(false);
      replaceStaleDefinitionSelection();
    });
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    event.stopPropagation();
    const input = event.target as HTMLInputElement;
    const fields = [identifier, url, title];
    const fieldIndex = fields.indexOf(input);
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveOut(-1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveOut(1);
    } else if (event.key === "ArrowLeft") {
      if (
        input.selectionStart === 0 &&
        input.selectionEnd === 0 &&
        fieldIndex > 0
      ) {
        event.preventDefault();
        const previous = fields[fieldIndex - 1];
        previous.focus();
        previous.setSelectionRange(
          previous.value.length,
          previous.value.length
        );
        return;
      }
      if (
        fieldIndex === 0 &&
        input.selectionStart === 0 &&
        input.selectionEnd === 0
      ) {
        event.preventDefault();
        moveOut(-1);
      }
    } else if (event.key === "ArrowRight") {
      const atEnd =
        input.selectionStart === input.value.length &&
        input.selectionEnd === input.value.length;
      if (atEnd && fieldIndex >= 0 && fieldIndex < fields.length - 1) {
        event.preventDefault();
        const next = fields[fieldIndex + 1];
        next.focus();
        next.setSelectionRange(0, 0);
        return;
      }
      if (
        fieldIndex === fields.length - 1 &&
        atEnd
      ) {
        event.preventDefault();
        moveOut(1);
      }
    }
  };

  for (const input of [identifier, url, title]) {
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKeyDown);
  }
  dom.addEventListener("focusout", onFocusOut);

  return {
    dom,
    update(nextNode) {
      if (nextNode.type !== node.type) return false;
      node = nextNode;
      if (!dom.contains(document.activeElement)) sync();
      return true;
    },
    stopEvent(event) {
      return event.target instanceof Node && dom.contains(event.target);
    },
    ignoreMutation: () => true,
    destroy() {
      for (const input of [identifier, url, title]) {
        input.removeEventListener("input", onInput);
        input.removeEventListener("keydown", onKeyDown);
      }
      dom.removeEventListener("focusout", onFocusOut);
    },
  };
};

export const linkReferenceDefinitionSchema = $nodeSchema(
  LINK_REFERENCE_DEFINITION_NAME,
  () => ({
    group: "block",
    atom: true,
    selectable: false,
    defining: true,
    attrs: {
      identifier: { default: "" },
      label: { default: "" },
      url: { default: "" },
      title: { default: null },
    },
    parseDOM: [
      {
        tag: `div[data-type="${LINK_REFERENCE_DEFINITION_NAME}"]`,
        getAttrs: (dom) => {
          if (!(dom instanceof HTMLElement)) return false;
          return {
            identifier: dom.dataset.identifier ?? "",
            label: dom.dataset.label ?? "",
            url: dom.dataset.url ?? "",
            title: dom.dataset.title ?? null,
          };
        },
      },
    ],
    toDOM: (node) => [
      "div",
      {
        class: "mt-link-reference-definition",
        "data-type": LINK_REFERENCE_DEFINITION_NAME,
        "data-identifier": String(node.attrs.identifier ?? ""),
        "data-label": String(node.attrs.label ?? ""),
        "data-url": String(node.attrs.url ?? ""),
        "data-title": String(node.attrs.title ?? ""),
      },
    ],
    parseMarkdown: {
      match: (node) => node.type === LINK_REFERENCE_DEFINITION_NAME,
      runner: (state, node, type) => {
        const label = String(node.label ?? node.identifier ?? "").trim();
        const url = String(node.url ?? "").trim();
        if (!label || !url) return;
        state
          .openNode(type, {
            identifier: normalizeLinkReferenceIdentifier(label),
            label,
            url,
            title:
              typeof node.title === "string" && node.title
                ? node.title
                : null,
          })
          .closeNode();
      },
    },
    toMarkdown: {
      match: (node) =>
        node.type.name === LINK_REFERENCE_DEFINITION_NAME,
      runner: (state, node) => {
        const parsed = linkReferenceDefinitionFromAttrs(node.attrs);
        if (!parsed) {
          const label = String(node.attrs.label ?? "").trim();
          const url = String(node.attrs.url ?? "").trim();
          state.addNode(
            "html",
            undefined,
            `[${label}]: ${url || ""}`.trimEnd() + " "
          );
          return;
        }
        state.addNode("definition", undefined, undefined, {
          identifier: parsed.identifier,
          label: parsed.label,
          url: parsed.url,
          title: parsed.title,
        });
      },
    },
  })
);

export const linkReferenceDefinitionView = $view(
  linkReferenceDefinitionSchema.node,
  () => createLinkReferenceDefinitionNodeView
);

export const linkReferenceMarkSchema = $markSchema(
  LINK_REFERENCE_MARK_NAME,
  () => ({
    attrs: {
      identifier: { default: "" },
      label: { default: "" },
      url: { default: "" },
      title: { default: null },
      referenceType: { default: "full" },
    },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[data-reference-label]",
        getAttrs: (dom) => {
          if (!(dom instanceof HTMLElement)) return false;
          return {
            identifier: dom.dataset.referenceIdentifier ?? "",
            label: dom.dataset.referenceLabel ?? "",
            url: dom.getAttribute("href") ?? "",
            title: dom.getAttribute("title"),
            referenceType: dom.dataset.referenceType ?? "full",
          };
        },
      },
    ],
    toDOM: (mark) => [
      "a",
      {
        href: String(mark.attrs.url ?? ""),
        title: mark.attrs.title,
        "data-reference-identifier": String(
          mark.attrs.identifier ?? ""
        ),
        "data-reference-label": String(mark.attrs.label ?? ""),
        "data-reference-type": String(
          mark.attrs.referenceType ?? "full"
        ),
      },
      0,
    ],
    parseMarkdown: {
      match: (node) => node.type === LINK_REFERENCE_MARK_NAME,
      runner: (state, node, type) => {
        state
          .openMark(type, {
            identifier: String(node.identifier ?? ""),
            label: String(node.label ?? node.identifier ?? ""),
            url: String(node.url ?? ""),
            title:
              typeof node.title === "string" && node.title
                ? node.title
                : null,
            referenceType: String(node.referenceType ?? "full"),
          })
          .next(node.children)
          .closeMark(type);
      },
    },
    toMarkdown: {
      match: (mark) => mark.type.name === LINK_REFERENCE_MARK_NAME,
      runner: (state, mark) => {
        state.withMark(mark, "linkReference", undefined, {
          identifier: String(mark.attrs.identifier ?? ""),
          label: String(
            mark.attrs.label ?? mark.attrs.identifier ?? ""
          ),
          referenceType: String(
            mark.attrs.referenceType ?? "full"
          ),
        });
      },
    },
  })
);

const linkReferenceDefinitionRemarkTransform: RemarkPluginRaw<never[]> =
  () => (tree) => {
    const definitions = new Map<
      string,
      { url: string; title: string | null; label: string }
    >();
    const collectDefinitions = (node: MarkdownNode): void => {
      if (!Array.isArray(node.children)) return;
      for (const child of node.children) {
        if (child.type === "definition") {
          const identifier = String(child.identifier ?? "").toLowerCase();
          if (!identifier || identifier.startsWith("^")) continue;
          definitions.set(identifier, {
            url: String(child.url ?? ""),
            title:
              typeof child.title === "string" && child.title
                ? child.title
                : null,
            label: String(child.label ?? child.identifier ?? ""),
          });
        }
        collectDefinitions(child);
      }
    };
    collectDefinitions(tree as unknown as MarkdownNode);

    const visit = (node: MarkdownNode): void => {
      if (!Array.isArray(node.children)) return;
      for (let index = 0; index < node.children.length; index += 1) {
        let child = node.children[index];
        if (child.type === "definition") {
          child = {
            ...child,
            type: LINK_REFERENCE_DEFINITION_NAME,
          };
          node.children[index] = child;
        } else if (child.type === "linkReference") {
          const identifier = String(
            child.identifier ?? ""
          ).toLowerCase();
          const definition = definitions.get(identifier);
          child = {
            ...child,
            type: LINK_REFERENCE_MARK_NAME,
            identifier,
            label: String(
              child.label ?? child.identifier ?? ""
            ),
            url: definition?.url ?? "",
            title: definition?.title ?? null,
          };
          node.children[index] = child;
        }
        visit(child);
      }
    };
    visit(tree as unknown as MarkdownNode);
  };

export const linkReferenceDefinitionRemark = $remark(
  "notemark-link-reference-definition",
  () => linkReferenceDefinitionRemarkTransform
);

function nextReferenceIdentifier(state: EditorState): string {
  const used = new Set<string>();
  state.doc.descendants((node) => {
    if (node.type.name !== LINK_REFERENCE_DEFINITION_NAME) return true;
    const parsed = linkReferenceDefinitionFromAttrs(node.attrs);
    if (parsed) used.add(parsed.identifier);
    return false;
  });
  let identifier = "site";
  let suffix = 2;
  while (used.has(identifier)) {
    identifier = `site-${suffix}`;
    suffix += 1;
  }
  return identifier;
}

/**
 * Insert `[site]: https://example.com` as a block. An empty paragraph is
 * replaced; at the start of a non-empty paragraph the definition goes before
 * that paragraph; elsewhere it goes after the current top-level block.
 */
export function insertLinkReferenceDefinition(
  view: EditorView
): boolean {
  const state = view.state;
  const nodeType =
    state.schema.nodes[LINK_REFERENCE_DEFINITION_NAME];
  const markType = state.schema.marks[LINK_REFERENCE_MARK_NAME];
  if (!nodeType || !markType) return false;

  const revealDefinition = (
    definitionPos: number,
    focusInput: boolean
  ): void => {
    requestAnimationFrame(() => {
      if (
        view.isDestroyed ||
        definitionPos >= view.state.doc.content.size
      ) {
        return;
      }
      const dom = view.nodeDOM(definitionPos);
      if (!(dom instanceof HTMLElement)) return;
      dom.scrollIntoView?.({ block: "nearest" });
      if (focusInput) {
        dom
          .querySelector<HTMLInputElement>(
            '.mt-link-reference-definition__identifier'
          )
          ?.focus({ preventScroll: true });
      }
    });
  };

  const selection = state.selection;
  if (selection.$from.depth === 0) {
    const definition = nodeType.create({
      identifier: "",
      label: "",
      url: "",
      title: null,
    });
    const insertAt = selection.empty
      ? Math.min(selection.from, state.doc.content.size)
      : selection.to;
    view.dispatch(state.tr.insert(insertAt, definition));
    revealDefinition(insertAt, true);
    return true;
  }

  let depth = selection.$from.depth;
  while (depth > 1) depth -= 1;

  const { $from } = selection;
  const blockStart = $from.before(depth);
  const blockEnd = $from.after(depth);
  const block = $from.node(depth);
  const replaceEmptyParagraph =
    block.type === state.schema.nodes.paragraph &&
    block.content.size === 0;
  const hasSelection = !selection.empty;
  const insertBeforeParagraph =
    !hasSelection &&
    !replaceEmptyParagraph &&
    $from.parentOffset === 0;
  const identifier = hasSelection ? nextReferenceIdentifier(state) : "";
  const url = "https://example.com";
  const definition = nodeType.create(
    hasSelection
      ? {
          identifier,
          label: identifier,
          url,
          title: null,
        }
      : {
          identifier: "",
          label: "",
          url: "",
          title: null,
        }
  );

  const tr = state.tr;
  if (hasSelection) {
    tr.addMark(
      selection.from,
      selection.to,
      markType.create({
        identifier,
        label: identifier,
        url,
        title: null,
        referenceType: "full",
      })
    );
  }
  const definitionPos = replaceEmptyParagraph
    ? blockStart
    : insertBeforeParagraph
      ? blockStart
      : blockEnd;
  if (replaceEmptyParagraph) {
    tr.replaceWith(blockStart, blockEnd, definition);
  } else if (insertBeforeParagraph) {
    tr.insert(blockStart, definition);
  } else {
    tr.insert(blockEnd, definition);
  }
  view.dispatch(tr);
  revealDefinition(definitionPos, !hasSelection);
  if (hasSelection) view.focus();
  return true;
}

export const linkReferenceDefinitionPlugins: MilkdownPlugin[] = [
  ...linkReferenceDefinitionSchema,
  linkReferenceDefinitionView,
  ...linkReferenceMarkSchema,
];
