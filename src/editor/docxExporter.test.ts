import JSZip from "jszip";
import { Schema, type Node as PMNode } from "@milkdown/prose/model";
import { describe, expect, it, vi } from "vitest";
import {
  buildDocx,
  buildHorizontalRuleXml,
  buildTocFieldXml,
  buildWordCheckboxXml,
  disableDocumentFieldUpdates,
} from "./docxExporter";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><path d="M10 50 H190" stroke="#333"/><g class="edgeLabel"><rect width="40" height="20" style="fill:#28253D;opacity:0.5"/></g></svg>',
    })),
  },
}));

describe("Word TOC field", () => {
  it("wraps the native TOC field in Word's table-of-contents control", () => {
    const xml = buildTocFieldXml();

    expect(xml).toContain("<w:sdt>");
    expect(xml).toContain(
      '<w:docPartGallery w:val="Table of Contents"/>'
    );
    expect(xml).toContain("<w:docPartUnique/>");
    expect(xml).toContain('<w:fldChar w:fldCharType="begin"/>');
    expect(xml).not.toContain('w:dirty="true"');
    expect(xml).toContain(
      '<w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText>'
    );
    expect(xml).toContain('<w:pStyle w:val="TOC"/>');
    expect(xml).toContain(
      '<w:sdtContent><w:p><w:pPr><w:pStyle w:val="TOC"/>'
    );
    expect(xml).toContain("<w:t>目录</w:t>");
    expect(xml).not.toContain("第一章");
    expect(xml).not.toContain("（右键「更新域」生成目录）");
    expect(xml).toContain('<w:fldChar w:fldCharType="end"/>');
  });

  it("disables automatic field updates when Word opens the document", () => {
    expect(
      disableDocumentFieldUpdates(
        '<w:settings><w:updateFields w:val="true"/></w:settings>'
      )
    ).toContain('<w:updateFields w:val="false"/>');
    expect(
      disableDocumentFieldUpdates("<w:settings></w:settings>")
    ).toContain(
      '<w:settings><w:updateFields w:val="false"/></w:settings>'
    );
  });
});

describe("Word task checkboxes", () => {
  it("builds native Word checkbox content controls", () => {
    const checked = buildWordCheckboxXml(true, -100000);
    const unchecked = buildWordCheckboxXml(false, -100001);

    expect(checked).toContain("<w:sdt>");
    expect(checked).toContain("<w14:checkbox>");
    expect(checked).toContain('<w15:appearance w15:val="hidden"/>');
    expect(checked).toContain('<w14:checked w14:val="1"/>');
    expect(checked).toContain('<w14:checkedState w14:val="2612"');
    expect(checked).toContain("☒");
    expect(unchecked).toContain('<w14:checked w14:val="0"/>');
    expect(unchecked).toContain('<w14:uncheckedState w14:val="2610"');
    expect(unchecked).toContain("☐");
  });

  it("injects clickable checkboxes into the exported document XML", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        bullet_list: {
          group: "block",
          content: "list_item+",
          toDOM: () => ["ul", 0],
        },
        list_item: {
          content: "paragraph+",
          attrs: { checked: { default: null } },
          toDOM: () => ["li", 0],
        },
        paragraph: {
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        text: { group: "inline" },
      },
    });
    const task = (text: string, checked: boolean) =>
      schema.node("list_item", { checked }, [
        schema.node("paragraph", null, schema.text(text)),
      ]);
    const doc = schema.node("doc", null, [
      schema.node("bullet_list", null, [
        task("已完成", true),
        task("未完成", false),
      ]),
    ]);
    const bytes = await buildDocx({ doc, viewDom: null });
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("word/document.xml")!.async("string");

    expect(xml).toContain('xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"');
    expect(xml).toContain(
      'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"'
    );
    expect(xml).toContain('<w15:appearance w15:val="hidden"/>');
    expect(xml).toContain("<w14:checkbox>");
    expect(xml).toContain('<w14:checked w14:val="1"/>');
    expect(xml).toContain('<w14:checked w14:val="0"/>');
    expect(xml).not.toContain("CHKBOXPH");
    expect(xml).not.toContain("[x]");
    expect(xml).not.toContain("[ ]");
  });
});

describe("Word horizontal rules", () => {
  it("uses Pandoc's inline VML HR layout with an explicit thin height", () => {
    const xml = buildHorizontalRuleXml();

    expect(xml).toContain("<v:rect");
    expect(xml).toContain('style="width:0;height:0.5pt"');
    expect(xml).toContain('o:hrheight="0.5pt"');
    expect(xml).toContain('o:hrstd="t"');
    expect(xml).toContain('o:hr="t"');
  });

  it("injects the Pandoc-compatible line-after paragraph structure", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        hr: {
          group: "block",
          atom: true,
          toDOM: () => ["hr"],
        },
        text: { group: "inline" },
      },
    });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("Before")),
      schema.node("hr"),
      schema.node("paragraph", null, schema.text("After")),
    ]);
    const bytes = await buildDocx({ doc, viewDom: null });
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("word/document.xml")!.async("string");

    expect(xml).not.toContain("HRPH");
    expect(xml).toContain('xmlns:v="urn:schemas-microsoft-com:vml"');
    expect(xml).toContain(
      'xmlns:o="urn:schemas-microsoft-com:office:office"'
    );
    expect(xml).toContain("<v:rect");
    expect(xml).toContain('o:hrheight="0.5pt"');
  });
});

