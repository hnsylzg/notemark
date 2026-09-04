/*
 * docxExporter.ts — 把 ProseMirror 文档导出为 Word（.docx）
 *
 * 实现思路：直接遍历 ProseMirror 文档树生成 OOXML，而不是从 HTML 转换。
 * 这样能利用文档的语义结构（标题层级、列表、表格、引用、代码块），
 * 比「HTML 套 .doc 扩展名」的方式结构正确、且是真正的 .docx。
 *
 * 各类富内容的处理方式：
 * - 代码块：保留文本与等宽字体、灰底，不保留语法高亮配色
 * - 图片：优先内嵌真实位图（png/jpg/gif/bmp）；data URL 按 MIME 识别，
 *   svg 先栅格化成 png 再内嵌；无法读取时降级为文件名占位
 * - 公式（行内/块级）：KaTeX → MathML → OMML，作为 Word 原生公式注入
 *   （可在 Word 里继续编辑，与 Typora 导出一致）；转换失败时降级为
 *   栅格化图片，再失败则退化为源码文本
 * - Mermaid 图表：mermaid 渲染成 SVG 后栅格化成 png 内嵌（Word 无对应物）
 * - 嵌套表格：内层内容以段落呈现（Word 单元格内嵌表格结构复杂）
 * - task list 的勾选框以 [x] / [ ] 文本标记
 *
 * OMML 注入说明：docx 库不支持公式，故对公式节点先放一个唯一占位
 * TextRun，生成 docx 后用 JSZip 改写 word/document.xml，把占位 run
 * 替换为 <m:oMath>/<m:oMathPara>，并在 <w:document> 上声明 m 命名空间。
 */

