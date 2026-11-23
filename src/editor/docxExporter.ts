/*
 * docxExporter.ts — 把 ProseMirror 文档导出为 Word（.docx）
 *
 * 实现思路：直接遍历 ProseMirror 文档树生成 OOXML，而不是从 HTML 转换。
 * 这样能利用文档的语义结构（标题层级、列表、表格、引用、代码块），
 * 比「HTML 套 .doc 扩展名」的方式结构正确、且是真正的 .docx。
 *
 * 各类富内容的处理方式：
 * - 代码块：保留文本与等宽字体、灰底，不保留语法高亮配色
 * - 图片：按文件头（magic bytes）识别真实格式，png/jpg/gif/bmp 直接内嵌，
 *   svg 与 webp / avif 先栅格化成 png；远程图需要真能 fetch 到字节（被跨域
 *   策略挡住时降级为占位）；大图等比缩到内容区宽（顶到页边距），小图保持原尺寸
 * - 公式（行内/块级）：MathJax → MathML → OMML，作为 Word 原生公式注入
 *   （可在 Word 里继续编辑，与 Typora 导出一致）；只有转换失败时降级为
 *   栅格化图片，再失败则退化为源码文本
 * - Mermaid 图表：SVG 矢量图内嵌，同时生成 PNG 兼容旧版 Word
 * - 嵌套表格：内层内容以段落呈现（Word 单元格内嵌表格结构复杂）
 * - task list 的勾选框导出为 Word 2010+ 原生复选框内容控件
 *
 * OMML 注入说明：docx 库不支持公式，故对公式节点先放一个唯一占位
 * TextRun，生成 docx 后用 JSZip 改写 word/document.xml，把占位 run
 * 替换为 <m:oMath>/<m:oMathPara>，并在 <w:document> 上声明 m 命名空间。
 */

import JSZip from "jszip";
import { renderMathJaxSvg, texToMathMl } from "./mathjax";
import { mathMlToOmml } from "./mathml-to-omml";
import { resolveImageSrc } from "./image-view";
import {
  DEFAULT_MERMAID_EXPORT_BACKGROUND,
  normalizeMermaidSvgForExport,
  resolveMermaidExportBackground,
} from "./mermaid-export";
import { isMermaidLanguage } from "./mermaid-language";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  FootnoteReferenceRun,
  HeadingLevel,
  ImageRun,
  LineRuleType,
  Packer,
  Paragraph,
  Tab,
  TabStopType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
} from "docx";
import type { IParagraphOptions, IRunOptions } from "docx";
import type { Node as PMNode, Mark as PMMark } from "@milkdown/kit/prose/model";

/** 段落级元素（Document 的 children） */
type BlockChild = Paragraph | Table;
type ParagraphSpacing = NonNullable<IParagraphOptions["spacing"]>;
type BlockConversionOptions = {
  quoteDepth?: number;
};
/** 段落内联元素 */
type InlineChild =
  | TextRun
  | ExternalHyperlink
  | ImageRun
  | FootnoteReferenceRun;
/** TextRun 构造参数类型（docx 导出该类型；TextRun 本身还接受 string 参数） */
type TextRunOptions = IRunOptions;

/** 可内嵌的位图类型；svg 先栅格化，不在此列 */
type RasterType = "png" | "jpg" | "gif" | "bmp";
/** 图片原始格式（含需转换的 svg、需转 png 后内嵌的 webp / avif） */
type ImageType = RasterType | "svg" | "webp" | "avif";

/** Word 导出使用固定的跨平台字体组合；中文和西文分别声明。 */
const BODY_FONTS = {
  ascii: "Calibri",
  hAnsi: "Calibri",
  eastAsia: "等线",
  cs: "Calibri",
} as const;
const CODE_FONTS = {
  ascii: "Consolas",
  hAnsi: "Consolas",
  eastAsia: "等线",
  cs: "Consolas",
} as const;
/** 自定义 Pandoc reference 中定义列表术语使用黑体。 */
const DEFINITION_TERM_FONTS = {
  ...BODY_FONTS,
  eastAsia: "黑体",
} as const;
/** 自定义 Pandoc reference 中摘要正文使用仿宋。 */
const ABSTRACT_FONTS = {
  ...BODY_FONTS,
  eastAsia: "仿宋",
} as const;

/** 文档默认段落参数；正文段落由独立的 BodyText 样式覆盖。 */
const BODY_SPACING = {
  before: 0,
  after: 120,
  line: 360,
  lineRule: LineRuleType.AUTO,
} as const;
/** Pandoc Body Text：段前段后各 9pt，单倍行距。 */
const PANDOC_BODY_SPACING = {
  before: 180,
  after: 180,
  line: 240,
  lineRule: LineRuleType.AUTO,
} as const;
/** Pandoc Compact 样式：段前段后各 36 twips，单倍行距。 */
const TABLE_CELL_SPACING = {
  before: 36,
  after: 36,
  line: 240,
  lineRule: LineRuleType.AUTO,
} as const;
/** Pandoc Block Text：段前段后各 5pt，单倍行距。 */
const BLOCK_TEXT_SPACING = {
  before: 100,
  after: 100,
  line: 240,
  lineRule: LineRuleType.AUTO,
} as const;
/**
 * Pandoc Footnote Text：基于 Normal，段前 0、段后 200 twips、单倍行距。
 * 200 twips 来自 Pandoc 参考文档的 docDefaults（10pt 段后距）。
 */
const PANDOC_FOOTNOTE_TEXT_SPACING = {
  before: 0,
  after: 200,
  line: 240,
  lineRule: LineRuleType.AUTO,
} as const;
/** Pandoc Footnote Block Text：段前段后各 100 twips。 */
const PANDOC_FOOTNOTE_BLOCK_SPACING = {
  before: 100,
  after: 100,
  line: 240,
  lineRule: LineRuleType.AUTO,
} as const;
/** Pandoc 参考文档中 Footnote Block Text 的左右缩进，OOXML 固定单位为 twips。 */
const PANDOC_FOOTNOTE_BLOCK_INDENT_TWIPS = 480;
const FOOTNOTE_TEXT_STYLE = "FootnoteText";
const FOOTNOTE_BLOCK_TEXT_STYLE = "FootnoteBlockText";
const CAPTION_STYLE = "Caption";
const IMAGE_CAPTION_STYLE = "ImageCaption";
const TABLE_CAPTION_STYLE = "TableCaption";
const FIGURE_STYLE = "Figure";
const CAPTIONED_FIGURE_STYLE = "CaptionedFigure";
const DEFINITION_TERM_STYLE = "DefinitionTerm";
const DEFINITION_STYLE = "Definition";
/** 自定义 reference 中 Hyperlink 的主题强调色。 */
const HYPERLINK_COLOR = "156082";
/** OOXML 图片对象必须提供内部名称；Word/Pandoc 使用 Picture。 */
const IMAGE_DOC_PROPERTIES_NAME = "Picture";
/** Word 保留 0 和 -1 给分隔线脚注，正文脚注从 1 开始。 */
const FIRST_FOOTNOTE_ID = 1;
const DEFAULT_ABSTRACT_TITLE = "Abstract";
/** OOXML twips per typographic point. */
const TWIPS_PER_POINT = 20;
/** OOXML stores font sizes in half-points. */
const HALF_POINTS_PER_POINT = 2;
/**
 * Word 内置表格样式的默认左右单元格留白。
 * OOXML 固定使用 twips；108 twips = 0.1905 cm。
 */
const WORD_TABLE_CELL_SIDE_PADDING_TWIPS = 108;
/** OOXML border widths use eighths of a point. */
const BORDER_UNITS_PER_POINT = 8;
/** Code-block border spacing, in points. */
const CODE_BLOCK_VERTICAL_SPACE_PT = 6;
const CODE_BLOCK_HORIZONTAL_SPACE_PT = 9;
const CODE_BLOCK_BORDER_SIZE = 2;
/** Match border spacing plus the border's own stroke width. */
const CODE_BLOCK_HORIZONTAL_INSET_TWIPS = Math.ceil(
  (CODE_BLOCK_HORIZONTAL_SPACE_PT * TWIPS_PER_POINT +
    (CODE_BLOCK_BORDER_SIZE / BORDER_UNITS_PER_POINT) * TWIPS_PER_POINT) /
    TWIPS_PER_POINT
) * TWIPS_PER_POINT;
/** 与底纹同色的段落边框，用 border-space 形成代码块内边距。 */
const CODE_BLOCK_BORDER = {
  top: {
    style: BorderStyle.SINGLE,
    size: CODE_BLOCK_BORDER_SIZE,
    color: "F5F5F5",
    space: CODE_BLOCK_VERTICAL_SPACE_PT,
  },
  bottom: {
    style: BorderStyle.SINGLE,
    size: CODE_BLOCK_BORDER_SIZE,
    color: "F5F5F5",
    space: CODE_BLOCK_VERTICAL_SPACE_PT,
  },
  left: {
    style: BorderStyle.SINGLE,
    size: CODE_BLOCK_BORDER_SIZE,
    color: "F5F5F5",
    space: CODE_BLOCK_HORIZONTAL_SPACE_PT,
  },
  right: {
    style: BorderStyle.SINGLE,
    size: CODE_BLOCK_BORDER_SIZE,
    color: "F5F5F5",
    space: CODE_BLOCK_HORIZONTAL_SPACE_PT,
  },
} as const;