describe("Word typography", () => {
  it("uses explicit body, heading, list and code typography", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        heading: {
          group: "block",
          content: "inline*",
          attrs: { level: { default: 1 } },
          toDOM: () => ["h1", 0],
        },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        blockquote: {
          group: "block",
          content: "paragraph+",
          toDOM: () => ["blockquote", 0],
        },
        code_block: {
          group: "block",
          content: "text*",
          toDOM: () => ["pre", 0],
        },
        text: { group: "inline" },
      },
    });
    const doc = schema.node("doc", null, [
      schema.node("heading", { level: 1 }, schema.text("标题")),
      schema.node("paragraph", null, schema.text("正文")),
      schema.node("blockquote", null, [
        schema.node("paragraph", null, schema.text("引用")),
        schema.node("paragraph", null, schema.text("第二段引用")),
        schema.node("paragraph"),
      ]),
      schema.node(
        "code_block",
        null,
        schema.text("const value = 1;\nreturn value;")
      ),
    ]);
    const bytes = await buildDocx({ doc, viewDom: null });
    const zip = await JSZip.loadAsync(bytes);
    const styles = await zip.file("word/styles.xml")!.async("string");
    const documentXml = await zip.file("word/document.xml")!.async("string");

    expect(styles).toContain('w:ascii="Calibri"');
    expect(styles).toContain('w:eastAsia="等线"');
    expect(styles).toContain('w:sz w:val="24"');
    expect(styles).toContain('w:after="120"');
    expect(styles).toContain('w:line="360"');
    expect(styles).toContain('w:lineRule="auto"');
    expect(styles).toContain('w:sz w:val="40"');
    for (let level = 1; level <= 6; level += 1) {
      const headingStyle =
        styles.match(
          new RegExp(
            `<w:style\\b[^>]*w:styleId="Heading${level}"[^>]*>[\\s\\S]*?<\\/w:style>`
          )
        )?.[0] ?? "";
      expect(headingStyle).toContain('w:line="240"');
      expect(headingStyle).toContain('w:lineRule="auto"');
      if (level === 4) {
        expect(headingStyle).toContain('<w:sz w:val="26"/>');
      }
      if (level >= 5) {
        expect(headingStyle).toContain('<w:sz w:val="24"/>');
      }
    }
    const tocHeadingStyle =
      styles.match(
        /<w:style\b[^>]*w:styleId="TOC"[^>]*>[\s\S]*?<\/w:style>/
      )?.[0] ?? "";
    expect(tocHeadingStyle).toContain('<w:basedOn w:val="Heading1"/>');
    expect(tocHeadingStyle).toContain('<w:outlineLvl w:val="9"/>');
    expect(tocHeadingStyle).not.toContain("<w:sz ");
    const toc2Style =
      styles.match(
        /<w:style\b[^>]*w:styleId="TOC2"[^>]*>[\s\S]*?<\/w:style>/
      )?.[0] ?? "";
    expect(styles).toContain('w:styleId="TOC1"');
    expect(styles).toContain('w:styleId="TOC3"');
    expect(toc2Style).toContain('<w:ind w:left="220"/>');
    expect(toc2Style).toContain('<w:tab w:val="right" w:pos="9026" w:leader="dot"/>');
    const blockquoteStyle =
      styles.match(
        /<w:style\b[^>]*w:styleId="BlockText"[^>]*>[\s\S]*?<\/w:style>/
      )?.[0] ?? "";
    expect(blockquoteStyle).toContain('<w:basedOn w:val="BodyText"/>');
    expect(blockquoteStyle).toContain('<w:textAlignment w:val="center"/>');
    expect(blockquoteStyle).toContain('w:color="FFFFFF"');
    expect(blockquoteStyle).toContain('w:sz="16"');
    expect(blockquoteStyle).toContain('w:space="6"');
    expect(blockquoteStyle).toContain('w:after="100"');
    expect(blockquoteStyle).toContain('w:before="100"');
    expect(blockquoteStyle).toContain('w:line="240"');
    expect(blockquoteStyle).toContain('w:left="482"');
    expect(blockquoteStyle).toContain('w:right="482"');
    expect(blockquoteStyle).toContain('w:firstLine="0"');
    expect(blockquoteStyle).toContain('w:firstLineChars="0"');

    expect(styles).toContain('w:styleId="SourceCode"');
    expect(styles).toContain('w:ascii="Consolas"');
    expect(styles).toContain('w:lineRule="auto"');
    expect(styles).toContain('w:fill="F5F5F5"');
    expect(styles).toContain('w:space="6"');
    expect(styles).toContain('w:space="9"');
    const sourceCodeStyle =
      styles.match(
        /<w:style\b[^>]*w:styleId="SourceCode"[^>]*>[\s\S]*?<\/w:style>/
      )?.[0] ?? "";
    expect(sourceCodeStyle).toContain('<w:basedOn w:val="BodyText"/>');
    expect(sourceCodeStyle).toContain(
      '<w:ind w:left="200" w:right="200" w:firstLine="0" w:firstLineChars="0"/>'
    );
    expect(sourceCodeStyle).toContain('w:firstLine="0"');
    expect(sourceCodeStyle).toContain('w:firstLineChars="0"');
    expect(sourceCodeStyle).not.toContain("<w:spacing");
    expect(sourceCodeStyle).toContain('<w:textAlignment w:val="center"/>');
    expect(documentXml).toContain('<w:pStyle w:val="SourceCode"/>');
    expect(documentXml).toContain('<w:wordWrap w:val="0"/>');
    expect(
      documentXml.match(/<w:pStyle w:val="BlockText"\/>/g)
    ).toHaveLength(1);
    expect(documentXml.match(/<w:br\/>/g)).toHaveLength(2);
    expect(documentXml).toContain("<w:br/>");
    expect(documentXml).not.toContain("<w:tbl>");
  });

  it("keeps consecutive blockquotes in one continuous border group", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        blockquote: {
          group: "block",
          content: "paragraph+",
          toDOM: () => ["blockquote", 0],
        },
      },
    });
    const doc = schema.node("doc", null, [
      schema.node("blockquote", null, [
        schema.node("paragraph", null, schema.text("First quote")),
      ]),
      schema.node("blockquote", null, [
        schema.node("paragraph", null, schema.text("Second quote")),
      ]),
      schema.node("blockquote", null, [
        schema.node("paragraph", null, schema.text("Third quote")),
      ]),
    ]);
    const bytes = await buildDocx({ doc, viewDom: null });
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");

    expect(
      documentXml.match(/<w:pStyle w:val="BlockText"\/>/g)
    ).toHaveLength(3);
    expect(documentXml).not.toContain("<w:pBdr>");
    expect(documentXml).not.toContain('w:color="FFFFFF"');
    expect(documentXml).not.toContain('w:after="400"');
  });

  it("preserves nested blockquote levels with increasing Word indentation", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        blockquote: {
          group: "block",
          content: "(paragraph | blockquote)+",
          toDOM: () => ["blockquote", 0],
        },
      },
    });
    const doc = schema.node("doc", null, [
      schema.node("blockquote", null, [
        schema.node("paragraph", null, schema.text("Level one")),
        schema.node("blockquote", null, [
          schema.node("paragraph", null, schema.text("Level two")),
          schema.node("blockquote", null, [
            schema.node("paragraph", null, schema.text("Level three")),
          ]),
        ]),
      ]),
    ]);
    const bytes = await buildDocx({ doc, viewDom: null });
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");

    expect(
      documentXml.match(/<w:pStyle w:val="BlockText"\/>/g)
    ).toHaveLength(3);
    expect(documentXml).toContain(
      '<w:tab w:val="left" w:pos="722"/>'
    );
    expect(documentXml).toContain(
      '<w:tab w:val="left" w:pos="962"/>'
    );
    expect(documentXml.match(/<w:tab\/>/g)).toHaveLength(2);
  });
});

