/*
 * docxExporter.ts — 把 ProseMirror 文档导出为 Word（.docx）
 *
 * 实现思路：直接遍历 ProseMirror 文档树生成 OOXML，而不是从 HTML 转换。
 * 这样能利用文档的语义结构（标题层级、列表、表格、引用、代码块），
 * 比「HTML 套 .doc 扩展名」的方式结构正确、且是真正的 .docx。
 *
 * 已知降级（Word 无法表达或成本过高）：
 * - 代码块保留文本与等宽字体、灰底，但不保留语法高亮配色
 * - KaTeX 公式 / Mermaid 图表退化为源码文本（Word 无法承载渲染结果）
 * - 图片尽力内嵌（仅 png/jpg/gif/bmp；svg 等格式降级为文件名文字）
 * - 嵌套表格不做支持（Word 单元格内嵌表格结构复杂），内层内容以段落呈现
 * - task list 的勾选框以 [x] / [ ] 文本标记
 */

import {
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { IRunOptions } from "docx";
import type { Node as PMNode, Mark as PMMark } from "@milkdown/kit/prose/model";
import type { Editor } from "@milkdown/kit/core";
// editorViewCtx 在运行时由 @milkdown/kit/core 导出（d.ts 遗漏声明），见 index.ts 说明。
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore editorViewCtx 运行时可用（d.ts 未声明）
import { editorViewCtx } from "@milkdown/kit/core";

/** 段落级元素（Document 的 children） */
type BlockChild = Paragraph | Table;
/** 段落内联元素 */
type InlineChild = TextRun | ExternalHyperlink | ImageRun;
/** TextRun 构造参数类型（docx 导出该类型；TextRun 本身还接受 string 参数） */
type TextRunOptions = IRunOptions;

/** 标题层级映射（1~6） */
const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

/** 图片最大宽度（像素） */
const MAX_IMAGE_WIDTH = 480;

/**
 * 生成 .docx 文件的二进制内容。
 * @param editor 编辑器实例
 */
export async function buildDocx(editor: Editor): Promise<Uint8Array> {
  const doc = editor.action(
    (ctx) => ctx.get(editorViewCtx).state.doc
  ) as PMNode;
  const children = await convertBlocks(doc);
  // Word 文档至少要有一个段落，空文档补一个空段落
  if (children.length === 0) children.push(new Paragraph({ children: [] }));
  const document = new Document({ sections: [{ children }] });
  const buffer = await Packer.toArrayBuffer(document);
  return new Uint8Array(buffer);
}

/* ============ 块级节点 ============ */

async function convertBlocks(parent: PMNode): Promise<BlockChild[]> {
  const out: BlockChild[] = [];
  for (let i = 0; i < parent.childCount; i += 1) {
    out.push(...(await convertBlock(parent.child(i))));
  }
  return out;
}

async function convertBlock(node: PMNode): Promise<BlockChild[]> {
  switch (node.type.name) {
    case "heading": {
      const level = clampLevel(Number(node.attrs.level) || 1);
      return [
        new Paragraph({
          heading: level,
          spacing: { before: 200, after: 100 },
          children: await convertInline(node),
        }),
      ];
    }

    case "paragraph":
      return [
        new Paragraph({ spacing: { after: 120 }, children: await convertInline(node) }),
      ];

    case "blockquote": {
      const out: BlockChild[] = [];
      for (let i = 0; i < node.childCount; i += 1) {
        const child = node.child(i);
        if (child.type.name === "paragraph") {
          out.push(
            new Paragraph({
              indent: { left: 480 },
              border: {
                left: { style: BorderStyle.SINGLE, size: 12, color: "BFBFBF", space: 8 },
              },
              children: await convertInline(child),
            })
          );
        } else {
          // 引用块内的列表/代码块等：递归处理（缩进样式不再叠加）
          out.push(...(await convertBlock(child)));
        }
      }
      return out;
    }

    case "bullet_list": {
      const out: BlockChild[] = [];
      for (let i = 0; i < node.childCount; i += 1) {
        out.push(...(await convertListItem(node.child(i), "• ")));
      }
      return out;
    }

    case "ordered_list": {
      const out: BlockChild[] = [];
      for (let i = 0; i < node.childCount; i += 1) {
        out.push(...(await convertListItem(node.child(i), `${i + 1}. `)));
      }
      return out;
    }

    case "code_block":
    case "fence": {
      const lines = node.textContent.split("\n");
      return lines.map(
        (line) =>
          new Paragraph({
            shading: { fill: "F5F5F5" },
            spacing: { before: 0, after: 0 },
            children: [new TextRun({ text: line || " ", font: "Consolas", size: 20 })],
          })
      );
    }

    case "table": {
      const rows: TableRow[] = [];
      for (let r = 0; r < node.childCount; r += 1) {
        const rowNode = node.child(r);
        const cells: TableCell[] = [];
        for (let c = 0; c < rowNode.childCount; c += 1) {
          const cellNode = rowNode.child(c);
          const inner = await convertBlocks(cellNode);
          // 单元格只接受段落；嵌套表格等内容降级为段落文本
          const paragraphs = inner.filter((x): x is Paragraph => x instanceof Paragraph);
          cells.push(
            new TableCell({
              children: paragraphs.length ? paragraphs : [new Paragraph({ children: [] })],
            })
          );
        }
        rows.push(new TableRow({ children: cells }));
      }
      return [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })];
    }

    case "image": {
      const embedded = await embedImage(String(node.attrs.src ?? ""));
      if (embedded) return [new Paragraph({ children: [embedded] })];
      const label = String(node.attrs.alt ?? "") || "图片";
      return [
        new Paragraph({
          children: [new TextRun({ text: `[${label}]`, italics: true, color: "888888" })],
        }),
      ];
    }

    case "hr":
    case "horizontal_rule":
      return [
        new Paragraph({
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 6, color: "CCCCCC", space: 1 },
          },
          children: [],
        }),
      ];

    // 数学公式 / 图表：Word 无法承载渲染结果，退化为源码文本
    case "math_block":
    case "diagram":
      return [
        new Paragraph({
          children: [
            new TextRun({
              text: sourceOf(node),
              font: "Consolas",
              color: "666666",
              size: 20,
            }),
          ],
        }),
      ];

    // [toc] 目录节点在 Word 中没有对应物（Word 有自己的目录域），跳过
    case "toc":
      return [];

    default: {
      if (node.isTextblock) {
        return [new Paragraph({ children: await convertInline(node) })];
      }
      // 未知容器节点：递归展开其内容
      return convertBlocks(node);
    }
  }
}