import JSZip from "jszip";
import katex from "katex";
import { mml2omml } from "mathml2omml";
import { katexExportCss } from "./katex-export-css";
import {
  AlignmentType,
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

/** 可内嵌的位图类型；svg 先栅格化，不在此列 */
type RasterType = "png" | "jpg" | "gif" | "bmp";
/** 图片原始格式（含需转换的 svg） */
type ImageType = RasterType | "svg";

/** 标题层级映射（1~6） */
const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

/** 页面：A4（宽 11906 / 高 16838 twips）+ 四周各 1 英寸（1440 twips）页边距 */
const PAGE_W = 11906;
const PAGE_H = 16838;
const PAGE_MARGIN = 1440;
/** 内容区尺寸（twips）：宽 9026、高 13958 */
const PAGE_CONTENT_W = PAGE_W - 2 * PAGE_MARGIN;
const PAGE_CONTENT_H = PAGE_H - 2 * PAGE_MARGIN;

/** 图片最大宽度（像素，普通位图图片） */
const MAX_IMAGE_WIDTH = 480;

/**
 * Mermaid 图表宽度（像素）：尽量铺满内容区，仅留少量安全边距避免浮点误差溢出。
 * 内容区 9026 twips ≈ 601px，减 12px 安全边距 → 589px（约 5.6"，左右留白更小）。
 */
const MERMAID_WIDTH_PX = Math.floor((PAGE_CONTENT_W / 1440) * 96) - 12; // ≈ 589

/**
 * 插图最大高度占「内容区高度」的比例：1.0 = 占满整页，0.5 = 半页。
 * 竖图若按整页高度缩放会显得过大，默认限制为半页；需要更大/更小改这个比例即可。
 */
const MAX_FIGURE_HEIGHT_RATIO = 0.5;
/**
 * 插图最大高度（像素）：内容区高 13958 twips ≈ 930px × 0.5 → 465px。
 * 配合宽度上限做等比 contain 缩放，保证竖图（高/宽比大）不会过大。
 */
const MAX_FIGURE_HEIGHT_PX = Math.floor(
  (PAGE_CONTENT_H / 1440) * 96 * MAX_FIGURE_HEIGHT_RATIO
); // ≈ 465

/** Word 数学命名空间（OMML） */
const OMML_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math";

/** 公式占位 run 的唯一令牌前缀（docx 注入时按此定位并替换） */
const OMML_TOKEN_PREFIX = "OMMLPH";

/** 目录占位段（整段 <w:p>）的唯一令牌前缀 */
const TOC_TOKEN_PREFIX = "TOCPH";

/** 目录条目（预扫描收集，用于预填 TOC 域结果，避免打开时弹「更新域」警告） */
type TocEntry = { level: number; text: string; page: number };

/** 导出上下文：固定字号（docx half-points），与编辑器主题解耦 */
type ExportContext = {
  base: number;
  code: number;
  /** 本此导出中所有成功转为 OMML 的公式占位（token -> OMML 片段） */
  placeholders: { token: string; omml: string }[];
  /** 目录节点占位（token -> 整段 TOC 域 XML） */
  tocPlaceholders: { token: string; xml: string }[];
  /** 预扫描得到的全部标题（顺序与文档一致），用于预填 TOC 结果 */
  tocEntries: TocEntry[];
  /** 编辑器可视 DOM（用于复用已渲染的 Mermaid SVG 等），不可用时为 null */
  viewDom: HTMLElement | null;
};

/**
 * 生成 .docx 文件的二进制内容。
 * @param editor 编辑器实例
 */
export async function buildDocx(editor: Editor): Promise<Uint8Array> {
  const doc = editor.action(
    (ctx) => ctx.get(editorViewCtx).state.doc
  ) as PMNode;
  // 编辑器可视 DOM：供导出复用已渲染好的 Mermaid SVG（与屏幕/PDF 所见一致）
  const viewDom = editor.action(
    (c) => c.get(editorViewCtx).dom
  ) as HTMLElement | null;
  // 固定字号，对齐 Typora（pandoc 导出 Word：正文 12pt = 24 half-points，代码 10.5pt = 21 half-points）
  const ctx: ExportContext = {
    base: 24,
    code: 21,
    placeholders: [],
    tocPlaceholders: [],
    tocEntries: [],
    viewDom: viewDom ?? null,
  };
  collectToc(doc, ctx);
  const children = await convertBlocks(doc, ctx);
  // Word 文档至少要有一个段落，空文档补一个空段落
  if (children.length === 0) children.push(new Paragraph({ children: [] }));
  const document = new Document({
    styles: {
      default: {
        document: {
          run: { size: ctx.base },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            // A4 纸张 + 1 英寸页边距，使内容宽度确定，便于图表按页面宽度缩放
            size: { width: 11906, height: 16838, orientation: "portrait" },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        children,
      },
    ],
  });
  let buffer = await Packer.toArrayBuffer(document);
  // 把公式占位 run 替换为 OMML、目录占位段替换为 TOC 域，并声明命名空间/更新域
  if (ctx.placeholders.length || ctx.tocPlaceholders.length) {
    buffer = await injectOmml(buffer, ctx.placeholders, ctx.tocPlaceholders);
  }
  return new Uint8Array(buffer);
}

/* ============ 块级节点 ============ */

async function convertBlocks(parent: PMNode, ctx: ExportContext): Promise<BlockChild[]> {
  const out: BlockChild[] = [];
  for (let i = 0; i < parent.childCount; i += 1) {
    out.push(...(await convertBlock(parent.child(i), ctx)));
  }
  return out;
}

async function convertBlock(node: PMNode, ctx: ExportContext): Promise<BlockChild[]> {
  switch (node.type.name) {
    case "heading": {
      const level = clampLevel(Number(node.attrs.level) || 1);
      return [
        new Paragraph({
          heading: level,
          spacing: { before: 200, after: 100 },
          children: await convertInline(node, ctx),
        }),
      ];
    }

    case "paragraph":
      return [
        new Paragraph({
          spacing: { after: 120 },
          // 段落里嵌着 <center> 的行内 HTML 时整段居中（此前只在 default 分支
          // 判定，而 paragraph 有独立分支，导致居中判定根本执行不到）
          alignment: paragraphAlignment(node),
          children: await convertInline(node, ctx),
        }),
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
              children: await convertInline(child, ctx),
            })
          );
        } else {
          // 引用块内的列表/代码块等：递归处理（缩进样式不再叠加）
          out.push(...(await convertBlock(child, ctx)));
        }
      }
      return out;
    }

    case "bullet_list":
    case "ordered_list":
      return convertList(node, ctx, 0);

    case "code_block":
    case "fence": {
      const lines = node.textContent.split("\n");
      return lines.map(
        (line) =>
          new Paragraph({
            shading: { fill: "F5F5F5" },
            spacing: { before: 0, after: 0 },
            children: [new TextRun({ text: line || " ", font: "Consolas", size: ctx.code })],
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
          const inner = await convertBlocks(cellNode, ctx);
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

    // 块级数学公式：先尝试转 Word 原生 OMML，失败再降级为栅格图片，再失败为源码
    case "math_block": {
      const tex = sourceOf(node);
      const omml = await latexToOmml(tex, true);
      if (omml) {
        const token = nextToken(ctx);
        ctx.placeholders.push({ token, omml });
        return [
          new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: token })] }),
        ];
      }
      const img = await formulaToImage(tex, true);
      if (img) return [new Paragraph({ children: [img] })];
      return [sourceParagraph(tex, ctx)];
    }

    // Mermaid 图表：渲染 SVG 后按页面宽度栅格化为 png 内嵌（Word 无原生图表类型）
    case "diagram": {
      const code = sourceOf(node);
      const identity = String((node.attrs ?? {}).identity ?? "");
      const png = await diagramToPng(code, identity, ctx.viewDom);
      if (png) {
        return [
          new Paragraph({
            children: [
              new ImageRun({
                type: "png",
                data: png.data,
                transformation: { width: png.width, height: png.height },
              }),
            ],
          }),
        ];
      }
      return [sourceParagraph(code, ctx)];
    }

    // [toc] 目录节点：Word 无对应节点，改为注入原生 TOC 域
    // （打开时由 Word 自动生成，或右键「更新域」；见 injectOmml）
    case "toc": {
      const token = nextTocToken(ctx);
      ctx.tocPlaceholders.push({ token, xml: buildTocFieldXml(ctx.tocEntries) });
      return [new Paragraph({ children: [new TextRun({ text: token })] })];
    }

    // 块级 HTML：htmlBlock 是 atom 节点（HTML 源码存 attrs.value、无子节点）。
    // 编辑器里由 NodeView 渲染成真实 DOM，所以 PDF（打印 DOM）看得到；但导出 DOCX
    // 时若落到 default 分支「递归子节点」，原子节点没有子节点 → 内容直接丢失。
    case "htmlBlock": {
      const value = String((node.attrs ?? {}).value ?? "");
      return htmlBlockToParagraphs(value);
    }

    default: {
      if (node.isTextblock) {
        return [
          new Paragraph({
            // 段落里嵌着 <center> 的行内 HTML 时整段居中
            alignment: paragraphAlignment(node),
            children: await convertInline(node, ctx),
          }),
        ];
      }
      // 未知容器节点：递归展开其内容
      return convertBlocks(node, ctx);
    }
  }
}