describe("Word alerts", () => {
  it("exports paragraph-only alerts as one border-only paragraph", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        alert: {
          group: "block",
          content: "block+",
          attrs: {
            alertType: { default: "note" },
            title: { default: "" },
          },
          toDOM: () => ["blockquote", 0],
        },
      },
    });
    const doc = schema.node("doc", null, [
      schema.node(
        "alert",
        { alertType: "warning", title: "发布前检查" },
        [
          schema.node("paragraph", null, schema.text("正文第一段")),
          schema.node("paragraph", null, schema.text("正文第二段")),
        ]
      ),
    ]);
    const bytes = await buildDocx({ doc, viewDom: null });
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");

    expect(documentXml).toContain("WARNING  发布前检查");
    expect(documentXml).toContain("正文第一段");
    expect(documentXml).toContain("正文第二段");
    expect(documentXml.match(/<w:p>/g)).toHaveLength(1);
    expect(documentXml.match(/<w:pBdr>/g)).toHaveLength(1);
    expect(documentXml.match(/<w:br\/>/g)).toHaveLength(2);
    expect(documentXml).toContain(
      'w:val="single" w:color="9A6700" w:sz="16" w:space="6"'
    );
    expect(documentXml).not.toContain("<w:keepNext/>");
    expect(documentXml).toContain(
      'w:after="100" w:before="100" w:line="240" w:lineRule="auto"'
    );
    expect(documentXml).not.toContain("<w:tbl>");
    expect(documentXml).not.toContain("<w:shd");
  });

  it("keeps paragraph-only alerts to one two-line paragraph with 5pt after", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        alert: {
          group: "block",
          content: "block+",
          attrs: {
            alertType: { default: "note" },
            title: { default: "" },
          },
          toDOM: () => ["blockquote", 0],
        },
      },
    });
    const doc = schema.node("doc", null, [
      schema.node("alert", { alertType: "note" }, [
        schema.node("paragraph", null, schema.text("First alert")),
      ]),
      schema.node("alert", { alertType: "tip" }, [
        schema.node("paragraph", null, schema.text("Second alert")),
      ]),
    ]);
    const bytes = await buildDocx({ doc, viewDom: null });
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");

    expect(documentXml.match(/<w:p>/g)).toHaveLength(2);
    expect(documentXml.match(/<w:pBdr>/g)).toHaveLength(2);
    expect(documentXml.match(/<w:br\/>/g)).toHaveLength(2);
    expect(documentXml).not.toContain(
      '<w:bottom w:val="single" w:color="FFFFFF"'
    );
    expect(documentXml).not.toContain("<w:keepNext/>");
    expect(
      documentXml.match(/<w:spacing w:after="100" w:before="100"/g)
    ).toHaveLength(2);
    expect(
      documentXml.match(/<w:spacing w:after="360" w:before="100"/g)
    ).toBeNull();
    expect(documentXml).not.toContain('w:lineRule="exact"');
  });
});