/** 列表项：首段加标记前缀，嵌套块递归处理 */
async function convertListItem(item: PMNode, marker: string): Promise<BlockChild[]> {
  const out: BlockChild[] = [];
  for (let i = 0; i < item.childCount; i += 1) {
    const child = item.child(i);
    if (child.type.name === "paragraph") {
      out.push(
        new Paragraph({
          indent: { left: 480 },
          children: [
            new TextRun({ text: marker, font: "Consolas" }),
            ...(await convertInline(child)),
          ],
        })
      );
    } else {
      out.push(...(await convertBlock(child)));
    }
  }
  return out;
}

/* ============ 内联节点 ============ */

async function convertInline(parent: PMNode): Promise<InlineChild[]> {
  const out: InlineChild[] = [];
  for (let i = 0; i < parent.childCount; i += 1) {
    const child = parent.child(i);
    if (child.isText) {
      out.push(...textRuns(child.text ?? "", child.marks));
      continue;
    }
    switch (child.type.name) {
      case "hard_break":
        out.push(new TextRun({ text: "", break: 1 }));
        break;
      case "math_inline":
        out.push(
          new TextRun({
            text: `$${sourceOf(child)}$`,
            font: "Consolas",
            color: "666666",
          })
        );
        break;
      case "image": {
        const embedded = await embedImage(String(child.attrs.src ?? ""));
        if (embedded) out.push(embedded);
        break;
      }
      default:
        // 未知内联节点（含加粗/斜体等 mark 容器）：递归展开
        out.push(...(await convertInline(child)));
    }
  }
  return out;
}

/** 文本节点 → TextRun（链接用 ExternalHyperlink 包裹） */
function textRuns(text: string, marks: readonly PMMark[]): InlineChild[] {
  if (!text) return [];
  const link = marks.find((m) => m.type.name === "link");
  if (link && link.attrs.href) {
    return [
      new ExternalHyperlink({
        link: String(link.attrs.href),
        children: [new TextRun(applyMarks({ text, style: "Hyperlink" }, marks))],
      }),
    ];
  }
  return [new TextRun(applyMarks({ text }, marks))];
}

/** 把 ProseMirror 的 mark 映射为 TextRun 的样式选项 */
function applyMarks(base: TextRunOptions, marks: readonly PMMark[]): TextRunOptions {
  const opts: Record<string, unknown> = { ...base };
  for (const mark of marks) {
    switch (mark.type.name) {
      case "strong":
        opts.bold = true;
        break;
      case "emphasis":
        opts.italics = true;
        break;
      case "strike":
      case "strikeout":
        opts.strike = true;
        break;
      case "underline":
        opts.underline = {};
        break;
      case "code":
        opts.font = "Consolas";
        opts.shading = { fill: "F2F2F2" };
        break;
      case "highlight":
        opts.highlight = "yellow";
        break;
      case "superscript":
        opts.superScript = true;
        break;
      case "subscript":
        opts.subScript = true;
        break;
    }
  }
  return opts as TextRunOptions;
}

/* ============ 工具 ============ */

function clampLevel(level: number) {
  const index = Math.min(Math.max(level, 1), HEADING_LEVELS.length) - 1;
  return HEADING_LEVELS[index];
}

/** 取节点的源码文本（公式 LaTeX / 图表 Mermaid 定义） */
function sourceOf(node: PMNode): string {
  const attrs = (node.attrs ?? {}) as Record<string, unknown>;
  const value = attrs.value ?? attrs.latex ?? attrs.code ?? attrs.content;
  return typeof value === "string" && value ? value : node.textContent;
}

/** 读取图片原始尺寸（用于按比例缩放） */
function loadImageSize(src: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * 内嵌图片到 docx。
 * 仅支持 png/jpg/gif/bmp（OOXML 光栅图）；svg 等格式返回 null 由调用方降级。
 */
async function embedImage(src: string): Promise<ImageRun | null> {
  if (!src) return null;
  const clean = src.split("?")[0].split("#")[0];
  const ext = (clean.split(".").pop() ?? "").toLowerCase();
  const type =
    ext === "png" ? "png"
    : ext === "jpg" || ext === "jpeg" ? "jpg"
    : ext === "gif" ? "gif"
    : ext === "bmp" ? "bmp"
    : null;
  if (!type) return null;
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const data = await res.arrayBuffer();
    const size = await loadImageSize(src);
    const width = size?.w ? Math.min(size.w, MAX_IMAGE_WIDTH) : MAX_IMAGE_WIDTH;
    const height = size?.w ? Math.round((size.h * width) / size.w) : 320;
    return new ImageRun({
      type,
      data,
      transformation: { width, height: height || 320 },
    });
  } catch (err) {
    console.warn("[NoteMark] embed image failed:", src, err);
    return null;
  }
}