/** Alert export: type color, left rule, and content indentation in OOXML units. */
const ALERT_EXPORT_STYLES: Record<string, { label: string; color: string }> = {
  note: { label: "NOTE", color: "0969DA" },
  tip: { label: "TIP", color: "1A7F37" },
  important: { label: "IMPORTANT", color: "8250DF" },
  warning: { label: "WARNING", color: "9A6700" },
  caution: { label: "CAUTION", color: "CF222E" },
};
/** Shared 2pt rule for alerts and ordinary blockquotes. */
const QUOTE_RULE_WIDTH = 2 * BORDER_UNITS_PER_POINT;
const ALERT_BORDER_WIDTH = QUOTE_RULE_WIDTH;
const ALERT_BORDER_SPACE_PT = 6;
const ALERT_CONTENT_INDENT_TWIPS = 120;
const BLOCK_TEXT_BORDER_RULE = {
  style: BorderStyle.SINGLE,
  size: QUOTE_RULE_WIDTH,
  color: "BFBFBF",
  space: 8,
} as const;
const BLOCK_TEXT_INDENT_TWIPS = 482;
const QUOTE_LEVEL_INDENT_EM = 1;
/** Alert body paragraphs follow the same 5pt rhythm as blockquotes. */
const ALERT_PARAGRAPH_SPACING = BLOCK_TEXT_SPACING;

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

/**
 * Mermaid 图表宽度（像素）：尽量铺满内容区，仅留少量安全边距避免浮点误差溢出。
 * 内容区 9026 twips ≈ 601px，减 12px 安全边距 → 589px（约 5.6"，左右留白更小）。
 */
const MERMAID_WIDTH_PX = Math.floor((PAGE_CONTENT_W / 1440) * 96) - 12; // ≈ 589

/**
 * 图片最大宽度（像素）：与图表一致，取「内容区宽 - 12px 安全边距」≈ 589px。
 * 大图等比缩到这个宽度，正好顶到页边距；小图保持原尺寸，不放大（避免模糊）。
 */
const MAX_IMAGE_WIDTH = MERMAID_WIDTH_PX;

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
/**
 * Word 图表的 PNG 兼容回退使用独立导出倍率，不依赖屏幕 DPR。
 * 4 倍可覆盖打印缩放，单张图的逻辑尺寸仍保持不变。
 */
const DIAGRAM_EXPORT_RASTER_SCALE = 4;
/** Formula PNGs need explicit print resolution; never depend on screen DPR. */
const FORMULA_EXPORT_RASTER_SCALE = 4;
/** Word body text is 12pt; CSS pixels use 96 DPI. */
const WORD_BODY_FONT_SIZE_PX = 16;
/**
 * MathJax emits SVG dimensions in `ex`. At the Word body font, one ex is
 * approximately 0.45em for the MathJax fonts used by the editor.
 */
const MATHJAX_EX_TO_EM = 0.45;

/** 对齐 Word 手动插表使用的默认单元格内边距；上下为 0，左右为 0.1905 cm。 */
const WORD_TABLE_CELL_MARGINS = {
  marginUnitType: WidthType.DXA,
  top: 0,
  left: WORD_TABLE_CELL_SIDE_PADDING_TWIPS,
  bottom: 0,
  right: WORD_TABLE_CELL_SIDE_PADDING_TWIPS,
} as const;
/** docx exposes percentage widths in whole percent units; 100 = 100%. */
const WORD_TABLE_FULL_WIDTH_PERCENT = 100;
const WORD_TABLE_AUTO_WIDTH = {
  size: 0,
  type: WidthType.AUTO,
} as const;
const WORD_TABLE_FULL_WIDTH = {
  size: WORD_TABLE_FULL_WIDTH_PERCENT,
  type: WidthType.PERCENTAGE,
} as const;

/** Word 数学命名空间（OMML） */
const OMML_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math";
/** Word 2010 扩展命名空间（w14:checkbox） */
const WORD14_NS = "http://schemas.microsoft.com/office/word/2010/wordml";
/** Word 2013 扩展命名空间（w15:appearance） */
const WORD15_NS = "http://schemas.microsoft.com/office/word/2012/wordml";
/** VML horizontal-rule thickness. */
const HORIZONTAL_RULE_HEIGHT = "0.5pt";
/** Legacy VML namespace used by Word for inline vector lines. */
const VML_NS = "urn:schemas-microsoft-com:vml";
/** Office namespace for VML horizontal-rule attributes. */
const OFFICE_NS = "urn:schemas-microsoft-com:office:office";

/** 公式占位 run 的唯一令牌前缀（docx 注入时按此定位并替换） */
const OMML_TOKEN_PREFIX = "OMMLPH";

/** 目录占位段（整段 <w:p>）的唯一令牌前缀 */
const TOC_TOKEN_PREFIX = "TOCPH";
/** Word 复选框占位符的唯一令牌前缀 */
const CHECKBOX_TOKEN_PREFIX = "CHKBOXPH";
/** Horizontal-rule paragraph placeholder prefix. */
const HORIZONTAL_RULE_TOKEN_PREFIX = "HRPH";

/** 导出上下文：固定字号（docx half-points），与编辑器主题解耦 */
type ExportContext = {
  base: number;
  code: number;
  /** 本此导出中所有成功转为 OMML 的公式占位（token -> OMML 片段） */
  placeholders: { token: string; omml: string }[];
  /** 目录节点占位（token -> 整段 TOC 域 XML） */
  tocPlaceholders: { token: string; xml: string }[];
  /** 任务列表复选框占位（token -> checked） */
  checkboxPlaceholders: { token: string; checked: boolean; id: number }[];
  /** Horizontal-rule paragraph placeholders. */
  horizontalRulePlaceholders: { token: string }[];
  /** 编辑器可视 DOM（用于复用已渲染的 Mermaid SVG 等），不可用时为 null */
  viewDom: HTMLElement | null;
  /** 本文档是否包含代码块（用于后处理 Source Code 样式） */
  hasCodeBlock: boolean;
  /** Pandoc 语义：下一个正文段落是否为章节首段。 */
  nextParagraphIsFirst: boolean;
  /** 脚注标签 -> ProseMirror 定义节点。 */
  footnoteDefinitions: Map<string, PMNode>;
  /** 文档中实际被引用的脚注标签，用于阻止定义内容重复进入正文。 */
  referencedFootnoteLabels: Set<string>;
  /** 按正文引用顺序生成的 Word 脚注编号。 */
  footnoteReferences: { id: number; label: string }[];
  nextFootnoteId: number;
  /** 转换脚注定义时，正文段落应改用 Footnote Text。 */
  inFootnote: boolean;
  /** 当前正在导出的 Alert 类型色；普通文档内容为 null。 */
  alertStyle: { color: string } | null;
};

export interface DocxExportSource {
  doc: PMNode;
  viewDom: HTMLElement | null;
}

/**
 * 生成 .docx 文件的二进制内容。
 * @param editor 编辑器实例
 */