describe("Word table alignment", () => {
  it("maps every GFM cell alignment to the Word paragraph", async () => {
    const cellAttrs = {
      alignment: { default: "left" },
      colwidth: { default: null },
    };
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        table: {
          group: "block",
          content: "table_header_row table_row+",
          toDOM: () => ["table", 0],
        },
        table_header_row: {
          content: "(table_header)*",
          toDOM: () => ["tr", 0],
        },
        table_row: {
          content: "(table_cell)*",
          toDOM: () => ["tr", 0],
        },
        table_header: {
          content: "paragraph",
          attrs: cellAttrs,
          toDOM: () => ["th", 0],
        },
        table_cell: {
          content: "paragraph",
          attrs: cellAttrs,
          toDOM: () => ["td", 0],
        },
      },
    });
    const cell = (
      type: "table_header" | "table_cell",
      text: string,
      alignment: string,
      colwidth: number | null = null
    ) =>
      schema.node(
        type,
        { alignment, colwidth: colwidth ? [colwidth] : null },
        schema.node("paragraph", null, schema.text(text))
      );
    const doc = schema.node("doc", null, [
      schema.node("table", null, [
        schema.node("table_header_row", null, [
          cell("table_header", "左", "left"),
          cell("table_header", "中", "center"),
          cell("table_header", "右", "right"),
        ]),
        schema.node("table_row", null, [
          cell("table_cell", "正文左", "left"),
          cell("table_cell", "正文中", "center"),
          cell("table_cell", "正文右", "right"),
        ]),
      ]),
    ]);
    const bytes = await buildDocx({ doc, viewDom: null });
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");
    const stylesXml = await zip.file("word/styles.xml")!.async("string");

    expect(documentXml).toContain("<w:tbl>");
    expect(documentXml).toContain('<w:tblW w:type="auto" w:w="0"/>');
    expect(documentXml).not.toContain("<w:tblLayout");
    expect(documentXml).not.toContain("<w:tcW");
    expect(documentXml).toContain(
      '<w:tblCellMar><w:top w:type="dxa" w:w="0"/><w:left w:type="dxa" w:w="108"/><w:bottom w:type="dxa" w:w="0"/><w:right w:type="dxa" w:w="108"/></w:tblCellMar>'
    );
    expect(
      documentXml.match(/<w:pStyle w:val="Compact"\/>/g)
    ).toHaveLength(6);
    const tableCellStyle =
      stylesXml.match(
        /<w:style\b[^>]*w:styleId="Compact"[^>]*>[\s\S]*?<\/w:style>/
      )?.[0] ?? "";
    expect(tableCellStyle).toContain('<w:basedOn w:val="BodyText"/>');
    expect(tableCellStyle).toContain(
      '<w:spacing w:after="36" w:before="36" w:line="240" w:lineRule="auto"/>'
    );
    expect(tableCellStyle).toContain('w:firstLine="0"');
    expect(tableCellStyle).toContain('w:firstLineChars="0"');
    expect(documentXml.match(/<w:jc w:val="left"\/>/g)).toHaveLength(2);
    expect(documentXml.match(/<w:jc w:val="center"\/>/g)).toHaveLength(2);
    expect(documentXml.match(/<w:jc w:val="right"\/>/g)).toHaveLength(2);
  });

  it("uses explicit ProseMirror column widths when all columns provide them", async () => {
    const cellAttrs = {
      alignment: { default: "left" },
      colwidth: { default: null },
    };
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        table: {
          group: "block",
          content: "table_header_row table_row+",
          toDOM: () => ["table", 0],
        },
        table_header_row: {
          content: "(table_header)*",
          toDOM: () => ["tr", 0],
        },
        table_row: {
          content: "(table_cell)*",
          toDOM: () => ["tr", 0],
        },
        table_header: {
          content: "paragraph",
          attrs: cellAttrs,
          toDOM: () => ["th", 0],
        },
        table_cell: {
          content: "paragraph",
          attrs: cellAttrs,
          toDOM: () => ["td", 0],
        },
      },
    });
    const cell = (
      type: "table_header" | "table_cell",
      text: string,
      colwidth: number
    ) =>
      schema.node(
        type,
        { alignment: "left", colwidth: [colwidth] },
        schema.node("paragraph", null, schema.text(text))
      );
    const doc = schema.node("doc", null, [
      schema.node("table", null, [
        schema.node("table_header_row", null, [
          cell("table_header", "短", 200),
          cell("table_header", "长", 600),
        ]),
        schema.node("table_row", null, [
          cell("table_cell", "A", 200),
          cell("table_cell", "B", 600),
        ]),
      ]),
    ]);
    const bytes = await buildDocx({ doc, viewDom: null });
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");

    expect(documentXml).toContain('<w:tblW w:type="pct" w:w="100%"/>');
    expect(documentXml).toContain('<w:tblLayout w:type="fixed"/>');
    expect(documentXml).toContain('<w:gridCol w:w="2256"/>');
    expect(documentXml).toContain('<w:gridCol w:w="6770"/>');
    expect(
      documentXml.match(/<w:tcW w:type="dxa" w:w="2256"\/>/g)
    ).toHaveLength(2);
    expect(
      documentXml.match(/<w:tcW w:type="dxa" w:w="6770"\/>/g)
    ).toHaveLength(2);
  });
});