/* ============ 块级 HTML（htmlBlock 节点）→ Word 段落 ============ */

/** 会另起一段的块级标签（<center> 单独处理：它只影响对齐，不额外分段） */
const HTML_BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "ASIDE", "MAIN", "HEADER", "FOOTER", "NAV",
  "H1", "H2", "H3", "H4", "H5", "H6", "LI", "UL", "OL", "TR", "TABLE",
  "BLOCKQUOTE", "PRE", "FIGURE", "FIGCAPTION", "ADDRESS", "DETAILS", "SUMMARY",
  "HR", "DL", "DT", "DD", "FIELDSET", "FORM",
]);

/** 段落对齐（docx 以「枚举成员值」作为该属性的类型） */
type HtmlAlign = (typeof AlignmentType)[keyof typeof AlignmentType] | undefined;

/** 行内样式的累积状态 */
type HtmlMark = {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  code?: boolean;
};

/** HtmlMark → TextRun 样式选项 */
function htmlMarkOptions(m: HtmlMark): TextRunOptions {
  return {
    bold: m.b || undefined,
    italics: m.i || undefined,
    underline: m.u ? {} : undefined,
    strike: m.s || undefined,
    font: m.code ? "Consolas" : undefined,
  };
}

/** 行内内容 → docx 内联元素（处理文本、<br>、行内样式标签、<a> 外链） */
function htmlInlineChildren(node: Node, m: HtmlMark): InlineChild[] {
  const out: InlineChild[] = [];
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      // 源码里的换行与缩进压成单个空格（与浏览器渲染一致）
      const text = (child.textContent ?? "").replace(/\s+/g, " ");
      if (!text.trim()) return;
      out.push(new TextRun({ text, ...htmlMarkOptions(m) }));
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const el = child as Element;
    const tag = el.tagName.toUpperCase();
    if (tag === "BR") {
      out.push(new TextRun({ text: "", break: 1, ...htmlMarkOptions(m) }));
      return;
    }
    if (tag === "IMG") return; // 图片由 image 节点承载，这里忽略
    // 行内位置出现块级元素：仍把其文本收进来（是否分段由上层决定）
    if (tag === "CENTER" || HTML_BLOCK_TAGS.has(tag)) {
      out.push(...htmlInlineChildren(el, m));
      return;
    }
    const next: HtmlMark = { ...m };
    if (tag === "B" || tag === "STRONG") next.b = true;
    else if (tag === "I" || tag === "EM") next.i = true;
    else if (tag === "U" || tag === "INS") next.u = true;
    else if (tag === "S" || tag === "DEL" || tag === "STRIKE") next.s = true;
    else if (tag === "CODE" || tag === "KBD" || tag === "SAMP") next.code = true;
    if (tag === "A") {
      const href = el.getAttribute("href");
      if (href) {
        const inner = htmlInlineChildren(el, next).filter(
          (c): c is TextRun => c instanceof TextRun
        );
        if (inner.length) {
          out.push(new ExternalHyperlink({ link: href, children: inner }));
          return;
        }
      }
    }
    out.push(...htmlInlineChildren(el, next));
  });
  return out;
}

/**
 * 块级 HTML 源码 → Word 段落数组。
 *
 * 背景：htmlBlock 是 atom 节点（HTML 源码存 attrs.value、无子节点）。编辑器里由
 * NodeView 渲染成真实 DOM，所以 PDF（打印 DOM）看得到；而 DOCX 是遍历 ProseMirror
 * 文档树生成的，此前没有该分支 → 落到 default「递归子节点」→ 原子节点无子节点 →
 * 内容丢失（这正是「PDF 能看到、Word 里文字不见了」的原因）。
 *
 * 支持：块级标签分段、<br> 软换行、b/strong/i/em/u/s/del/code、<a> 外链、<center> 居中。
 */
function htmlBlockToParagraphs(html: string): Paragraph[] {
  if (!html || !html.trim()) return [];
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const out: Paragraph[] = [];

  const walk = (parent: Node, align: HtmlAlign) => {
    let pending: InlineChild[] = [];
    const flush = () => {
      if (pending.length > 0) {
        out.push(new Paragraph({ alignment: align, children: pending }));
        pending = [];
      }
    };
    parent.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text) pending.push(new TextRun({ text }));
        return;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const el = child as Element;
      const tag = el.tagName.toUpperCase();
      // <center>：内部段落整体居中（Word 里用段落对齐实现）
      if (tag === "CENTER") {
        flush();
        walk(el, AlignmentType.CENTER);
        return;
      }
      if (HTML_BLOCK_TAGS.has(tag)) {
        flush();
        walk(el, align);
        flush();
        return;
      }
      pending.push(...htmlInlineChildren(el, {}));
    });
    flush();
  };

  walk(parsed.body, undefined);
  return out;
}