export async function buildDocx(
  source: DocxExportSource
): Promise<Uint8Array> {
  const { doc, viewDom } = source;
  // 编辑器可视 DOM：供导出复用已渲染好的 Mermaid SVG（与屏幕/PDF 所见一致）
  // 固定字号，对齐 Typora（pandoc 导出 Word：正文 12pt = 24 half-points，代码 10.5pt = 21 half-points）
  const ctx: ExportContext = {
    base: 24,
    code: 21,
    placeholders: [],
    tocPlaceholders: [],
    checkboxPlaceholders: [],
    horizontalRulePlaceholders: [],
    viewDom: viewDom ?? null,
    hasCodeBlock: false,
    nextParagraphIsFirst: true,
    footnoteDefinitions: new Map(),
    referencedFootnoteLabels: new Set(),
    footnoteReferences: [],
    nextFootnoteId: FIRST_FOOTNOTE_ID,
    inFootnote: false,
    alertStyle: null,
  };
  collectFootnoteMetadata(doc, ctx);
  const children = [
    ...buildAbstractParagraphs(doc),
    ...(await convertBlocks(doc, ctx)),
  ];
  const footnotes = await convertFootnotes(ctx);
  // Word 文档至少要有一个段落，空文档补一个空段落
  if (children.length === 0) children.push(new Paragraph({ children: [] }));
  const document = new Document({
    styles: {
      default: {
        document: {
          run: { size: ctx.base, font: BODY_FONTS },
          paragraph: {
            spacing: BODY_SPACING,
          },
        },
        heading1: {
          run: { size: 40, bold: true, font: BODY_FONTS },
          paragraph: {
            spacing: {
              before: 360,
              after: 160,
              line: 240,
              lineRule: LineRuleType.AUTO,
            },
            keepNext: true,
            keepLines: true,
          },
        },
        heading2: {
          run: { size: 32, bold: true, font: BODY_FONTS },
          paragraph: {
            spacing: {
              before: 280,
              after: 120,
              line: 240,
              lineRule: LineRuleType.AUTO,
            },
            keepNext: true,
            keepLines: true,
          },
        },
        heading3: {
          run: { size: 28, bold: true, font: BODY_FONTS },
          paragraph: {
            spacing: {
              before: 200,
              after: 80,
              line: 240,
              lineRule: LineRuleType.AUTO,
            },
            keepNext: true,
            keepLines: true,
          },
        },
        heading4: {
          run: { size: 26, bold: true, font: BODY_FONTS },
          paragraph: {
            spacing: {
              before: 160,
              after: 80,
              line: 240,
              lineRule: LineRuleType.AUTO,
            },
            keepNext: true,
            keepLines: true,
          },
        },
        heading5: {
          run: { size: 24, bold: true, font: BODY_FONTS },
          paragraph: {
            spacing: {
              before: 120,
              after: 80,
              line: 240,
              lineRule: LineRuleType.AUTO,
            },
            keepNext: true,
            keepLines: true,
          },
        },
        heading6: {
          run: { size: 24, bold: true, font: BODY_FONTS },
          paragraph: {
            spacing: {
              before: 120,
              after: 80,
              line: 240,
              lineRule: LineRuleType.AUTO,
            },
            keepNext: true,
            keepLines: true,
          },
        },
        footnoteReference: {
          name: "Footnote Reference",
          basedOn: "DefaultParagraphFont",
          run: {
            superScript: true,
          },
        },
        footnoteText: {
          name: "Footnote Text",
          basedOn: "Normal",
          next: FOOTNOTE_TEXT_STYLE,
          uiPriority: 9,
          unhideWhenUsed: true,
          quickFormat: true,
          run: {
            font: BODY_FONTS,
            size: ctx.base,
          },
          paragraph: {
            indent: {
              firstLineChars: 0,
              firstLine: 0,
            },
            spacing: PANDOC_FOOTNOTE_TEXT_SPACING,
          },
        },
        hyperlink: {
          name: "Hyperlink",
          basedOn: "DefaultParagraphFont",
          run: {
            color: HYPERLINK_COLOR,
            underline: { type: UnderlineType.NONE },
          },
        },
      },
      paragraphStyles: [
        {
          id: "TOC",
          name: "TOC Heading",
          basedOn: "Heading1",
          next: "Normal",
          uiPriority: 39,
          unhideWhenUsed: true,
          quickFormat: true,
          run: {
            bold: false,
            font: BODY_FONTS,
          },
          paragraph: {
            spacing: {
              before: 240,
              after: 120,
              line: 300,
              lineRule: LineRuleType.AUTO,
            },
            outlineLevel: 9,
          },
        },
        {
          id: "TOC1",
          name: "toc 1",
          basedOn: "Normal",
          next: "Normal",
          uiPriority: 39,
          unhideWhenUsed: true,
          quickFormat: true,
          run: { font: BODY_FONTS, size: ctx.base },
          paragraph: {
            indent: { left: 0 },
            spacing: {
              before: 60,
              after: 0,
              line: 300,
              lineRule: LineRuleType.AUTO,
            },
          },
        },
        {
          id: "TOC2",
          name: "toc 2",
          basedOn: "Normal",
          next: "Normal",
          uiPriority: 39,
          unhideWhenUsed: true,
          quickFormat: true,
          run: { font: BODY_FONTS, size: ctx.base },
          paragraph: {
            indent: { left: 220 },
            spacing: {
              before: 60,
              after: 0,
              line: 300,
              lineRule: LineRuleType.AUTO,
            },
          },
        },
        {
          id: "TOC3",
          name: "toc 3",
          basedOn: "Normal",
          next: "Normal",
          uiPriority: 39,
          unhideWhenUsed: true,
          quickFormat: true,
          run: { font: BODY_FONTS, size: ctx.base },
          paragraph: {
            indent: { left: 440 },
            spacing: {
              before: 60,
              after: 0,
              line: 300,
              lineRule: LineRuleType.AUTO,
            },
          },
        },
        {
          id: "BodyText",
          name: "Body Text",
          basedOn: "Normal",
          quickFormat: true,
          run: { font: BODY_FONTS, size: ctx.base },
          paragraph: {
            spacing: PANDOC_BODY_SPACING,
          },
        },
        {
          id: "FirstParagraph",
          name: "First Paragraph",
          basedOn: "BodyText",
          next: "BodyText",
          quickFormat: true,
        },
        {
          id: "Compact",
          name: "Compact",
          basedOn: "BodyText",
          quickFormat: true,
          run: { font: BODY_FONTS, size: ctx.base },
          paragraph: {
            indent: {
              firstLineChars: 0,
              firstLine: 0,
            },
            spacing: TABLE_CELL_SPACING,
          },
        },
        {
          id: "SourceCode",
          name: "Source Code",
          basedOn: "BodyText",
          quickFormat: true,
          run: {
            font: CODE_FONTS,
            size: ctx.code,
          },
          paragraph: {
            indent: {
              firstLineChars: 0,
              firstLine: 0,
              left: CODE_BLOCK_HORIZONTAL_INSET_TWIPS,
              right: CODE_BLOCK_HORIZONTAL_INSET_TWIPS,
            },
            shading: { fill: "F5F5F5" },
            border: CODE_BLOCK_BORDER,
          },
        },
        {
          id: "BlockText",
          name: "Block Text",
          basedOn: "BodyText",
          next: "BodyText",
          uiPriority: 9,
          unhideWhenUsed: true,
          quickFormat: true,
          paragraph: {
            indent: {
              firstLineChars: 0,
              firstLine: 0,
              left: BLOCK_TEXT_INDENT_TWIPS,
              right: BLOCK_TEXT_INDENT_TWIPS,
            },
            spacing: BLOCK_TEXT_SPACING,
            border: {
              left: BLOCK_TEXT_BORDER_RULE,
              top: {
                style: BorderStyle.SINGLE,
                size: 2,
                color: "FFFFFF",
                space: 6,
              },
              bottom: {
                style: BorderStyle.SINGLE,
                size: 2,
                color: "FFFFFF",
                space: 6,
              },
              right: {
                style: BorderStyle.SINGLE,
                size: 2,
                color: "FFFFFF",
                space: 9,
              },
            },
          },
        },
        {
          id: FOOTNOTE_BLOCK_TEXT_STYLE,
          name: "Footnote Block Text",
          basedOn: FOOTNOTE_TEXT_STYLE,
          next: FOOTNOTE_TEXT_STYLE,
          uiPriority: 9,
          unhideWhenUsed: true,
          quickFormat: true,
          paragraph: {
            indent: {
              firstLineChars: 0,
              firstLine: 0,
              left: PANDOC_FOOTNOTE_BLOCK_INDENT_TWIPS,
              right: PANDOC_FOOTNOTE_BLOCK_INDENT_TWIPS,
            },
            spacing: PANDOC_FOOTNOTE_BLOCK_SPACING,
          },
        },
        {
          id: CAPTION_STYLE,
          name: "Caption",
          basedOn: "Normal",
          run: {
            italics: true,
          },
          paragraph: {
            spacing: {
              before: 0,
              after: 120,
            },
          },
        },
        {
          id: FIGURE_STYLE,
          name: "Figure",
          basedOn: "Normal",
        },
        {
          id: CAPTIONED_FIGURE_STYLE,
          name: "Captioned Figure",
          basedOn: FIGURE_STYLE,
          paragraph: {
            keepNext: true,
          },
        },
        {
          id: IMAGE_CAPTION_STYLE,
          name: "Image Caption",
          basedOn: CAPTION_STYLE,
          run: {
            vanish: true,
          },
        },
        {
          id: TABLE_CAPTION_STYLE,
          name: "Table Caption",
          basedOn: CAPTION_STYLE,
          paragraph: {
            keepNext: true,
          },
        },
        {
          id: DEFINITION_TERM_STYLE,
          name: "Definition Term",
          basedOn: "Normal",
          next: DEFINITION_STYLE,
          run: {
            bold: true,
            font: DEFINITION_TERM_FONTS,
          },
          paragraph: {
            keepNext: true,
            keepLines: true,
            spacing: {
              before: 0,
              after: 0,
            },
          },
        },
        {
          id: DEFINITION_STYLE,
          name: "Definition",
          basedOn: "Normal",
        },
        {
          id: "AbstractTitle",
          name: "Abstract Title",
          basedOn: "Normal",
          next: "Abstract",
          run: {
            bold: true,
            size: 20,
          },
          paragraph: {
            keepNext: true,
            keepLines: true,
            spacing: {
              before: 300,
              after: 0,
            },
            alignment: AlignmentType.CENTER,
          },
        },
        {
          id: "Abstract",
          name: "Abstract",
          basedOn: "Normal",
          next: "BodyText",
          run: {
            font: ABSTRACT_FONTS,
            size: 21,
          },
          paragraph: {
            keepNext: true,
            keepLines: true,
            spacing: {
              before: 100,
              after: 300,
            },
          },
        },
        {
          id: "Bibliography",
          name: "Bibliography",
          basedOn: "Normal",
          next: "Bibliography",
        },
      ],
    },
    ...(Object.keys(footnotes).length > 0 ? { footnotes } : {}),
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
  // 把公式、目录和任务复选框占位替换为对应 OOXML，并声明所需命名空间。
  if (
    ctx.placeholders.length ||
    ctx.tocPlaceholders.length ||
    ctx.checkboxPlaceholders.length ||
    ctx.horizontalRulePlaceholders.length ||
    ctx.hasCodeBlock
  ) {
    buffer = await injectOoxml(
      buffer,
      ctx.placeholders,
      ctx.tocPlaceholders,
      ctx.checkboxPlaceholders,
      ctx.horizontalRulePlaceholders
    );
  }
  return new Uint8Array(buffer);
}

/* ============ 块级节点 ============ */

function findFrontmatter(doc: PMNode): string {
  for (let i = 0; i < doc.childCount; i += 1) {
    const child = doc.child(i);
    if (child.type.name === "yaml") {
      return String((child.attrs ?? {}).value ?? "");
    }
  }
  return "";
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** 提取顶栏 YAML 的标量或 `|` / `>` 多行值；复杂对象保持不支持。 */
function frontmatterValue(yaml: string, key: string): string | undefined {
  const lines = yaml.replace(/\r\n?/g, "\n").split("\n");
  const keyPattern = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(keyPattern);
    if (!match) continue;
    const marker = match[1].trim();
    if (marker !== "|" && marker !== ">") {
      return unquoteYamlScalar(marker) || undefined;
    }
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === "") {
        block.push("");
        continue;
      }
      if (!/^\s+/.test(line)) break;
      block.push(line.replace(/^\s{1,4}/, "").trimEnd());
    }
    while (block[0] === "") block.shift();
    while (block[block.length - 1] === "") block.pop();
    if (marker === "|") return block.join("\n") || undefined;
    return block
      .join("\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n(?!\n)/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .trim() || undefined;
  }
  return undefined;
}

/** YAML abstract → Pandoc Abstract Title / Abstract 段落。 */
function buildAbstractParagraphs(doc: PMNode): Paragraph[] {
  const yaml = findFrontmatter(doc);
  if (!yaml) return [];
  const abstract = frontmatterValue(yaml, "abstract");
  if (!abstract) return [];
  const title =
    frontmatterValue(yaml, "abstract-title") ?? DEFAULT_ABSTRACT_TITLE;
  const paragraphs = abstract
    .split(/\n\s*\n/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map(
      (text) =>
        new Paragraph({
          style: "Abstract",
          children: [new TextRun({ text })],
        })
    );
  return [
    new Paragraph({
      style: "AbstractTitle",
      children: [new TextRun({ text: title })],
    }),
    ...paragraphs,
  ];
}

function footnoteLabel(node: PMNode): string {
  return String((node.attrs ?? {}).label ?? "").trim();
}

/**
 * 脚注定义可以在引用之前或之后出现，先完整扫描文档，保证正文按引用顺序
 * 分配 Word 脚注编号时已经知道哪些定义有效。
 */
function collectFootnoteMetadata(doc: PMNode, ctx: ExportContext): void {
  // 第一遍收集定义。
  doc.descendants((node) => {
    if (node.type.name === "footnote_definition") {
      const label = footnoteLabel(node);
      if (label && !ctx.footnoteDefinitions.has(label)) {
        ctx.footnoteDefinitions.set(label, node);
      }
    }
  });
  // 第二遍按文档顺序记录实际引用，不能受“引用写在定义之前”影响。
  doc.descendants((node) => {
    if (node.type.name === "footnote_reference") {
      const label = footnoteLabel(node);
      if (label && ctx.footnoteDefinitions.has(label)) {
        ctx.referencedFootnoteLabels.add(label);
      }
    }
  });
}

/**
 * 把脚注定义中的块内容转换为 docx 脚注段落。
 * docx 只接受 Paragraph[]；脚注内表格等极少数块暂以单段文本保留，避免内容丢失。
 */
async function convertFootnotes(
  ctx: ExportContext
): Promise<Record<string, { children: Paragraph[] }>> {
  const footnotes: Record<string, { children: Paragraph[] }> = {};
  const previousFirstParagraph = ctx.nextParagraphIsFirst;
  const wasInFootnote = ctx.inFootnote;
  ctx.nextParagraphIsFirst = false;
  ctx.inFootnote = true;
  try {
    // 使用正文转换阶段登记的引用快照，避免脚注定义中的循环引用导致无限生成。
    const references = [...ctx.footnoteReferences];
    for (const { id, label } of references) {
      const definition = ctx.footnoteDefinitions.get(label);
      if (!definition) continue;
      const paragraphs: Paragraph[] = [];
      for (let i = 0; i < definition.childCount; i += 1) {
        const child = definition.child(i);
        const blocks = await convertBlock(child, ctx);
        for (const block of blocks) {
          if (block instanceof Paragraph) {
            paragraphs.push(block);
          } else {
            paragraphs.push(
              new Paragraph({
                style: FOOTNOTE_TEXT_STYLE,
                children: [new TextRun({ text: child.textContent })],
              })
            );
          }
        }
      }
      // docx 会在首个脚注段落前自动插入 footnoteRef；空定义仍保留一个空段落。
      if (paragraphs.length === 0) {
        paragraphs.push(
          new Paragraph({
            style: FOOTNOTE_TEXT_STYLE,
            children: [],
          })
        );
      }
      footnotes[String(id)] = { children: paragraphs };
    }
  } finally {
    ctx.nextParagraphIsFirst = previousFirstParagraph;
    ctx.inFootnote = wasInFootnote;
  }
  return footnotes;
}

type ImageDocProperties = {
  name: string;
  description?: string;
  title?: string;
};

/** Markdown 图片的 alt/title → Word 图片对象属性；空值不生成占位属性。 */
function imageDocProperties(node: PMNode): ImageDocProperties | undefined {
  const description = String((node.attrs ?? {}).alt ?? "").trim();
  const title = String((node.attrs ?? {}).title ?? "").trim();
  if (!description && !title) return undefined;
  return {
    name: IMAGE_DOC_PROPERTIES_NAME,
    ...(description ? { description } : {}),
    ...(title ? { title } : {}),
  };
}

/** HTML <img alt/title> → Word 图片对象属性。 */
function htmlImageDocProperties(
  element: Element
): ImageDocProperties | undefined {
  const description = (element.getAttribute("alt") ?? "").trim();
  const title = (element.getAttribute("title") ?? "").trim();
  if (!description && !title) return undefined;
  return {
    name: IMAGE_DOC_PROPERTIES_NAME,
    ...(description ? { description } : {}),
    ...(title ? { title } : {}),
  };
}

/** 只包含一个图片的段落按 Pandoc 的独立 Figure 语义处理。 */
function standaloneImage(node: PMNode): PMNode | null {
  if (node.childCount !== 1) return null;
  const child = node.firstChild;
  return child?.type.name === "image" ? child : null;
}

/** Pandoc 表格题注语法：紧跟在表格后的 `: caption` 段落。 */
function tableCaptionText(node: PMNode): string | null {
  if (node.type.name !== "paragraph") return null;
  const match = node.textContent.match(/^\s*:\s+(.+)$/s);
  return match?.[1].trim() || null;
}

async function convertBlocks(parent: PMNode, ctx: ExportContext): Promise<BlockChild[]> {
  const previousFirstParagraph = ctx.nextParagraphIsFirst;
  ctx.nextParagraphIsFirst = true;
  const out: BlockChild[] = [];
  for (let i = 0; i < parent.childCount; i += 1) {
    const node = parent.child(i);
    out.push(...(await convertBlock(node, ctx)));
    if (node.type.name !== "table" || i + 1 >= parent.childCount) continue;
    const caption = tableCaptionText(parent.child(i + 1));
    if (!caption) continue;
    out.push(
      createParagraph(ctx, {
        style: TABLE_CAPTION_STYLE,
        children: [new TextRun({ text: caption })],
      })
    );
    i += 1;
  }
  ctx.nextParagraphIsFirst = previousFirstParagraph;
  return out;
}

/**
 * Alert uses paragraph borders rather than a table or fill:
 * every paragraph keeps the same left rule and gains a small content indent.
 */
function createParagraph(
  ctx: ExportContext,
  options: IParagraphOptions,
  spacing: ParagraphSpacing = ALERT_PARAGRAPH_SPACING
): Paragraph {
  if (!ctx.alertStyle) return new Paragraph(options);
  const existingLeft =
    typeof options.indent?.left === "number" ? options.indent.left : 0;
  return new Paragraph({
    ...options,
    border: {
      ...options.border,
      left: {
        style: BorderStyle.SINGLE,
        size: ALERT_BORDER_WIDTH,
        color: ctx.alertStyle.color,
        space: ALERT_BORDER_SPACE_PT,
      },
    },
    indent: {
      ...options.indent,
      left: existingLeft + ALERT_CONTENT_INDENT_TWIPS,
    },
    spacing,
  });
}

async function convertAlert(
  node: PMNode,
  ctx: ExportContext
): Promise<BlockChild[]> {
  const type = String((node.attrs ?? {}).alertType ?? "note").toLowerCase();
  const style = ALERT_EXPORT_STYLES[type] ?? ALERT_EXPORT_STYLES.note;
  const customTitle = String((node.attrs ?? {}).title ?? "").trim();
  const previous = ctx.alertStyle;
  ctx.alertStyle = { color: style.color };
  try {
    const titleRun = new TextRun({
      text: customTitle ? `${style.label}  ${customTitle}` : style.label,
      bold: true,
      color: style.color,
    });
    const bodyParagraphs = paragraphOnlyAlertBody(node);
    if (bodyParagraphs) {
      const bodyRuns: InlineChild[] = [];
      for (const paragraph of bodyParagraphs) {
        if (bodyRuns.length > 0) bodyRuns.push(new TextRun({ break: 1 }));
        bodyRuns.push(...(await convertInline(paragraph, ctx)));
      }
      return [
        createParagraph(
          ctx,
          {
            style: "BodyText",
            children: [
              titleRun,
              new TextRun({ break: 1 }),
              ...bodyRuns,
            ],
          },
          {
            ...ALERT_PARAGRAPH_SPACING,
          }
        ),
      ];
    }
    const title = createParagraph(ctx, {
      style: "BodyText",
      keepNext: true,
      children: [titleRun],
    });
    const body = await convertBlocks(node, ctx);
    return [title, ...body];
  } finally {
    ctx.alertStyle = previous;
  }
}

/** Paragraph-only alerts merge into one Word paragraph, like blockquotes. */
function paragraphOnlyAlertBody(node: PMNode): PMNode[] | null {
  const paragraphs: PMNode[] = [];
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (child.type.name !== "paragraph") return null;
    paragraphs.push(child);
  }
  return paragraphs.length > 0 ? paragraphs : null;
}

/** Each nested quote adds one body-font em to both sides of the text area. */
function quoteLevelIndentTwips(ctx: ExportContext, depth: number): number {
  return Math.round(
    (ctx.base / HALF_POINTS_PER_POINT) *
      TWIPS_PER_POINT *
      QUOTE_LEVEL_INDENT_EM *
      depth
  );
}

/** 消费 Pandoc 的 First Paragraph 标记，并选择正文段落样式。 */
function takeBodyParagraphStyle(
  ctx: ExportContext
): "FirstParagraph" | "BodyText" | typeof FOOTNOTE_TEXT_STYLE {
  const style = ctx.inFootnote
    ? FOOTNOTE_TEXT_STYLE
    : ctx.nextParagraphIsFirst
      ? "FirstParagraph"
      : "BodyText";
  ctx.nextParagraphIsFirst = false;
  return style;
}

async function convertBlock(
  node: PMNode,
  ctx: ExportContext,
  options: BlockConversionOptions = {}
): Promise<BlockChild[]> {
  switch (node.type.name) {
    case "heading": {
      const level = clampLevel(Number(node.attrs.level) || 1);
      const heading = [
        createParagraph(ctx, {
          heading: level,
          children: await convertInline(node, ctx),
        }),
      ];
      ctx.nextParagraphIsFirst = true;
      return heading;
    }

    case "paragraph": {
      const image = standaloneImage(node);
      if (image) {
        const embedded = await embedImage(
          String(image.attrs.src ?? ""),
          imageDocProperties(image)
        );
        if (embedded) {
          const caption = String(image.attrs.alt ?? "").trim();
          const imageParagraph = createParagraph(ctx, {
            style: caption
              ? CAPTIONED_FIGURE_STYLE
              : takeBodyParagraphStyle(ctx),
            alignment: paragraphAlignment(node),
            children: [embedded],
          });
          if (!caption) return [imageParagraph];
          ctx.nextParagraphIsFirst = false;
          return [
            imageParagraph,
            createParagraph(ctx, {
              style: IMAGE_CAPTION_STYLE,
              children: [new TextRun({ text: caption })],
            }),
          ];
        }
      }
      return [
        createParagraph(ctx, {
          style: takeBodyParagraphStyle(ctx),
          // 段落里嵌着 <center> 的行内 HTML 时整段居中（此前只在 default 分支
          // 判定，而 paragraph 有独立分支，导致居中判定根本执行不到）
          alignment: paragraphAlignment(node),
          children: await convertInline(node, ctx),
        }),
      ];
    }

    case "alert":
      return convertAlert(node, ctx);

    case "blockquote": {
      const out: BlockChild[] = [];
      let inline: InlineChild[] = [];
      const quoteDepth = Math.max(0, options.quoteDepth ?? 0);
      const nestedIndent = quoteLevelIndentTwips(ctx, quoteDepth);
      const flushParagraph = () => {
        if (inline.length === 0) return;
        out.push(
          createParagraph(ctx, {
            style: ctx.inFootnote ? FOOTNOTE_BLOCK_TEXT_STYLE : "BlockText",
            ...(nestedIndent > 0
              ? {
                  tabStops: [
                    {
                      type: TabStopType.LEFT,
                      position: BLOCK_TEXT_INDENT_TWIPS + nestedIndent,
                    },
                  ],
                }
              : {}),
            children: inline,
          })
        );
        inline = [];
      };
      for (let i = 0; i < node.childCount; i += 1) {
        const child = node.child(i);
        if (child.type.name === "paragraph") {
          const paragraph = await convertInline(child, ctx);
          if (paragraph.length === 0) continue;
          if (inline.length > 0) inline.push(new TextRun({ break: 1 }));
          if (quoteDepth > 0) {
            inline.push(new TextRun({ children: [new Tab()] }));
          }
          inline.push(...paragraph);
        } else {
          // 引用块内的列表/代码块等：递归处理（缩进样式不再叠加）
          flushParagraph();
          out.push(
            ...(await convertBlock(
              child,
              ctx,
              child.type.name === "blockquote"
                ? { quoteDepth: quoteDepth + 1 }
                : {}
            ))
          );
        }
      }
      flushParagraph();
      return out;
    }

    case "bullet_list":
    case "ordered_list":
      return convertList(node, ctx, 0);

    case "code_block":
    case "fence": {
      if (
        node.type.name === "code_block" &&
        isMermaidLanguage((node.attrs ?? {}).language)
      ) {
        const code = node.textContent;
        const diagram = await diagramToImage(code, "", ctx.viewDom);
        if (diagram) {
          return [
            createParagraph(ctx, {
              children: [
                new ImageRun({
                  type: "svg",
                  data: svgDataUri(diagram.svg),
                  fallback: {
                    type: "png",
                    data: diagram.fallback,
                  },
                  transformation: {
                    width: diagram.width,
                    height: diagram.height,
                  },
                }),
              ],
            }),
          ];
        }
        return [sourceParagraph(code, ctx)];
      }
      ctx.hasCodeBlock = true;
      const lines = node.textContent.split("\n");
      const children: TextRun[] = [];
      for (let i = 0; i < lines.length; i += 1) {
        children.push(new TextRun({ text: lines[i] || " " }));
        if (i < lines.length - 1) children.push(new TextRun({ break: 1 }));
      }
      return [
        createParagraph(ctx, {
          style: "SourceCode",
          // docx 库中 true 会写成 <w:wordWrap w:val="0"/>，即关闭自动换行。
          wordWrap: true,
          children,
        }),
      ];
    }

    case "table": {
      const rows: TableRow[] = [];
      const columnCount = Math.max(1, node.firstChild?.childCount ?? 0);
      const sourceColumnWidths = explicitTableColumnWidths(node, columnCount);
      const columnWidths = sourceColumnWidths
        ? scaleTableColumnWidths(sourceColumnWidths, PAGE_CONTENT_W)
        : null;
      for (let r = 0; r < node.childCount; r += 1) {
        const rowNode = node.child(r);
        const cells: TableCell[] = [];
        for (let c = 0; c < rowNode.childCount; c += 1) {
          const cellNode = rowNode.child(c);
          // GFM 表格的 cellContent 固定为 paragraph；水平对齐存在单元格
          // attrs.alignment 上，但在 Word 中必须落到单元格段落的 w:jc。
          const paragraphNode = cellNode.firstChild;
          cells.push(
            new TableCell({
              children: [
                new Paragraph({
                  style: "Compact",
                  alignment: tableCellAlignment(cellNode),
                  children:
                    paragraphNode?.type.name === "paragraph"
                      ? await convertInline(paragraphNode, ctx)
                      : [],
                }),
              ],
              ...(columnWidths
                ? {
                    width: {
                      size: columnWidths[c] ?? 1,
                      type: WidthType.DXA,
                    },
                  }
                : {}),
            })
          );
        }
        rows.push(new TableRow({ children: cells }));
      }
      return [
        new Table({
          rows,
          width: columnWidths ? WORD_TABLE_FULL_WIDTH : WORD_TABLE_AUTO_WIDTH,
          ...(columnWidths
            ? { columnWidths, layout: TableLayoutType.FIXED }
            : {}),
          indent: { size: 0, type: WidthType.DXA },
          margins: WORD_TABLE_CELL_MARGINS,
        }),
      ];
    }

    case "image": {
      const embedded = await embedImage(
        String(node.attrs.src ?? ""),
        imageDocProperties(node)
      );
      if (embedded) return [createParagraph(ctx, { children: [embedded] })];
      const label = String(node.attrs.alt ?? "") || "图片";
      return [
        createParagraph(ctx, {
          children: [new TextRun({ text: `[${label}]`, italics: true, color: "888888" })],
        }),
      ];
    }

    case "hr":
    case "horizontal_rule": {
      const token = nextHorizontalRuleToken(ctx);
      ctx.horizontalRulePlaceholders.push({ token });
      return [createParagraph(ctx, { children: [new TextRun({ text: token })] })];
    }

    // 块级数学公式：先尝试转 Word 原生 OMML，失败再降级为栅格图片，再失败为源码
    case "math_block": {
      const tex = sourceOf(node);
      const omml = await latexToOmml(tex, true);
      if (omml) {
        const token = nextToken(ctx);
        ctx.placeholders.push({ token, omml });
        return [
          createParagraph(ctx, {
            spacing: { after: 120 },
            children: [new TextRun({ text: token })],
          }),
        ];
      }
      const img = await formulaToImage(tex, true);
      if (img) return [createParagraph(ctx, { children: [img] })];
      return [sourceParagraph(tex, ctx)];
    }

    // Mermaid 图表：以 SVG 矢量为主，同时嵌入高分辨率 PNG 作为旧版 Word 回退。
    case "diagram": {
      const code = sourceOf(node);
      const identity = String((node.attrs ?? {}).identity ?? "");
      const diagram = await diagramToImage(code, identity, ctx.viewDom);
      if (diagram) {
        return [
          createParagraph(ctx, {
            children: [
              new ImageRun({
                type: "svg",
                data: svgDataUri(diagram.svg),
                fallback: {
                  type: "png",
                  data: diagram.fallback,
                },
                transformation: {
                  width: diagram.width,
                  height: diagram.height,
                },
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
      ctx.tocPlaceholders.push({ token, xml: buildTocFieldXml() });
      return [createParagraph(ctx, { children: [new TextRun({ text: token })] })];
    }

    // 块级 HTML：htmlBlock 是 atom 节点（HTML 源码存 attrs.value、无子节点）。
    // 编辑器里由 NodeView 渲染成真实 DOM，所以 PDF（打印 DOM）看得到；但导出 DOCX
    // 时若落到 default 分支「递归子节点」，原子节点没有子节点 → 内容直接丢失。
    case "htmlBlock": {
      const value = String((node.attrs ?? {}).value ?? "");
      return await htmlBlockToParagraphs(value, ctx);
    }

    case "footnote_definition": {
      const label = footnoteLabel(node);
      // 被引用的定义会进入 Word 原生脚注区；孤立定义继续按普通段落保留，
      // 避免沿用编辑器“未引用定义不显示”的规则而静默丢内容。
      if (label && ctx.referencedFootnoteLabels.has(label)) return [];
      return convertBlocks(node, ctx);
    }

    default: {
      if (node.isTextblock) {
        return [
          createParagraph(ctx, {
            style: takeBodyParagraphStyle(ctx),
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
  link?: boolean;
};

/** HtmlMark → TextRun 样式选项 */
function htmlMarkOptions(m: HtmlMark): TextRunOptions {
  return {
    bold: m.b || undefined,
    italics: m.i || undefined,
    underline: m.u ? {} : undefined,
    strike: m.s || undefined,
    font: m.code ? CODE_FONTS : undefined,
    style: m.link ? "Hyperlink" : undefined,
  };
}

/**
 * 行内内容 → docx 内联元素（处理文本、<br>、行内样式标签、<a> 外链、<img> 图片）。
 *
 * 为什么是 async：内嵌图片要先取字节再解码（embedImage 异步），而 <img> 既可能
 * 出现在行内 HTML 也可能出现在块级 HTML，所以整条 HTML → docx 链路都得是异步，
 * 调用方逐层 await。
 * 注意用 for...of 而不是 forEach —— forEach 回调里的 await 不会被等待，
 * 会导致图片还没嵌入就返回。
 */
async function htmlInlineChildren(node: Node, m: HtmlMark): Promise<InlineChild[]> {
  const out: InlineChild[] = [];
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      // 源码里的换行与缩进压成单个空格（与浏览器渲染一致）
      const text = (child.textContent ?? "").replace(/\s+/g, " ");
      if (!text.trim()) continue;
      out.push(new TextRun({ text, ...htmlMarkOptions(m) }));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const tag = el.tagName.toUpperCase();
    if (tag === "BR") {
      out.push(new TextRun({ text: "", break: 1, ...htmlMarkOptions(m) }));
      continue;
    }
    // 手写 <img src="...">：内嵌真实图片。此前这里直接跳过，理由是「图片由
    // image 节点承载」——那只覆盖 markdown 的 ![]()，手写 <img> 并不是 image
    // 节点，会被整张丢掉（Word 里只剩文字）。
    if (tag === "IMG") {
      const src = el.getAttribute("src") ?? "";
      const embedded = src
        ? await embedImage(src, htmlImageDocProperties(el))
        : null;
      if (embedded) out.push(embedded);
      continue;
    }
    // 行内位置出现块级元素：仍把其文本收进来（是否分段由上层决定）
    if (tag === "CENTER" || HTML_BLOCK_TAGS.has(tag)) {
      out.push(...(await htmlInlineChildren(el, m)));
      continue;
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
        next.link = true;
        const inner = (await htmlInlineChildren(el, next)).filter(
          (c): c is TextRun => c instanceof TextRun
        );
        if (inner.length) {
          out.push(new ExternalHyperlink({ link: href, children: inner }));
          continue;
        }
      }
    }
    out.push(...(await htmlInlineChildren(el, next)));
  }
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
async function htmlBlockToParagraphs(
  html: string,
  ctx: ExportContext
): Promise<Paragraph[]> {
  if (!html || !html.trim()) return [];
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const out: Paragraph[] = [];

  const walk = async (parent: Node, align: HtmlAlign): Promise<void> => {
    let pending: InlineChild[] = [];
    const flush = () => {
      if (pending.length > 0) {
        out.push(createParagraph(ctx, { alignment: align, children: pending }));
        pending = [];
      }
    };
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text) pending.push(new TextRun({ text }));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      const tag = el.tagName.toUpperCase();
      // <center>：内部段落整体居中（Word 里用段落对齐实现）
      if (tag === "CENTER") {
        flush();
        await walk(el, AlignmentType.CENTER);
        continue;
      }
      if (tag === "DL") {
        flush();
        for (const item of Array.from(el.children)) {
          const itemTag = item.tagName.toUpperCase();
          if (itemTag !== "DT" && itemTag !== "DD") continue;
          out.push(
            createParagraph(ctx, {
              style: itemTag === "DT" ? DEFINITION_TERM_STYLE : DEFINITION_STYLE,
              alignment: align,
              children: await htmlInlineChildren(item, {}),
            })
          );
        }
        continue;
      }
      if (HTML_BLOCK_TAGS.has(tag)) {
        flush();
        await walk(el, align);
        flush();
        continue;
      }
      // 单独成行的 <img>：图片在 Word 里独立成段。这里必须处理元素「自身」——
      // walk 的其余分支都是递归子节点，而 <img> 没有子节点，若走
      // htmlInlineChildren(el) 只会拿到空数组、图片丢失。
      if (tag === "IMG") {
        flush();
        const src = el.getAttribute("src") ?? "";
        const embedded = src
          ? await embedImage(src, htmlImageDocProperties(el))
          : null;
        if (embedded) {
          out.push(
            createParagraph(ctx, { alignment: align, children: [embedded] })
          );
        }
        continue;
      }
      pending.push(...(await htmlInlineChildren(el, {})));
    }
    flush();
  };

  await walk(parsed.body, undefined);
  return out;
}

/**
 * HTML 片段 → docx 内联元素（行内 html 节点用）。
 * 块级 HTML 请走 htmlBlockToParagraphs；这里只取行内内容（文本 + 行内样式）。
 */
async function htmlFragmentToInline(html: string): Promise<InlineChild[]> {
  if (!html || !html.trim()) return [];
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return await htmlInlineChildren(parsed.body, {});
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

/** GFM 单元格水平对齐 → Word 段落对齐。 */
function tableCellAlignment(node: PMNode): HtmlAlign {
  switch (String((node.attrs ?? {}).alignment ?? "left")) {
    case "center":
      return AlignmentType.CENTER;
    case "right":
      return AlignmentType.RIGHT;
    default:
      return AlignmentType.LEFT;
  }
}

/** 读取表格所有 GFM 列的有效 colwidth；任一列缺失时返回 null。 */
function explicitTableColumnWidths(
  table: PMNode,
  columnCount: number
): number[] | null {
  const widths: Array<number | null> = Array(columnCount).fill(null);
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const row = table.child(rowIndex);
    for (let column = 0; column < row.childCount; column += 1) {
      if (column >= columnCount) break;
      const colwidth = row.child(column).attrs.colwidth;
      const width = Array.isArray(colwidth) ? Number(colwidth[0]) : 0;
      if (Number.isFinite(width) && width > 0) {
        widths[column] = width;
      }
    }
  }
  return widths.every(
    (width): width is number => width !== null && width > 0
  )
    ? widths
    : null;
}

/** 保留编辑器中的列宽比例，并映射到 Word 页面内容宽度。 */
function scaleTableColumnWidths(
  sourceWidths: number[],
  targetWidth: number
): number[] {
  const sourceTotal = sourceWidths.reduce((sum, width) => sum + width, 0);
  let used = 0;
  return sourceWidths.map((width, index) => {
    if (index === sourceWidths.length - 1) {
      return Math.max(1, targetWidth - used);
    }
    const scaled = Math.max(
      1,
      Math.floor((width / sourceTotal) * targetWidth)
    );
    used += scaled;
    return scaled;
  });
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
    const marker = ordered
      ? orderedMarker(i, depth)
      : bulletMarker(depth);
    let hasMarker = false;
    let paragraphIndex = 0;
    const compact = item.attrs.spread === false;
    for (let j = 0; j < item.childCount; j += 1) {
      const child = item.child(j);
      if (child.type.name === "paragraph") {
        const leading: InlineChild[] = [];
        if (!hasMarker) {
          hasMarker = true;
          if (isTask) {
            const checkboxToken = nextCheckboxToken(ctx, checked);
            leading.push(new TextRun({ text: checkboxToken }));
            leading.push(new TextRun({ text: " " }));
          } else {
            leading.push(new TextRun({ text: marker, font: BODY_FONTS }));
          }
        }
        const style = compact
          ? "Compact"
          : ctx.inFootnote
            ? FOOTNOTE_TEXT_STYLE
            : paragraphIndex === 0
            ? "FirstParagraph"
            : "BodyText";
        paragraphIndex += 1;
        out.push(
          createParagraph(ctx, {
            style,
            indent: {
              left: LIST_INDENT * (depth + 1),
              hanging: leading.length ? LIST_INDENT : 0,
            },
            children: [
              ...leading,
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
        out.push(new TextRun({ text: `$${tex}$`, font: CODE_FONTS, color: "666666" }));
        break;
      }
      case "image": {
        const embedded = await embedImage(
          String(child.attrs.src ?? ""),
          imageDocProperties(child)
        );
        if (embedded) out.push(embedded);
        break;
      }
      case "footnote_reference": {
        const label = footnoteLabel(child);
        if (!label || !ctx.footnoteDefinitions.has(label)) {
          out.push(new TextRun({ text: `[^${label}]` }));
          break;
        }
        const id = ctx.nextFootnoteId;
        ctx.nextFootnoteId += 1;
        ctx.footnoteReferences.push({ id, label });
        out.push(new FootnoteReferenceRun(id));
        break;
      }
      // 行内 HTML 节点（milkdown 内置 html schema，源码存 attrs.value）。
      // 与 htmlBlock 同理：原子节点无子节点，不专门处理就会丢失其中的文字。
      // 实测 <center>…</center> 独立成行时若被内置行内 schema 抢先匹配，
      // 会被包进 paragraph 里变成这种节点，正是「Word 里字不见」的另一条路径。
      case "html": {
        out.push(...(await htmlFragmentToInline(String((child.attrs ?? {}).value ?? ""))));
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
        opts.font = CODE_FONTS;
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

/** MathJax 渲染 LaTeX 为 MathML，再转 OMML；失败返回 null */
async function latexToOmml(tex: string, displayMode: boolean): Promise<string | null> {
  try {
    if (!tex || !tex.trim()) return null;
    const mathml = await texToMathMl(tex, displayMode);
    let omml = mathMlToOmml(mathml);
    if (!omml || !omml.includes("<m:")) return null;
    if (displayMode) omml = `<m:oMathPara>${omml}</m:oMathPara>`;
    return omml;
  } catch (err) {
    console.warn("[NoteMark] latex->OMML failed:", tex, err);
    return null;
  }
}

/** 公式降级为栅格图片（MathJax SVG 栅格化） */
async function formulaToImage(tex: string, displayMode: boolean): Promise<ImageRun | null> {
  try {
    const container = await renderMathJaxSvg(tex, displayMode);
    const svg = container.querySelector("svg")?.outerHTML;
    if (!svg) return null;
    const png = await svgToPng(
      svg,
      MAX_IMAGE_WIDTH,
      displayMode ? MAX_FIGURE_HEIGHT_PX : undefined,
      FORMULA_EXPORT_RASTER_SCALE
    );
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
  maxHeight?: number,
  rasterScale?: number
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
    const scale =
      rasterScale ?? Math.min(3, Math.max(2, window.devicePixelRatio || 2));
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
      new RegExp(
        `\\b${name}\\s*=\\s*["']?\\s*([\\d.]+)\\s*(px|pt|em|rem|ex|%)?`,
        "i"
      )
    );
    if (!m) return NaN;
    if (m[2] === "%") return NaN;
    const value = num(m[1]);
    switch ((m[2] ?? "").toLowerCase()) {
      case "":
      case "px":
        return value;
      case "pt":
        return (value * 96) / 72;
      case "em":
      case "rem":
        return value * WORD_BODY_FONT_SIZE_PX;
      case "ex":
        return value * WORD_BODY_FONT_SIZE_PX * MATHJAX_EX_TO_EM;
      default:
        return NaN;
    }
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
    // 相对路径必须先解析：image 节点的 attrs.src 存的是「原始相对路径」
    // （assets/xxx.png），直接 fetch 会按 WebView 页面 origin 解析 → 404，
    // 图片因此丢失。resolveImageSrc 与编辑器渲染（image-view）、PDF 内联
    // 走同一套逻辑：拼上当前文档所在目录再 convertFileSrc，得到 webview
    // 可加载的 asset URL。data/blob/http(s) 会原样返回，不受影响。
    //
    // referrerPolicy: "no-referrer" —— fetch 默认会带 Referer（dev 为
    // http://localhost:5173/、打包后为 tauri://localhost/），而多数图床
    // （实测 B站 i0.hdslb.com）只放行「空 Referer 或自家域名」，带应用来源
    // 的请求会被判防盗链返回 403。<img> 加载本来就不带 Referer，所以编辑器
    // 里能显示、Word 导出却取不到字节，正是这个差异造成的。
    const res = await fetch(resolveImageSrc(src), { referrerPolicy: "no-referrer" });
    if (!res.ok) {
      console.warn("[NoteMark] image fetch not ok:", src, res.status);
      return null;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0) {
      console.warn("[NoteMark] image empty:", src);
      return null;
    }
    // 以真实字节判格式，而不是 content-type 或 URL 扩展名：远程图片常出现
    // content-type 不准（图床返回 octet-stream），或跨域/防盗链时返回的其实
    // 是 HTML 错误页。此前盲信扩展名，会把无效字节塞进 ImageRun，在 Word 里
    // 表现为「空白图片」；以文件头为准，无效内容会被识别出来并降级为占位。
    const sniffed = sniffImageType(buf);
    if (!sniffed) {
      console.warn(
        "[NoteMark] image is not a supported format:",
        src,
        "| content-type:", res.headers.get("content-type"),
        "| head:", Array.from(buf.slice(0, 8))
      );
      return null;
    }
    return { type: sniffed.type, data: buf, mime: sniffed.mime };
  } catch (err) {
    console.warn("[NoteMark] load image failed:", src, err);
    return null;
  }
}

/**
 * 按页面内容区等比缩放（contain）：超过上限的图缩到刚好放得下，没超出的
 * 保持原尺寸 —— 小图不放大，避免变模糊。
 *
 * 上限取自页面常量：内容区宽 9026 twips ≈ 601px，宽度上限 MAX_IMAGE_WIDTH
 * （= MERMAID_WIDTH_PX ≈ 589px，正好顶到页边距）；高度上限 MAX_FIGURE_HEIGHT_PX
 * （半页），保证竖图 / 长图不会超出一页。只缩不放：小图保持原尺寸，避免放大
 * 后模糊。所有内嵌路径都必须过这一层，否则大图会撑出页面。
 */
function fitToPage(w: number, h: number): { width: number; height: number } {
  if (!w || !h) return { width: MAX_IMAGE_WIDTH, height: 320 };
  let width = Math.min(w, MAX_IMAGE_WIDTH);
  let height = Math.round((h * width) / w);
  // 竖图 / 长图再按高度回缩，保证不超出单页内容区
  if (height > MAX_FIGURE_HEIGHT_PX) {
    height = MAX_FIGURE_HEIGHT_PX;
    width = Math.max(1, Math.round((MAX_FIGURE_HEIGHT_PX * w) / h));
  }
  return { width, height: Math.max(1, height) };
}

/** 内嵌图片到 docx：位图直接内嵌，svg / webp / avif 先栅格化为 png，失败返回 null */
async function embedImage(
  src: string,
  altText?: ImageDocProperties
): Promise<ImageRun | null> {
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
      ...(altText ? { altText } : {}),
    });
  }

  // webp / avif 在现代图床上很常见，但 docx 库不支持内嵌，先交给浏览器解码
  // 再转成 png（与 svg 栅格化同一个思路）。
  if (type === "webp" || type === "avif") {
    const png = await rasterToPng(data, mime);
    if (!png) return null;
    // rasterToPng 输出的是原图像素尺寸，必须过一遍页面约束，否则大图会撑出页面
    const { width, height } = fitToPage(png.width, png.height);
    return new ImageRun({
      type: "png",
      data: png.data,
      transformation: { width, height },
      ...(altText ? { altText } : {}),
    });
  }

  const size = await imageSizeFromBytes(data, mime);
  const { width, height } = fitToPage(size?.w ?? 0, size?.h ?? 0);
  return new ImageRun({
    type,
    data,
    transformation: { width, height },
    ...(altText ? { altText } : {}),
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
  const container =
    Array.from(viewDom.querySelectorAll<HTMLElement>(".diagram")).find(
      (candidate) => candidate.dataset.diagramId === identity
    ) ?? null;
  const el = container?.querySelector<SVGSVGElement>("svg") ?? null;
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
  const background = resolveMermaidExportBackground(container);
  return normalizeMermaidSvgForExport(svg, background);
}

/**
 * 生成 Mermaid 图表的 SVG 与 PNG 回退。
 * 优先复用编辑器已渲染好的 SVG，取不到（深色主题 / 未渲染 / 导出环境无 DOM）时
 * 回退到浅色主题重新渲染。尺寸仍按 SVG 自身尺寸（viewBox）配合页面内容区缩放。
 */
async function diagramToImage(
  code: string,
  identity: string,
  viewDom: HTMLElement | null
): Promise<{
  svg: string;
  fallback: Uint8Array;
  width: number;
  height: number;
} | null> {
  const svg = pickRenderedSvg(identity, viewDom) ?? (await renderMermaid(code));
  if (!svg) return null;
  const png = await svgToPng(
    svg,
    MERMAID_WIDTH_PX,
    MAX_FIGURE_HEIGHT_PX,
    DIAGRAM_EXPORT_RASTER_SCALE
  );
  if (!png) return null;
  return {
    svg,
    fallback: png.data,
    width: png.width,
    height: png.height,
  };
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
      htmlLabels: false,
    });
    const id = `docx-mermaid-${Math.random().toString(36).slice(2)}`;
    const { svg } = await mermaid.render(id, code);
    return normalizeMermaidSvgForExport(
      svg,
      DEFAULT_MERMAID_EXPORT_BACKGROUND
    );
  } catch (err) {
    console.warn("[NoteMark] mermaid render failed:", err);
    return null;
  }
}

/* ============ 注入（docx zip 改写：公式 / 目录 / Word 复选框） ============ */

/** 把公式、目录和任务复选框占位替换为对应 OOXML，并声明所需命名空间。 */
async function injectOoxml(
  buffer: ArrayBuffer,
  placeholders: { token: string; omml: string }[],
  tocPlaceholders: { token: string; xml: string }[],
  checkboxPlaceholders: { token: string; checked: boolean; id: number }[],
  horizontalRulePlaceholders: { token: string }[]
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

  // Word 任务复选框：占位 run -> 运行级内容控件。token 不得跨越 </w:r>，
  // 避免把复选框后面的正文 run 一并替换掉。
  for (const { token, checked, id } of checkboxPlaceholders) {
    const re = new RegExp(
      `<w:r\\b[^>]*>(?:(?!</w:r>).)*?${escapeRegExp(token)}.*?</w:r>`,
      "s"
    );
    xml = xml.replace(re, buildWordCheckboxXml(checked, id));
  }

  // Pandoc-compatible VML horizontal rule. o:hr keeps Word's inline HR layout
  // (so the paragraph mark follows it), while o:hrheight explicitly requests a
  // thin 0.5 pt rule instead of the default thick/double appearance.
  for (const { token } of horizontalRulePlaceholders) {
    const re = new RegExp(
      `<w:p\\b[^>]*>(?:(?!</w:p>).)*?${escapeRegExp(token)}.*?</w:p>`,
      "s"
    );
    xml = xml.replace(re, buildHorizontalRuleXml());
  }

  if (placeholders.length && !/xmlns:m=/.test(xml)) {
    xml = xml.replace(/<w:document\b/, `<w:document xmlns:m="${OMML_NS}"`);
  }
  if (checkboxPlaceholders.length && !/xmlns:w14=/.test(xml)) {
    xml = xml.replace(
      /<w:document\b/,
      `<w:document xmlns:w14="${WORD14_NS}"`
    );
  }
  if (checkboxPlaceholders.length && !/xmlns:w15=/.test(xml)) {
    xml = xml.replace(
      /<w:document\b/,
      `<w:document xmlns:w15="${WORD15_NS}"`
    );
  }
  if (horizontalRulePlaceholders.length && !/xmlns:v=/.test(xml)) {
    xml = xml.replace(/<w:document\b/, `<w:document xmlns:v="${VML_NS}"`);
  }
  if (horizontalRulePlaceholders.length && !/xmlns:o=/.test(xml)) {
    xml = xml.replace(/<w:document\b/, `<w:document xmlns:o="${OFFICE_NS}"`);
  }
  zip.file("word/document.xml", xml);

  const stylesFile = zip.file("word/styles.xml");
  if (stylesFile) {
    const styles = await stylesFile.async("string");
    zip.file(
      "word/styles.xml",
      centerBlockquoteText(
        applyTocTabStops(centerSourceCodeText(styles))
      )
    );
  }

  // 不在打开时自动更新域，避免 Word 弹出刷新提示。目录仍是原生 TOC 域，
  // 点击目录后由 Word 的目录内容控件提供刷新按钮。
  const settingsFile = zip.file("word/settings.xml");
  if (settingsFile) {
    const settings = disableDocumentFieldUpdates(
      await settingsFile.async("string")
    );
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
  return createParagraph(ctx, {
    children: [
      new TextRun({ text: tex, font: CODE_FONTS, color: "666666", size: ctx.code }),
    ],
  });
}

/** 生成下一个目录占位令牌 */
function nextTocToken(ctx: ExportContext): string {
  return `${TOC_TOKEN_PREFIX}_${ctx.tocPlaceholders.length}_`;
}

function nextHorizontalRuleToken(ctx: ExportContext): string {
  return `${HORIZONTAL_RULE_TOKEN_PREFIX}_${ctx.horizontalRulePlaceholders.length}_`;
}

export function buildHorizontalRuleXml(): string {
  return `<w:p><w:r><w:pict><v:rect style="width:0;height:${HORIZONTAL_RULE_HEIGHT}" o:hralign="center" o:hrheight="${HORIZONTAL_RULE_HEIGHT}" o:hrstd="t" o:hr="t"/></w:pict></w:r></w:p>`;
}

/** 登记一个 Word 复选框占位，并返回插入段落中的唯一 token。 */
function nextCheckboxToken(ctx: ExportContext, checked: unknown): string {
  const index = ctx.checkboxPlaceholders.length;
  const token = `${CHECKBOX_TOKEN_PREFIX}_${index}_`;
  ctx.checkboxPlaceholders.push({
    token,
    checked: checked === true,
    id: -100000 - index,
  });
  return token;
}

/** 生成 Word 2010+ 原生复选框内容控件（运行级 w:sdt）。 */
export function buildWordCheckboxXml(checked: boolean, id: number): string {
  const glyph = checked ? "☒" : "☐";
  return `<w:sdt><w:sdtPr><w:id w:val="${id}"/><w15:appearance w15:val="hidden"/><w14:checkbox><w14:checked w14:val="${
    checked ? "1" : "0"
  }"/><w14:checkedState w14:val="2612" w14:font="MS Gothic"/><w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/></w14:checkbox></w:sdtPr><w:sdtEndPr/><w:sdtContent><w:r><w:rPr><w:rFonts w:ascii="MS Gothic" w:eastAsia="MS Gothic" w:hAnsi="MS Gothic" w:hint="eastAsia"/></w:rPr><w:t>${glyph}</w:t></w:r></w:sdtContent></w:sdt>`;
}

/**
 * 把 Source Code 段落中的字符在行盒内垂直居中。
 *
 * Consolas 的上升部和下降部不相等；仅设置相同的 border-space 时，Word 仍会
 * 按字体基线把文字放偏。`w:textAlignment` 是 OOXML 标准属性，直接要求 Word
 * 在行盒中居中整行字符，而不是靠非对称 padding 补偿。
 */
export function centerSourceCodeText(styles: string): string {
  return styles.replace(
    /(<w:style\b[^>]*w:styleId="SourceCode"[^>]*>[\s\S]*?<w:pPr>)([\s\S]*?)(<\/w:pPr>)/,
    (_match, open: string, body: string, close: string) => {
      if (/<w:textAlignment\b/.test(body)) return `${open}${body}${close}`;
      return `${open}${body}<w:textAlignment w:val="center"/>${close}`;
    }
  );
}

/** 引用正文在行盒内垂直居中；行距和段后已独立归零。 */
export function centerBlockquoteText(styles: string): string {
  return styles.replace(
    /(<w:style\b[^>]*w:styleId="BlockText"[^>]*>[\s\S]*?<w:pPr>)([\s\S]*?)(<\/w:pPr>)/,
    (_match, open: string, body: string, close: string) => {
      if (/<w:textAlignment\b/.test(body)) return `${open}${body}${close}`;
      return `${open}${body}<w:textAlignment w:val="center"/>${close}`;
    }
  );
}

/** 给 TOC1–TOC3 样式补 Word 目录所用的右侧点状制表位。 */
export function applyTocTabStops(styles: string): string {
  let next = styles;
  for (let level = 1; level <= 3; level += 1) {
    const re = new RegExp(
      `(<w:style\\b[^>]*w:styleId="TOC${level}"[^>]*>[\\s\\S]*?<w:pPr>)([\\s\\S]*?)(</w:pPr>)`
    );
    next = next.replace(re, (_match, open: string, body: string, close: string) => {
      if (/<w:tabs\b/.test(body)) return `${open}${body}${close}`;
      return (
        `${open}<w:tabs><w:tab w:val="right" w:pos="${PAGE_CONTENT_W}" ` +
        `w:leader="dot"/></w:tabs>${body}${close}`
      );
    });
  }
  return next;
}

/**
 * 构造 Word 原生 TOC 域（按标题样式 1-3 级生成目录，含超链接）。
 * 导出时不扫描标题、不估算页码，也不写入缓存条目；文件中的目录域保持 Word
 * 尚未刷新前的空状态，用户点击内容控件的刷新按钮或按 F9 后由 Word 生成。
 *
 * 注意：TOC 域结果含多段，字段必须跨多段——begin/separate 在首段、end 在末段，
 * 条目段落与字段段落平级（不能把 <w:p> 嵌套进 <w:p>，否则 Word 拒读）。
 */
export function buildTocFieldXml(): string {
  const title =
    `<w:p><w:pPr><w:pStyle w:val="TOC"/></w:pPr>` +
    `<w:r><w:t>目录</w:t></w:r></w:p>`;
  const field =
    `<w:p>` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
    `</w:p>`;
  return (
    `<w:sdt><w:sdtPr><w:docPartObj>` +
    `<w:docPartGallery w:val="Table of Contents"/>` +
    `<w:docPartUnique/>` +
    `</w:docPartObj></w:sdtPr>` +
    `<w:sdtContent>${title + field}</w:sdtContent>` +
    `</w:sdt>`
  );
}

/** 关闭 Word 打开文档时的自动域更新，避免弹出刷新提示。 */
export function disableDocumentFieldUpdates(settings: string): string {
  if (/updateFields/.test(settings)) {
    return settings.replace(
      /<w:updateFields\b[^>]*\/?>/g,
      `<w:updateFields w:val="false"/>`
    );
  }
  return settings.replace(
    /(<w:settings\b[^>]*>)/,
    `$1<w:updateFields w:val="false"/>`
  );
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

/**
 * 按文件头（magic bytes）判断真实图片格式。
 *
 * 为什么不靠 content-type / URL 扩展名：
 * - 图床常返回 application/octet-stream 之类的非标准 content-type；
 * - 跨域或防盗链时返回的其实是 HTML 错误页 / 1x1 图，字节根本不是图片，
 *   而 URL 往往还带着 .png 扩展名 —— 照扩展名判定就会把无效字节塞进
 *   ImageRun，在 Word 里表现为「空白图片」。
 * 以文件头为准，无效内容会被识别出来并降级为占位，而不是产出空白图。
 */
function sniffImageType(data: Uint8Array): { type: ImageType; mime: string } | null {
  const b = data;
  // PNG：89 50 4E 47
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { type: "png", mime: "image/png" };
  }
  // JPEG：FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { type: "jpg", mime: "image/jpeg" };
  }
  // GIF：GIF8
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { type: "gif", mime: "image/gif" };
  }
  // BMP：BM
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) {
    return { type: "bmp", mime: "image/bmp" };
  }
  // WEBP：RIFF????WEBP
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return { type: "webp", mime: "image/webp" };
  }
  // AVIF：ISOBMFF 容器 —— 偏移 4 处是 box type "ftyp"，紧接的 major brand 是
  // "avif"（静态）或 "avis"（序列）。只认这两个 brand，避免把 HEIC/HEIF 的
  // heic、mif1 等误判成 avif（它们浏览器多半也解不了，判 null 更诚实）。
  if (
    b.length >= 12 &&
    b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70
  ) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === "avif" || brand === "avis") return { type: "avif", mime: "image/avif" };
  }
  // SVG 是文本，以 <?xml 或 <svg 开头
  const head = new TextDecoder().decode(b.slice(0, 256)).trimStart();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) {
    return { type: "svg", mime: "image/svg+xml" };
  }
  return null;
}

/** base64 -> 字节 */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** SVG 文本 → docx 可识别的 base64 data URI。 */
function svgDataUri(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
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

/**
 * 把浏览器能解码、但 docx 不支持内嵌的格式（webp / avif 等）转成 png。
 * 思路与 svg 栅格化一致：交给浏览器解码后画到 canvas，再导出 png 字节。
 */
async function rasterToPng(
  data: Uint8Array,
  mime: string
): Promise<{ data: Uint8Array; width: number; height: number } | null> {
  const url = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: mime }));
  try {
    const img = await loadImage(url);
    const width = img.naturalWidth || MAX_IMAGE_WIDTH;
    const height = img.naturalHeight || 320;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const c = canvas.getContext("2d");
    if (!c) return null;
    c.drawImage(img, 0, 0, width, height);
    const blob = await canvasToPng(canvas);
    if (!blob) return null;
    return { data: new Uint8Array(await blob.arrayBuffer()), width, height };
  } catch (err) {
    console.warn("[NoteMark] raster->png failed:", err);
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 转义正则特殊字符 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
