import { Fragment, type Node as PMNode } from "@milkdown/prose/model";
import { TextSelection } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import {
  formatLinkReferenceDefinition,
  linkReferenceDefinitionFromAttrs,
} from "./link-reference-definition";

export type ObjectMenuKind =
  | "html-block"
  | "link-reference-definition"
  | "footnote-reference"
  | "frontmatter"
  | "toc"
  | "horizontal-rule"
  | "alert-title";

export interface ObjectMenuContext {
  kind: ObjectMenuKind;
  element: HTMLElement;
  container: HTMLElement;
  node: PMNode | null;
  pos: number;
  source: string;
}

const NODE_SELECTORS: Array<[ObjectMenuKind, string]> = [
  ["alert-title", ".md-alert-title"],
  ["html-block", ".mt-html-block"],
  ["link-reference-definition", ".mt-link-reference-definition"],
  ["footnote-reference", '[data-type="footnote_reference"]'],
  ["frontmatter", ".mt-frontmatter"],
  ["toc", ".mt-toc"],
  ["horizontal-rule", "hr"],
];

function findNodeAt(view: EditorView, element: HTMLElement): {
  node: PMNode | null;
  pos: number;
} {
  let pos = -1;
  try {
    pos = view.posAtDOM(element, 0);
  } catch {
    return { node: null, pos: -1 };
  }

  for (const candidate of [pos, pos - 1, pos + 1]) {
    if (candidate < 0 || candidate > view.state.doc.content.size) continue;
    const node = view.state.doc.nodeAt(candidate);
    if (node) return { node, pos: candidate };
  }
  return { node: null, pos };
}

function findAncestorNodeAt(
  view: EditorView,
  element: HTMLElement,
  typeName: string
): { node: PMNode | null; pos: number } {
  let pos = -1;
  try {
    pos = view.posAtDOM(element, 0);
  } catch {
    return { node: null, pos: -1 };
  }
  const safe = Math.max(0, Math.min(pos, view.state.doc.content.size));
  const $pos = view.state.doc.resolve(safe);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name === typeName) {
      return { node, pos: $pos.before(depth) };
    }
  }
  return { node: null, pos };
}

function containerSource(kind: ObjectMenuKind, node: PMNode | null): string {
  if (node) {
    if (kind === "link-reference-definition") {
      const definition = linkReferenceDefinitionFromAttrs(node.attrs);
      return definition ? formatLinkReferenceDefinition(definition) : "";
    }
    if (kind === "footnote-reference") {
      const label = String(node.attrs.label ?? "").trim();
      return label ? `[^${label}]` : "";
    }
    const value = node.attrs.value;
    if (typeof value === "string" && value) return value;
  }
  switch (kind) {
    case "toc":
      return "[toc]";
    case "horizontal-rule":
      return "---";
    default:
      return "";
  }
}

export function resolveObjectMenuContext(
  view: EditorView,
  target: Element
): ObjectMenuContext | null {
  for (const [kind, selector] of NODE_SELECTORS) {
    const matchedElement = target.closest<HTMLElement>(selector);
    if (!matchedElement) continue;
    const element =
      kind === "alert-title"
        ? (matchedElement.querySelector<HTMLElement>(".md-alert-title") ??
          matchedElement)
        : matchedElement;
    const container =
      matchedElement.closest<HTMLElement>(
        kind === "alert-title"
          ? ".md-alert"
          : element.tagName.toLowerCase()
      ) ?? element;
    const { node, pos } =
      kind === "alert-title"
        ? findAncestorNodeAt(view, container, "alert")
        : findNodeAt(view, container);
    let source = containerSource(kind, node);
    if (kind === "alert-title") {
      source = element.textContent?.trim() ?? "";
    }
    return { kind, element, container, node, pos, source };
  }
  return null;
}

export function deleteObjectNode(
  view: EditorView,
  context: ObjectMenuContext
): boolean {
  if (!context.node || context.pos < 0) return false;
  view.dispatch(
    view.state.tr.delete(context.pos, context.pos + context.node.nodeSize)
  );
  view.focus();
  return true;
}

export type TextblockConversion =
  | { type: "paragraph" }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 };

export function canConvertBlockSourceToHeading(source: string): boolean {
  const trimmed = source.trim();
  return !!trimmed && !/[\r\n]/.test(trimmed);
}