/**
 * HTML 片段 → docx 内联元素（行内 html 节点用）。
 * 块级 HTML 请走 htmlBlockToParagraphs；这里只取行内内容（文本 + 行内样式）。
 */
function htmlFragmentToInline(html: string): InlineChild[] {
  if (!html || !html.trim()) return [];
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return htmlInlineChildren(parsed.body, {});
}

/**
 * 段落对齐：内容中含 <center>… 的行内 HTML 节点时整段居中。
 * 块级 <center> 本应由 htmlBlock 分支处理并居中；若被内置行内 html schema
 * 抢先匹配而落进 paragraph，则靠这里补齐「居中」语义，不至于丢失。
 */
function paragraphAlignment(node: PMNode): HtmlAlign {
  let centered = false;
  node.descendants((child) => {
    if (
      child.type.name === "html" &&
      /<center[\s>]/i.test(String((child.attrs ?? {}).value ?? ""))
    ) {
      centered = true;
      return false;
    }
    return !centered;
  });
  return centered ? AlignmentType.CENTER : undefined;
}

/** 列表缩进单位（twips，0.25"）；嵌套层级按 depth 累加 */
const LIST_INDENT = 360;

/** 无序列表按层级使用不同项目符号 */
function bulletMarker(depth: number): string {
  return ["• ", "◦ ", "▪ "][depth % 3];
}

/** 有序列表按层级使用不同编号样式（阿拉伯/字母/罗马） */
function orderedMarker(index: number, depth: number): string {
  if (depth % 3 === 1) return `${String.fromCharCode(97 + (index % 26))}. `;
  if (depth % 3 === 2) return `${toRoman(index + 1)}. `;
  return `${index + 1}. `;
}

/** 整数转罗马数字（用于深层有序列表编号） */
function toRoman(n: number): string {
  const map: [number, string][] = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
    [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let r = "";
  for (const [v, s] of map) {
    while (n >= v) {
      r += s;
      n -= v;
    }
  }
  return r;
}

/**
 * 递归处理列表（支持任意层级嵌套、任务列表）。
 * - 无序：按层级换项目符号；有序：按层级换编号样式。
 * - 任务列表在本编辑器里是带 checked 属性的 list_item，渲染为 [x] / [ ] 前缀。
 * - 缩进按 depth 累加，保留层级结构。
 */
async function convertList(parent: PMNode, ctx: ExportContext, depth: number): Promise<BlockChild[]> {
  const ordered = parent.type.name === "ordered_list";
  const out: BlockChild[] = [];
  for (let i = 0; i < parent.childCount; i += 1) {
    const item = parent.child(i);
    if (item.type.name !== "list_item") {
      out.push(...(await convertBlock(item, ctx)));
      continue;
    }
    const checked = (item.attrs ?? {}).checked;
    const isTask = checked === true || checked === false;
    const marker = isTask
      ? checked
        ? "[x] "
        : "[ ] "
      : ordered
        ? orderedMarker(i, depth)
        : bulletMarker(depth);
    for (let j = 0; j < item.childCount; j += 1) {
      const child = item.child(j);
      if (child.type.name === "paragraph") {
        out.push(
          new Paragraph({
            indent: { left: LIST_INDENT * (depth + 1), hanging: LIST_INDENT },
            children: [
              new TextRun({ text: marker, font: "Consolas" }),
              ...(await convertInline(child, ctx)),
            ],
          })
        );
      } else if (child.type.name === "bullet_list" || child.type.name === "ordered_list") {
        out.push(...(await convertList(child, ctx, depth + 1)));
      } else {
        out.push(...(await convertBlock(child, ctx)));
      }
    }
  }
  return out;
}

/* ============ 内联节点 ============ */

async function convertInline(parent: PMNode, ctx: ExportContext): Promise<InlineChild[]> {
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
      case "math_inline": {
        const tex = sourceOf(child);
        const omml = await latexToOmml(tex, false);
        if (omml) {
          const token = nextToken(ctx);
          ctx.placeholders.push({ token, omml });
          out.push(new TextRun({ text: token }));
          break;
        }
        const img = await formulaToImage(tex, false);
        if (img) {
          out.push(img);
          break;
        }
        out.push(new TextRun({ text: `$${tex}$`, font: "Consolas", color: "666666" }));
        break;
      }
      case "image": {
        const embedded = await embedImage(String(child.attrs.src ?? ""));
        if (embedded) out.push(embedded);
        break;
      }
      // 行内 HTML 节点（milkdown 内置 html schema，源码存 attrs.value）。
      // 与 htmlBlock 同理：原子节点无子节点，不专门处理就会丢失其中的文字。
      // 实测 <center>…</center> 独立成行时若被内置行内 schema 抢先匹配，
      // 会被包进 paragraph 里变成这种节点，正是「Word 里字不见」的另一条路径。
      case "html": {
        out.push(...htmlFragmentToInline(String((child.attrs ?? {}).value ?? "")));
        break;
      }
      default:
        // 未知内联节点（含加粗/斜体等 mark 容器）：递归展开
        out.push(...(await convertInline(child, ctx)));
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
      case "strike_through":
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

/* ============ 公式：LaTeX -> OMML ============ */

/** KaTeX 渲染 LaTeX 为 MathML，再转 OMML；失败返回 null */
async function latexToOmml(tex: string, displayMode: boolean): Promise<string | null> {
  try {
    if (!tex || !tex.trim()) return null;
    let mathml = katex.renderToString(tex, {
      displayMode,
      output: "mathml",
      throwOnError: false,
    });
    // 摘出 <math>…</math>，去掉 TeX 源码 annotation，避免无关告警
    const m = mathml.match(/<math[\s\S]*<\/math>/);
    if (m) mathml = m[0].replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/g, "");
    let omml = mml2omml(mathml);
    if (!omml || !omml.includes("<m:")) return null;
    if (displayMode) omml = `<m:oMathPara>${omml}</m:oMathPara>`;
    return omml;
  } catch (err) {
    console.warn("[NoteMark] latex->OMML failed:", tex, err);
    return null;
  }
}

/** 公式降级为栅格图片（KaTeX HTML 经 foreignObject 栅格化） */
async function formulaToImage(tex: string, displayMode: boolean): Promise<ImageRun | null> {
  try {
    const html = katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      output: "htmlAndMathml",
    });
    const png = await htmlToPng(html);
    if (!png) return null;
    return new ImageRun({
      type: "png",
      data: png.data,
      transformation: { width: png.width, height: png.height },
    });
  } catch (err) {
    console.warn("[NoteMark] formula->image failed:", tex, err);
    return null;
  }
}