describe("Word Pandoc semantic styles", () => {
  it("uses the reference hyperlink style without an underline", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
      },
      marks: {
        link: {
          attrs: { href: { default: "" } },
          toDOM: () => ["a", 0],
        },
      },
    });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("示例链接", [
          schema.marks.link.create({ href: "https://example.com" }),
        ]),
      ]),
    ]);
    const bytes = await buildDocx({ doc, viewDom: null });
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");
    const stylesXml = await zip.file("word/styles.xml")!.async("string");
    const hyperlinkStyle =
      stylesXml.match(
        /<w:style\b[^>]*w:styleId="Hyperlink"[^>]*>[\s\S]*?<\/w:style>/
      )?.[0] ?? "";

    expect(documentXml).toContain('<w:rStyle w:val="Hyperlink"/>');
    expect(hyperlinkStyle).toContain('<w:color w:val="156082"/>');
    expect(hyperlinkStyle).toContain('<w:u w:val="none"/>');
  });

  it("exports YAML abstracts with Pandoc abstract styles", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        yaml: {
          group: "block",
          atom: true,
          attrs: { value: { default: "" } },
          toDOM: () => ["div"],
        },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
      },
    });
    const doc = schema.node("doc", null, [
      schema.node("yaml", {
        value:
          "title: 不改标题\nabstract-title: 摘要\nabstract: |\n  第一段摘要。\n\n  第二段摘要。",
      }),
      schema.node("paragraph", null, schema.text("正文")),
    ]);
    const bytes = await buildDocx({ doc, viewDom: null });
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");

    expect(documentXml).toContain('<w:pStyle w:val="AbstractTitle"/>');
    expect(documentXml).toContain('<w:pStyle w:val="Abstract"/>');
    expect(documentXml).toContain("第一段摘要。");
    expect(documentXml).toContain("第二段摘要。");
    expect(documentXml).toContain('<w:pStyle w:val="FirstParagraph"/>');
    expect(documentXml).not.toContain("不改标题");
  });

  it("exports standalone images with Pandoc figure and caption semantics", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        image: {
          group: "inline",
          inline: true,
          atom: true,
          attrs: {
            src: { default: "" },
            alt: { default: "" },
            title: { default: "" },
          },
          toDOM: () => ["img"],
        },
      },
    });
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2lS8AAAAASUVORK5CYII=";
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.node("image", {
          src: png,
          alt: "图片说明",
          title: "图片标题",
        }),
      ]),
    ]);
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 1;
        naturalHeight = 1;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;

        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      }
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:notemark-image");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const bytes = await buildDocx({ doc, viewDom: null });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");
    const stylesXml = await zip.file("word/styles.xml")!.async("string");
    const imageCaptionStyle =
      stylesXml.match(
        /<w:style\b[^>]*w:styleId="ImageCaption"[^>]*>[\s\S]*?<\/w:style>/
      )?.[0] ?? "";

    expect(documentXml).toContain('<w:pStyle w:val="CaptionedFigure"/>');
    expect(documentXml).toContain('<w:pStyle w:val="ImageCaption"/>');
    expect(documentXml).toContain('<w:t xml:space="preserve">图片说明</w:t>');
    expect(documentXml).toMatch(
      /<wp:docPr[^>]*descr="图片说明"[^>]*title="图片标题"/
    );
    expect(imageCaptionStyle).toContain('<w:basedOn w:val="Caption"/>');
    expect(imageCaptionStyle).toContain("<w:vanish/>");
  });

  it("maps Pandoc table captions and HTML definition lists", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        table: {
          group: "block",
          content: "table_header_row table_row+",
          toDOM: () => ["table", 0],
        },
        table_header_row: {
          content: "(table_header)*",
          toDOM: () => ["tr", 0],
        },
        table_row: {
          content: "(table_cell)*",
          toDOM: () => ["tr", 0],
        },
        table_header: {
          content: "paragraph",
          toDOM: () => ["th", 0],
        },
        table_cell: {
          content: "paragraph",
          toDOM: () => ["td", 0],
        },
        htmlBlock: {
          group: "block",
          atom: true,
          attrs: { value: { default: "" } },
          toDOM: () => ["div"],
        },
      },
    });
    const cell = (
      type: "table_header" | "table_cell",
      value: string
    ) =>
      schema.node(type, null, [
        schema.node("paragraph", null, schema.text(value)),
      ]);
    const doc = schema.node("doc", null, [
      schema.node("table", null, [
        schema.node("table_header_row", null, [
          cell("table_header", "列"),
        ]),
        schema.node("table_row", null, [cell("table_cell", "值")]),
      ]),
      schema.node("paragraph", null, schema.text(": 表格说明")),
      schema.node("htmlBlock", {
        value: "<dl><dt>术语</dt><dd>定义内容</dd></dl>",
      }),
    ]);
    const bytes = await buildDocx({ doc, viewDom: null });
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");
    const stylesXml = await zip.file("word/styles.xml")!.async("string");
    const tableCaptionStyle =
      stylesXml.match(
        /<w:style\b[^>]*w:styleId="TableCaption"[^>]*>[\s\S]*?<\/w:style>/
      )?.[0] ?? "";
    const definitionTermStyle =
      stylesXml.match(
        /<w:style\b[^>]*w:styleId="DefinitionTerm"[^>]*>[\s\S]*?<\/w:style>/
      )?.[0] ?? "";

    expect(documentXml).toContain('<w:pStyle w:val="TableCaption"/>');
    expect(documentXml).toContain("表格说明");
    expect(documentXml).toContain('<w:pStyle w:val="DefinitionTerm"/>');
    expect(documentXml).toContain('<w:pStyle w:val="Definition"/>');
    expect(documentXml).toContain("术语");
    expect(documentXml).toContain("定义内容");
    expect(tableCaptionStyle).toContain('<w:basedOn w:val="Caption"/>');
    expect(tableCaptionStyle).toContain("<w:keepNext/>");
    expect(definitionTermStyle).toContain('<w:basedOn w:val="Normal"/>');
    expect(definitionTermStyle).toContain("<w:b/>");
  });
});