function sourceText(node: PMNode, fallback: string): string {
  if (fallback) return fallback;
  if (node.content.size === 0) return "";
  return node.textBetween(0, node.content.size, "\n", "\n");
}

function createInlineContent(view: EditorView, source: string): PMNode[] {
  const hardBreakType = view.state.schema.nodes.hardbreak;
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const inline: PMNode[] = [];
  // One hard break per source newline, including blank lines.
  lines.forEach((line, index) => {
    if (line) inline.push(view.state.schema.text(line));
    if (hardBreakType && index < lines.length - 1) {
      inline.push(hardBreakType.create());
    } else if (!hardBreakType && index < lines.length - 1) {
      inline.push(view.state.schema.text(" "));
    }
  });
  return inline;
}

function convertAlertMarkerInBlockquote(
  view: EditorView,
  node: PMNode,
  pos: number,
  target: TextblockConversion
): boolean {
  const paragraphType = view.state.schema.nodes.paragraph;
  const headingType = view.state.schema.nodes.heading;
  const blockquoteType = view.state.schema.nodes.blockquote;
  if (!paragraphType || !headingType || !blockquoteType) return false;

  const marker = `[!${String(node.attrs.alertType ?? "note").toUpperCase()}]`;
  const markerContent = createInlineContent(view, marker);
  const markerBlock =
    target.type === "paragraph"
      ? paragraphType.create(null, markerContent)
      : headingType.create({ level: target.level }, markerContent);
  const contentNodes: PMNode[] = [];
  const title = String(node.attrs.title ?? "").trim();
  if (title) {
    contentNodes.push(
      paragraphType.create(null, view.state.schema.text(title))
    );
  }
  node.content.forEach((child) => contentNodes.push(child));
  const blockquote = blockquoteType.create(
    null,
    Fragment.fromArray([markerBlock, ...contentNodes])
  );
  const tr = view.state.tr.replaceWith(pos, pos + node.nodeSize, blockquote);
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 2)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

export function convertBlockToTextblock(
  view: EditorView,
  node: PMNode,
  pos: number,
  source: string,
  target: TextblockConversion
): boolean {
  if (!node.isBlock || pos < 0) return false;
  const targetType =
    target.type === "paragraph"
      ? view.state.schema.nodes.paragraph
      : view.state.schema.nodes.heading;
  if (!targetType) return false;
  const inline = createInlineContent(view, sourceText(node, source));

  const replacement =
    target.type === "paragraph"
      ? targetType.create(null, inline)
      : targetType.create({ level: target.level }, inline);
  const tr = view.state.tr.replaceWith(
    pos,
    pos + node.nodeSize,
    replacement
  );
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

export function convertObjectBlockToTextblock(
  view: EditorView,
  context: ObjectMenuContext,
  target: TextblockConversion
): boolean {
  if (!context.node) return false;
  if (context.kind === "alert-title") {
    return convertAlertMarkerInBlockquote(
      view,
      context.node,
      context.pos,
      target
    );
  }
  return convertBlockToTextblock(
    view,
    context.node,
    context.pos,
    objectBlockTextSource(context),
    target
  );
}

export function objectBlockTextSource(context: ObjectMenuContext): string {
  let source = context.source;
  if (context.kind === "alert-title") {
    const type = String(context.node?.attrs.alertType ?? "note").toUpperCase();
    const title = String(context.node?.attrs.title ?? "").trim();
    const body = context.node ? sourceText(context.node, "") : "";
    source = `[!${type}]${title ? ` ${title}` : ""}${body ? `\n${body}` : ""}`;
  }
  return source;
}

function frontmatterBody(context: ObjectMenuContext): string {
  return String(context.node?.attrs.value ?? context.source)
    .replace(/\r\n?/g, "\n");
}

export function objectClipboardSource(context: ObjectMenuContext): string {
  if (context.kind !== "frontmatter") return context.source;
  const value = frontmatterBody(context).replace(/\n+$/, "");
  return `---\n${value}\n---`;
}

export function objectPlainTextSource(context: ObjectMenuContext): string {
  return context.kind === "frontmatter"
    ? frontmatterBody(context)
    : context.source;
}

export function convertFrontmatterToParagraph(
  view: EditorView,
  context: ObjectMenuContext
): boolean {
  if (context.kind !== "frontmatter") return false;
  return convertObjectBlockToTextblock(view, context, { type: "paragraph" });
}