/* ============ 栅格化（SVG / HTML -> PNG） ============ */

/**
 * 把 SVG 字符串栅格化为 PNG。
 * @param maxWidth 期望的最大显示宽度（像素）；不传则按 SVG 原始尺寸。
 * @param maxHeight 期望的最大显示高度（像素）；不传则不限制高度。
 *   采用等比 contain 缩放（同 CSS 的 max-* 语义，只缩不放）：以 SVG 原始尺寸为基准，
 *   仅在超出 maxWidth / maxHeight 时按比例缩小；小图保持原始大小不被拉伸放大。
 *   并以 devicePixelRatio 提升栅格清晰度（缩放后更锐利）。
 */
async function svgToPng(
  svg: string,
  maxWidth?: number,
  maxHeight?: number
): Promise<{ data: Uint8Array; width: number; height: number } | null> {
  try {
    const size = parseSvgSize(svg);
    // 与浏览器 CSS 的 `max-width:100%; height:auto` 语义保持一致：
    // max* 只是上限——只在超出页面内容区时等比缩小，**绝不把小图放大**。
    // （此前是一律拉到 maxWidth，等于放大，故图表比 PDF/网页里偏大。）
    const w0 = size.w > 0 ? size.w : (maxWidth ?? 480);
    const h0 = size.h > 0 ? size.h : (maxHeight ?? 320);
    const fit = Math.min(
      1, // 永不放大
      maxWidth && maxWidth > 0 ? maxWidth / w0 : 1,
      maxHeight && maxHeight > 0 ? maxHeight / h0 : 1
    );
    const wLogical = Math.max(1, Math.round(w0 * fit));
    const hLogical = Math.max(1, Math.round(h0 * fit));
    const scale = Math.min(3, Math.max(2, window.devicePixelRatio || 2));
    const w = Math.max(1, Math.round(wLogical * scale));
    const h = Math.max(1, Math.round(hLogical * scale));
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext("2d");
    if (!c) return null;
    c.drawImage(img, 0, 0, w, h);
    const blob = await canvasToPng(canvas);
    if (!blob) return null;
    return { data: new Uint8Array(await blob.arrayBuffer()), width: wLogical, height: hLogical };
  } catch (err) {
    console.warn("[NoteMark] svg->png failed:", err);
    return null;
  }
}