describe("Word Mermaid diagrams", () => {
  it("embeds SVG as the primary image with a PNG compatibility fallback", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        diagram: {
          group: "block",
          atom: true,
          attrs: {
            value: { default: "" },
            identity: { default: "" },
          },
          toDOM: () => ["div"],
        },
      },
    });
    const doc = schema.node("doc", null, [
      schema.node("diagram", {
        value: "flowchart LR\nA --> B",
        identity: "diagram-test",
      }),
    ]);
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 200;
        naturalHeight = 100;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;

        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      }
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mermaid");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => ({ drawImage: vi.fn() })),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
      configurable: true,
      value: vi.fn((callback: BlobCallback) => {
        callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
      }),
    });

    try {
      const bytes = await buildDocx({ doc, viewDom: null });
      const zip = await JSZip.loadAsync(bytes);
      const documentXml = await zip.file("word/document.xml")!.async("string");
      const media = Object.keys(zip.files).filter((name) =>
        name.startsWith("word/media/")
      );

      expect(media.some((name) => name.endsWith(".svg"))).toBe(true);
      expect(media.some((name) => name.endsWith(".png"))).toBe(true);
      expect(documentXml).toContain("<asvg:svgBlip");
      const svgName = media.find((name) => name.endsWith(".svg"));
      expect(svgName).toBeTruthy();
      const svg = await zip.file(svgName!)!.async("string");
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      const edgeLabelBackground = parsed.querySelector(".edgeLabel rect");
      expect(edgeLabelBackground?.getAttribute("fill")).toBe("#ffffff");
      expect(edgeLabelBackground?.getAttribute("opacity")).toBe("1");

      const viewDom = document.createElement("div");
      viewDom.innerHTML =
        '<div class="diagram" data-diagram-id="diagram-test" style="--mt-color-bg:#fefefe">' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">' +
        '<g class="edgeLabel"><rect width="40" height="20" style="fill:#28253D;opacity:0.5"/></g>' +
        "</svg></div>";
      const viewBytes = await buildDocx({ doc, viewDom });
      const viewZip = await JSZip.loadAsync(viewBytes);
      const viewSvgName = Object.keys(viewZip.files).find(
        (name) => name.startsWith("word/media/") && name.endsWith(".svg")
      );
      expect(viewSvgName).toBeTruthy();
      const viewSvg = await viewZip.file(viewSvgName!)!.async("string");
      const viewParsed = new DOMParser().parseFromString(
        viewSvg,
        "image/svg+xml"
      );
      const viewEdgeLabelBackground =
        viewParsed.querySelector(".edgeLabel rect");
      expect(viewEdgeLabelBackground?.getAttribute("fill")).toBe("#fefefe");
      expect(viewEdgeLabelBackground?.getAttribute("opacity")).toBe("1");
    } finally {
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        configurable: true,
        value: originalGetContext,
      });
      Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
        configurable: true,
        value: originalToBlob,
      });
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("renders a mermaid fenced code block as an image", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        code_block: {
          group: "block",
          content: "text*",
          attrs: { language: { default: "" } },
          toDOM: () => ["pre", 0],
        },
      },
    });
    const doc = schema.node("doc", null, [
      schema.node(
        "code_block",
        { language: "mermaid" },
        schema.text("flowchart LR\nA --> B")
      ),
    ]);
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 200;
        naturalHeight = 100;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;

        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      }
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mermaid");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => ({ drawImage: vi.fn() })),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
      configurable: true,
      value: vi.fn((callback: BlobCallback) => {
        callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
      }),
    });

    try {
      const bytes = await buildDocx({ doc, viewDom: null });
      const zip = await JSZip.loadAsync(bytes);
      const documentXml = await zip.file("word/document.xml")!.async("string");
      const media = Object.keys(zip.files).filter((name) =>
        name.startsWith("word/media/")
      );

      expect(media.some((name) => name.endsWith(".svg"))).toBe(true);
      expect(media.some((name) => name.endsWith(".png"))).toBe(true);
      expect(documentXml).toContain("<asvg:svgBlip");
      expect(documentXml).not.toContain("flowchart LR");
    } finally {
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        configurable: true,
        value: originalGetContext,
      });
      Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
        configurable: true,
        value: originalToBlob,
      });
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("reuses the themed preview SVG for a Mermaid code block", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        code_block: {
          group: "block",
          content: "text*",
          attrs: { language: { default: "" } },
          toDOM: () => ["pre", 0],
        },
      },
    });
    const doc = schema.node("doc", null, [
      schema.node(
        "code_block",
        { language: "mermaid" },
        schema.text("flowchart LR\nA --> B")
      ),
    ]);
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 200;
        naturalHeight = 100;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;

        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      }
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mermaid");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => ({ drawImage: vi.fn() })),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
      configurable: true,
      value: vi.fn((callback: BlobCallback) => {
        callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
      }),
    });

    const viewDom = document.createElement("div");
    viewDom.innerHTML =
      '<div class="milkdown-code-block mermaid-code-block" style="--mt-color-bg:#112233">' +
      '<div class="diagram mermaid-preview">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">' +
      '<path d="M10 50 H190" stroke="#abcdef"/>' +
      '<g class="edgeLabel"><rect width="40" height="20" style="fill:#28253D;opacity:0.5"/></g>' +
      "</svg></div></div>";

    try {
      const bytes = await buildDocx({ doc, viewDom });
      const zip = await JSZip.loadAsync(bytes);
      const svgName = Object.keys(zip.files).find(
        (name) => name.startsWith("word/media/") && name.endsWith(".svg")
      );
      expect(svgName).toBeDefined();
      const svg = await zip.file(svgName!)!.async("string");
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      expect(parsed.querySelector('path[stroke="#abcdef"]')).not.toBeNull();
      const edgeLabel = parsed.querySelector(".edgeLabel rect");
      expect(edgeLabel?.getAttribute("fill")).toBe("#112233");
      expect(edgeLabel?.getAttribute("opacity")).toBe("1");
    } finally {
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        configurable: true,
        value: originalGetContext,
      });
      Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
        configurable: true,
        value: originalToBlob,
      });
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("reuses the rendered SVG for a Markmap code block", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        text: { group: "inline" },
        code_block: {
          group: "block",
          content: "text*",
          marks: "",
          code: true,
          defining: true,
          attrs: { language: { default: "" } },
          toDOM: () => ["pre", 0],
        },
      },
    });
    const doc = schema.node("doc", null, [
      schema.node(
        "code_block",
        { language: "markmap" },
        schema.text("# Linux\n- Systemd")
      ),
    ]);
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 200;
        naturalHeight = 100;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;

        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      }
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:markmap");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => ({ drawImage: vi.fn() })),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
      configurable: true,
      value: vi.fn((callback: BlobCallback) => {
        callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
      }),
    });

    const viewDom = document.createElement("div");
    viewDom.innerHTML =
      '<div class="milkdown-code-block diagram-code-block markmap-code-block">' +
      '<div class="diagram markmap-preview">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="2000" viewBox="0 0 400 2000">' +
      '<style>.markmap{--mm-text:#112233;--mm-branch-0:#abcdef;}</style>' +
      '<text x="10" y="20" style="fill:var(--mm-text)">Linux</text>' +
      '<path d="M10 50 H190" style="fill:none;stroke:var(--mm-branch-0);stroke-width:4"/>' +
      "</svg></div></div>";

    try {
      const bytes = await buildDocx({ doc, viewDom });
      const zip = await JSZip.loadAsync(bytes);
      const documentXml = await zip
        .file("word/document.xml")!
        .async("string");
      const svgName = Object.keys(zip.files).find(
        (name) => name.startsWith("word/media/") && name.endsWith(".svg")
      );
      expect(svgName).toBeDefined();
      const svg = await zip.file(svgName!)!.async("string");
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      expect(parsed.querySelector("text")?.textContent).toBe("Linux");
      expect(parsed.querySelector("path")?.getAttribute("style")).toContain(
        "stroke:#abcdef"
      );
      expect(svg).not.toContain("var(--mm-");
      expect(parsed.querySelector('svg > rect[fill="#ffffff"]')).not.toBeNull();
      const extent = documentXml.match(
        /<wp:extent cx="(\d+)" cy="(\d+)"\/>/
      );
      expect(Number(extent?.[1])).toBe(130 * 9525);
      expect(Number(extent?.[2])).toBe(651 * 9525);
    } finally {
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        configurable: true,
        value: originalGetContext,
      });
      Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
        configurable: true,
        value: originalToBlob,
      });
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("keeps figure spacing after a table", async () => {
    const cellAttrs = {
      alignment: { default: "left" },
      colwidth: { default: null },
    };
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        table: {
          group: "block",
          content: "table_header_row table_row+",
          toDOM: () => ["table", 0],
        },
        table_header_row: {
          content: "(table_header)*",
          toDOM: () => ["tr", 0],
        },
        table_row: {
          content: "(table_cell)*",
          toDOM: () => ["tr", 0],
        },
        table_header: {
          content: "paragraph",
          attrs: cellAttrs,
          toDOM: () => ["th", 0],
        },
        table_cell: {
          content: "paragraph",
          attrs: cellAttrs,
          toDOM: () => ["td", 0],
        },
        code_block: {
          group: "block",
          content: "text*",
          attrs: { language: { default: "" } },
          toDOM: () => ["pre", 0],
        },
      },
    });
    const cell = (type: "table_header" | "table_cell", text: string) =>
      schema.node(
        type,
        { alignment: "left", colwidth: null },
        schema.node("paragraph", null, schema.text(text))
      );
    const doc = schema.node("doc", null, [
      schema.node("table", null, [
        schema.node("table_header_row", null, [
          cell("table_header", "列"),
        ]),
        schema.node("table_row", null, [cell("table_cell", "值")]),
      ]),
      schema.node(
        "code_block",
        { language: "mermaid" },
        schema.text("flowchart LR\nA --> B")
      ),
    ]);

    const viewDom = document.createElement("div");
    viewDom.innerHTML =
      '<div class="milkdown-code-block diagram-code-block mermaid-code-block">' +
      '<div class="diagram mermaid-preview">' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">' +
      '<path d="M10 50 H190" stroke="#333"/>' +
      "</svg></div></div>";
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 200;
        naturalHeight = 100;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      }
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:table-figure");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => ({ drawImage: vi.fn() })),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
      configurable: true,
      value: vi.fn((callback: BlobCallback) => {
        callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
      }),
    });

    try {
      const bytes = await buildDocx({ doc, viewDom });
      const zip = await JSZip.loadAsync(bytes);
      const documentXml = await zip
        .file("word/document.xml")!
        .async("string");
      const stylesXml = await zip.file("word/styles.xml")!.async("string");
      const figureStyle =
        stylesXml.match(
          /<w:style\b[^>]*w:styleId="Figure"[^>]*>[\s\S]*?<\/w:style>/
        )?.[0] ?? "";

      expect(figureStyle).toContain(
        '<w:spacing w:after="180" w:before="180"/>'
      );
      expect(documentXml.indexOf("<w:tbl>")).toBeLessThan(
        documentXml.indexOf('<w:pStyle w:val="Figure"/>')
      );
    } finally {
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        configurable: true,
        value: originalGetContext,
      });
      Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
        configurable: true,
        value: originalToBlob,
      });
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});

