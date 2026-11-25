import type { MilkdownPlugin } from "@milkdown/ctx";
import { $remark } from "@milkdown/kit/utils";

interface MarkdownPositionPoint {
  line: number;
}

interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  position?: {
    start: MarkdownPositionPoint;
    end: MarkdownPositionPoint;
  };
}

interface MarkdownRoot extends MarkdownNode {
  children: MarkdownNode[];
}

/**
 * remark-stringify uses two blank-line slots between adjacent blocks: one
 * normal Markdown block separator and one line box for each empty paragraph.
 * The first two lines are therefore the separator; every additional pair
 * represents exactly one empty paragraph.
 */
const BLOCK_SEPARATOR_LINES = 2;
const LINES_PER_EMPTY_PARAGRAPH = 2;

/**
 * Markdown has no AST node for an empty paragraph. remark-stringify writes one
 * ordinary blank line between blocks, so extra blank lines can be restored as
 * empty paragraph nodes when the source already contains them.
 */
function restoreTopLevelEmptyParagraphs(
  tree: MarkdownRoot
): void {
  for (let index = tree.children.length - 1; index > 0; index -= 1) {
    const previous = tree.children[index - 1];
    const next = tree.children[index];
    const previousEnd = previous.position?.end.line;
    const nextStart = next.position?.start.line;
    if (previousEnd == null || nextStart == null) continue;

    const emptyParagraphCount = Math.max(
      0,
      Math.floor(
        (nextStart - previousEnd - BLOCK_SEPARATOR_LINES) /
          LINES_PER_EMPTY_PARAGRAPH
      )
    );
    if (emptyParagraphCount === 0) continue;
    for (let inserted = 0; inserted < emptyParagraphCount; inserted += 1) {
      tree.children.splice(index, 0, { type: "paragraph", children: [] });
    }
  }
}

export const emptyParagraphRemark = $remark(
  "notemark-empty-paragraph",
  () => () => (tree: unknown) => {
    restoreTopLevelEmptyParagraphs(tree as MarkdownRoot);
  }
);

export const emptyParagraphPlugins: MilkdownPlugin[] = [
  ...emptyParagraphRemark,
];