/** 把 KaTeX HTML 经 foreignObject 栅格化为 PNG（用于公式图片兜底） */
async function htmlToPng(
  html: string
): Promise<{ data: Uint8Array; width: number; height: number } | null> {
  let host: HTMLDivElement | null = null;
  try {
    host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "-99999px";
    host.style.top = "0";
    host.style.padding = "2px";
    host.style.background = "transparent";
    host.style.color = "#000";
    host.style.fontSize = "16px";
    host.innerHTML = `<style>${katexExportCss}</style>${html}`;
    document.body.appendChild(host);
    const rect = host.getBoundingClientRect();
    const w = Math.max(1, Math.ceil(rect.width));
    const h = Math.max(1, Math.ceil(rect.height));
    const scale = Math.min(3, Math.max(2, window.devicePixelRatio || 2));
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<foreignObject width="100%" height="100%">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="color:#000;background:transparent;">` +
      `<style>${katexExportCss}</style>${html}</div>` +
      `</foreignObject></svg>`;
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = w * scale;
    canvas.height = h * scale;
    const c = canvas.getContext("2d");
    if (!c) return null;
    c.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToPng(canvas);
    if (!blob) return null;
    return { data: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
  } catch (err) {
    console.warn("[NoteMark] html->png failed:", err);
    return null;
  } finally {
    host?.remove();
  }
}

/** 解析 SVG 的固有尺寸（优先 width/height，回退 viewBox） */
function parseSvgSize(svg: string): { w: number; h: number } {
  const tag = svg.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const num = (s: string) => parseFloat(s);
  /**
   * 取 width/height 属性值。
   * 百分比要视为「未知」——Mermaid 常输出 width="100%"，若按 100 参与计算，
   * 配合同样为百分比的 height 会算成 100×100（比例 1:1），比例彻底错掉。
   * 百分比无法直接当尺寸用，交给下面的 viewBox 兜底。
   */
  const attr = (name: string): number => {
    const m = tag.match(
      new RegExp(`\\b${name}\\s*=\\s*["']?\\s*([\\d.]+)\\s*(px|pt|em|rem|%)?`, "i")
    );
    if (!m) return NaN;
    if (m[2] === "%") return NaN;
    return num(m[1]);
  };
  const w = attr("width");
  const h = attr("height");
  if (w > 0 && h > 0) return { w, h };
  const vb = tag.match(
    /\bviewBox\s*=\s*["']?\s*[\d.+-]+\s+[\d.+-]+\s+([\d.]+)\s+([\d.]+)/i
  );
  if (vb) return { w: num(vb[1]), h: num(vb[2]) };
  return { w: 480, h: 320 };
}

/* ============ 图片内嵌 ============ */

/** 读取图片字节与格式（支持 data URL 与 http/asset/blob 等可 fetch 的 URL） */
async function loadImageBytes(
  src: string
): Promise<{ type: ImageType; data: Uint8Array; mime: string } | null> {
  const dataMatch = src.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (dataMatch) {
    const mime = dataMatch[1].toLowerCase();
    const isB64 = !!dataMatch[2];
    const payload = dataMatch[3];
    let bytes: Uint8Array;
    try {
      bytes = isB64 ? b64ToBytes(payload) : new TextEncoder().encode(decodeURIComponent(payload));
    } catch {
      return null;
    }
    const type = mimeToType(mime);
    if (!type) return null;
    return { type, data: bytes, mime };
  }
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") || "").split(";")[0].toLowerCase();
    const type = mimeToType(mime) ?? mimeFromExt(src);
    if (!type) return null;
    const buf = await res.arrayBuffer();
    return { type, data: new Uint8Array(buf), mime };
  } catch (err) {
    console.warn("[NoteMark] load image failed:", src, err);
    return null;
  }
}

/** 内嵌图片到 docx：位图直接内嵌，svg 先栅格化为 png，失败返回 null */
async function embedImage(src: string): Promise<ImageRun | null> {
  if (!src) return null;
  const loaded = await loadImageBytes(src);
  if (!loaded) return null;
  const { type, data, mime } = loaded;

  if (type === "svg") {
    const decoded = new TextDecoder().decode(data);
    const target = Math.min(parseSvgSize(decoded).w, MAX_IMAGE_WIDTH);
    const png = await svgToPng(decoded, target, MAX_FIGURE_HEIGHT_PX);
    if (!png) return null;
    return new ImageRun({
      type: "png",
      data: png.data,
      transformation: { width: png.width, height: png.height },
    });
  }

  const size = await imageSizeFromBytes(data, mime);
  let width = size?.w ? Math.min(size.w, MAX_IMAGE_WIDTH) : MAX_IMAGE_WIDTH;
  let height = size?.w ? Math.round((size.h * width) / size.w) : 320;
  // 竖图按高度回缩，保证不超出一页内容区
  if (size?.h && height > MAX_FIGURE_HEIGHT_PX) {
    height = MAX_FIGURE_HEIGHT_PX;
    width = Math.max(1, Math.round((MAX_FIGURE_HEIGHT_PX * size.w) / size.h));
  }
  return new ImageRun({
    type,
    data,
    transformation: { width, height: height || 320 },
  });
}

/* ============ Mermaid 渲染 ============ */

/** 用 mermaid 把图表代码渲染为 SVG 字符串 */
/**
 * 取编辑器 DOM 中该图表**已渲染好**的 SVG（借鉴 PDF 导出的做法）。
 *
 * PDF 导出直接打印编辑器 DOM 里的 <svg>，所以与屏幕所见完全一致；DOCX 此前是
 * 从源码重新 mermaid.render() 一遍，配置（主题/字体/曲线/间距）可能与编辑器不同，
 * 导致外观与尺寸出现差异。这里优先复用 DOM 中现成的 SVG 以消除该差异。
 *
 * 深色主题下不复用：Word 页面是白底，而深色图是「浅色文字 + 透明背景」，
 * 放到白底上会看不清。此时返回 null，交由 renderMermaid 用浅色主题重渲染。
 */
function pickRenderedSvg(
  identity: string,
  viewDom: HTMLElement | null
): string | null {
  if (!viewDom || !identity) return null;
  if (document.documentElement.dataset.theme === "dark") return null;
  let el: SVGSVGElement | null = null;
  try {
    el = viewDom.querySelector<SVGSVGElement>(
      `.diagram[data-diagram-id="${CSS.escape(identity)}"] svg`
    );
  } catch {
    return null;
  }
  if (!el) return null;
  // 序列化时把 CSS 变量驱动的前景色内联进 style：脱离页面 CSS 后颜色仍然正确
  let svg: string;
  try {
    const clone = el.cloneNode(true) as SVGSVGElement;
    const color = getComputedStyle(el).color;
    if (color) clone.style.color = color;
    svg = clone.outerHTML;
  } catch {
    svg = el.outerHTML;
  }
  // foreignObject 在 <img> 中被沙箱化，通常渲染不出来（主题开启
  // --mermaid-flowchart-html-labels 时会出现）。此时放弃复用，改由
  // renderMermaid（固定 htmlLabels:false）输出纯 SVG 文本节点，保证可栅格化。
  if (/<foreignObject[\s>]/i.test(svg)) return null;
  return svg;
}