describe("Word footnotes", () => {
  it("exports native footnotes with Pandoc footnote and block text styles", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        blockquote: {
          group: "block",
          content: "paragraph+",
          toDOM: () => ["blockquote", 0],
        },
        footnote_reference: {
          group: "inline",
          inline: true,
          atom: true,
          attrs: { label: { default: "" } },
          toDOM: () => ["sup", 0],
        },
        footnote_definition: {
          group: "block",
          content: "block+",
          attrs: { label: { default: "" } },
          toDOM: () => ["dl", 0],
        },
      },
    });
    const paragraph = (...children: PMNode[]) =>
      schema.node("paragraph", null, children);
    const text = (value: string) => schema.text(value);
    const reference = (label: string) =>
      schema.node("footnote_reference", { label });
    const definition = (label: string, blocks: ReturnType<typeof paragraph>[]) =>
      schema.node("footnote_definition", { label }, blocks);
    const doc = schema.node("doc", null, [
      paragraph(text("正文"), reference("first"), text(" 未定义 "), reference("missing")),
      definition("first", [paragraph(text("普通脚注"))]),
      paragraph(
        text("重复引用"),
        reference("first"),
        text("和块级脚注"),
        reference("blocks")
      ),
      definition("blocks", [
        paragraph(text("脚注第一段")),
        schema.node("blockquote", null, [paragraph(text("脚注引用"))]),
        paragraph(text("脚注末段")),
      ]),
      definition("orphan", [paragraph(text("孤立定义仍保留"))]),
    ]);
    const bytes = await buildDocx({ doc, viewDom: null });
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");
    const footnotesXml = await zip.file("word/footnotes.xml")!.async("string");
    const stylesXml = await zip.file("word/styles.xml")!.async("string");
    const footnoteBlockStyle =
      stylesXml.match(
        /<w:style\b[^>]*w:styleId="FootnoteBlockText"[^>]*>[\s\S]*?<\/w:style>/
      )?.[0] ?? "";
    const footnoteTextStyle =
      stylesXml.match(
        /<w:style\b[^>]*w:styleId="FootnoteText"[^>]*>[\s\S]*?<\/w:style>/
      )?.[0] ?? "";

    expect(documentXml.match(/<w:footnoteReference w:id="\d+"\/>/g)).toHaveLength(3);
    expect(documentXml).toContain("[^missing]");
    expect(documentXml).toContain("孤立定义仍保留");
    expect(documentXml).not.toContain("普通脚注");
    expect(documentXml).not.toContain("脚注第一段");
    expect(documentXml).not.toContain("脚注引用");
    expect(documentXml).not.toContain("脚注末段");

    expect(footnotesXml.match(/<w:footnote w:id="[1-9]\d*">/g)).toHaveLength(3);
    expect(footnotesXml.match(/<w:pStyle w:val="FootnoteText"\/>/g)).toHaveLength(4);
    expect(footnotesXml.match(/<w:pStyle w:val="FootnoteBlockText"\/>/g)).toHaveLength(1);
    expect(footnotesXml).toContain('w:rStyle w:val="FootnoteReference"');
    expect(footnotesXml).not.toContain("孤立定义仍保留");

    expect(footnoteTextStyle).toContain('<w:basedOn w:val="Normal"/>');
    expect(footnoteTextStyle).toContain(
      '<w:spacing w:after="200" w:before="0" w:line="240" w:lineRule="auto"/>'
    );
    expect(footnoteBlockStyle).toContain('<w:basedOn w:val="FootnoteText"/>');
    expect(footnoteBlockStyle).toContain(
      '<w:spacing w:after="100" w:before="100" w:line="240" w:lineRule="auto"/>'
    );
    expect(footnoteBlockStyle).toContain(
      '<w:ind w:left="480" w:right="480" w:firstLine="0" w:firstLineChars="0"/>'
    );
  });
});