/**
 * 生成 Mermaid 图表的 PNG。
 * 优先复用编辑器已渲染好的 SVG，取不到（深色主题 / 未渲染 / 导出环境无 DOM）时
 * 回退到浅色主题重新渲染。尺寸仍按 SVG 自身尺寸（viewBox）配合页面内容区缩放。
 */
async function diagramToPng(
  code: string,
  identity: string,
  viewDom: HTMLElement | null
): Promise<{ data: Uint8Array; width: number; height: number } | null> {
  const svg = pickRenderedSvg(identity, viewDom) ?? (await renderMermaid(code));
  if (!svg) return null;
  return svgToPng(svg, MERMAID_WIDTH_PX, MAX_FIGURE_HEIGHT_PX);
}

/** 兜底：从源码渲染 Mermaid（浅色主题，适配 Word 白底页面） */
async function renderMermaid(code: string): Promise<string | null> {
  if (!code || !code.trim()) return null;
  try {
    const mod = await import("mermaid");
    const mermaid = (mod.default ?? mod) as typeof import("mermaid")["default"];
    mermaid.initialize({
      startOnLoad: false,
      // Word 页面是白底，统一用浅色主题：深色主题是浅色文字 + 透明背景，白底上看不清
      theme: "default",
      flowchart: { htmlLabels: false },
    });
    const id = `docx-mermaid-${Math.random().toString(36).slice(2)}`;
    const { svg } = await mermaid.render(id, code);
    return svg;
  } catch (err) {
    console.warn("[NoteMark] mermaid render failed:", err);
    return null;
  }
}

/* ============ OMML 注入（docx zip 改写） ============ */

/* ============ 注入（docx zip 改写：公式 OMML / 目录 TOC 域 / 自动更新域） ============ */

/** 把公式占位 run 替换为 OMML、目录占位段替换为 TOC 域，并声明所需命名空间/更新域 */
async function injectOmml(
  buffer: ArrayBuffer,
  placeholders: { token: string; omml: string }[],
  tocPlaceholders: { token: string; xml: string }[]
): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file("word/document.xml");
  if (!file) return buffer;
  let xml = await file.async("string");

  // 公式占位 run -> OMML（token 之前禁止跨越 </w:r>，避免误删前文）
  for (const { token, omml } of placeholders) {
    const re = new RegExp(
      `<w:r\\b[^>]*>(?:(?!</w:r>).)*?${escapeRegExp(token)}.*?</w:r>`,
      "s"
    );
    xml = xml.replace(re, omml);
  }

  // 目录占位段 -> TOC 域（整段替换，token 之前禁止跨越 </w:p>）
  for (const { token, xml: toc } of tocPlaceholders) {
    const re = new RegExp(
      `<w:p\\b[^>]*>(?:(?!</w:p>).)*?${escapeRegExp(token)}.*?</w:p>`,
      "s"
    );
    xml = xml.replace(re, toc);
  }

  if (!/xmlns:m=/.test(xml)) {
    xml = xml.replace(/<w:document\b/, `<w:document xmlns:m="${OMML_NS}"`);
  }
  zip.file("word/document.xml", xml);

  // 不自动更新域（updateFields=false）：与 Word 自带目录完全一致——打开时不会弹出
  // 「本文档包含的域可能引用其他文件」警告；目录结果已用标准 TOC N 样式烘焙进文件，
  // 打开即正确显示，右键「更新域」/F9 可刷新为精确页码（此时 \h 超链接生效，可点击跳转）。
  const settingsFile = zip.file("word/settings.xml");
  if (settingsFile) {
    let settings = await settingsFile.async("string");
    if (/updateFields/.test(settings)) {
      // 强制确保为 false：无论库默认是否带该标记，都关闭自动更新域（避免打开警告）
      settings = settings.replace(
        /<w:updateFields\b[^>]*\/?>/g,
        `<w:updateFields w:val="false"/>`
      );
    } else {
      settings = settings.replace(
        /(<w:settings\b[^>]*>)/,
        `$1<w:updateFields w:val="false"/>`
      );
    }
    zip.file("word/settings.xml", settings);
  }

  return zip.generateAsync({ type: "arraybuffer" });
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

/** 生成下一个公式占位令牌（带尾分隔符，避免 OMMLPH0 被 OMMLPH10 前缀误匹配） */
function nextToken(ctx: ExportContext): string {
  return `${OMML_TOKEN_PREFIX}_${ctx.placeholders.length}_`;
}

/** 公式/图表渲染失败时的源码占位段落 */
function sourceParagraph(tex: string, ctx: ExportContext): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: tex, font: "Consolas", color: "666666", size: ctx.code }),
    ],
  });
}

/** 生成下一个目录占位令牌 */
function nextTocToken(ctx: ExportContext): string {
  return `${TOC_TOKEN_PREFIX}_${ctx.tocPlaceholders.length}_`;
}

/** 估算单个块级节点的渲染高度（twips），用于推算标题所在页 */
function estimateNodeHeight(node: PMNode): number {
  const name = node.type.name;
  if (name === "heading") {
    const lvl = Math.min(Math.max(Number(node.attrs.level) || 1, 1), 6);
    const fontSizePt = [16, 14, 13, 12, 11, 11][lvl - 1] || 11;
    const lines = Math.max(1, Math.ceil((node.textContent || "").length / 50));
    return lines * Math.round(fontSizePt * 1.2 * 20) + 300;
  }
  if (node.isTextblock) {
    const lines = Math.max(1, Math.ceil((node.textContent || "").length / 60));
    return lines * 288 + 120;
  }
  if (name === "code_block" || name === "fence") {
    const lines = Math.max(1, (node.textContent || "").split("\n").length);
    return lines * 241;
  }
  if (name === "image") return 3000;
  if (name === "diagram") return 4200;
  if (name === "math_block") return 600;
  if (name === "hr" || name === "horizontal_rule") return 120;
  if (name === "table") return Math.max(1, node.childCount) * 400;
  return 0;
}

/** 预扫描整篇文档，收集标题（顺序与正文一致）并估算其所在页码，供预填 TOC 结果 */
function collectToc(doc: PMNode, ctx: ExportContext): void {
  let total = 0;
  const walk = (node: PMNode) => {
    const name = node.type.name;
    if (name === "toc") return;
    if (name === "heading") {
      const page = Math.floor(total / PAGE_CONTENT_H) + 1;
      const lvl = Math.min(Math.max(Number(node.attrs.level) || 1, 1), 6);
      ctx.tocEntries.push({ level: lvl, text: (node.textContent || "").trim(), page });
    }
    total += estimateNodeHeight(node);
    if (
      name === "heading" ||
      node.isTextblock ||
      name === "code_block" ||
      name === "fence" ||
      name === "image" ||
      name === "diagram" ||
      name === "math_block" ||
      name === "hr" ||
      name === "horizontal_rule" ||
      name === "table"
    ) {
      return; // 叶子块：不再递归
    }
    for (let i = 0; i < node.childCount; i += 1) walk(node.child(i));
  };
  walk(doc);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 构造 Word 原生 TOC 域（按标题大纲 1-6 级生成目录，含超链接）。
 * 与 Word 自带目录完全一致的做法：updateFields=false（打开不自动更新域，故不会弹出
 * 「本文档包含的域可能引用其他文件」警告），同时把目录结果用标准 TOC N 样式烘焙进文件，
 * 打开即正确显示；右键「更新域」/F9 可刷新为精确页码（此时超链接 \h 生效，可点击跳转）。
 *
 * 注意：TOC 域结果含多段，字段必须跨多段——begin/separate 在首段、end 在末段，
 * 条目段落与字段段落平级（不能把 <w:p> 嵌套进 <w:p>，否则 Word 拒读）。
 */
function buildTocFieldXml(entries: TocEntry[]): string {
  const entryRuns = (e: TocEntry) => {
    const pad = "  ".repeat(e.level - 1);
    const text = escapeXml(`${pad}${e.text || "(无标题)"}`);
    return (
      `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>` +
      `<w:r><w:tab/></w:r>` +
      `<w:r><w:t>${e.page}</w:t></w:r>`
    );
  };
  const pPr = (style: string) =>
    `<w:pPr><w:pStyle w:val="${style}"/><w:tabs><w:tab w:val="right" w:pos="${PAGE_CONTENT_W}" w:leader="dot"/></w:tabs></w:pPr>`;
  const headStyle = entries.length ? `TOC${entries[0].level}` : "TOC1";
  const head =
    `<w:p>${pPr(headStyle)}` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve"> TOC \\o "1-6" \\h \\z \\u </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
    (entries.length
      ? entryRuns(entries[0])
      : `<w:r><w:t xml:space="preserve">（右键「更新域」生成目录）</w:t></w:r>`) +
    `</w:p>`;
  const middle = entries
    .slice(1)
    .map((e) => `<w:p>${pPr(`TOC${e.level}`)}${entryRuns(e)}</w:p>`)
    .join("");
  const tail = `<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  return head + middle + tail;
}

/** MIME -> 图片类型（含需转换的 svg） */
function mimeToType(mime: string): ImageType | null {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/bmp":
      return "bmp";
    case "image/svg+xml":
      return "svg";
    default:
      return null;
  }
}

/** 按扩展名推断图片类型（fetch 拿不到 content-type 时的兜底） */
function mimeFromExt(src: string): ImageType | null {
  const clean = src.split("?")[0].split("#")[0];
  const ext = clean.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "png";
    case "jpg":
    case "jpeg":
      return "jpg";
    case "gif":
      return "gif";
    case "bmp":
      return "bmp";
    case "svg":
      return "svg";
    default:
      return null;
  }
}

/** base64 -> 字节 */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** 从图片字节读取原始尺寸 */
function imageSizeFromBytes(data: Uint8Array, mime: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: mime }));
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

/** 加载图片（Promise 化） */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}

/** canvas -> PNG Blob */
function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}

/** 转义正则特殊字符 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