describe("Word body paragraph styles", () => {
  it("uses First Paragraph at document and section starts, then Body Text", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        heading: {
          group: "block",
          content: "inline*",
          attrs: { level: { default: 1 } },
          toDOM: () => ["h1", 0],
        },
      },
    });
    const paragraph = (text: string) =>
      schema.node("paragraph", null, schema.text(text));
    const doc = schema.node("doc", null, [
      paragraph("首段"),
      paragraph("第二段"),
      schema.node("heading", { level: 1 }, schema.text("标题")),
      paragraph("标题后首段"),
      paragraph("标题后第二段"),
    ]);
    const bytes = await buildDocx({ doc, viewDom: null });
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");
    const stylesXml = await zip.file("word/styles.xml")!.async("string");
    const paragraphStyles = [
      ...documentXml.matchAll(/<w:pStyle w:val="([^"]+)"\/>/g),
    ].map((match) => match[1]);

    expect(paragraphStyles).toEqual([
      "FirstParagraph",
      "BodyText",
      "Heading1",
      "FirstParagraph",
      "BodyText",
    ]);
    expect(stylesXml).toContain(
      '<w:style w:type="paragraph" w:styleId="BodyText">'
    );
    const bodyTextStyle =
      stylesXml.match(
        /<w:style\b[^>]*w:styleId="BodyText"[^>]*>[\s\S]*?<\/w:style>/
      )?.[0] ?? "";
    expect(bodyTextStyle).toContain(
      '<w:spacing w:after="180" w:before="180" w:line="240" w:lineRule="auto"/>'
    );
    expect(bodyTextStyle).not.toContain("<w:ind");
    expect(stylesXml).toContain(
      '<w:style w:type="paragraph" w:styleId="FirstParagraph">'
    );
    expect(stylesXml).toContain(
      '<w:basedOn w:val="BodyText"/><w:next w:val="BodyText"/>'
    );
  });
});

describe("Word list paragraph styles", () => {
  it("uses Compact for tight lists and body styles for loose lists", async () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        text: { group: "inline" },
        paragraph: {
          group: "block",
          content: "inline*",
          toDOM: () => ["p", 0],
        },
        bullet_list: {
          group: "block",
          content: "list_item+",
          toDOM: () => ["ul", 0],
        },
        list_item: {
          content: "paragraph+",
          attrs: { spread: { default: true } },
          toDOM: () => ["li", 0],
        },
      },
    });
    const paragraph = (text: string) =>
      schema.node("paragraph", null, schema.text(text));
    const item = (text: string, spread: boolean) =>
      schema.node("list_item", { spread }, paragraph(text));
    const list = (spread: boolean) =>
      schema.node("bullet_list", null, [
        item("一", spread),
        item("二", spread),
      ]);
    const doc = schema.node("doc", null, [list(false), list(true)]);
    const bytes = await buildDocx({ doc, viewDom: null });
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = await zip.file("word/document.xml")!.async("string");
    const paragraphStyles = [
      ...documentXml.matchAll(/<w:pStyle w:val="([^"]+)"\/>/g),
    ].map((match) => match[1]);

    expect(paragraphStyles).toEqual([
      "Compact",
      "Compact",
      "FirstParagraph",
      "FirstParagraph",
    ]);
  });
});
