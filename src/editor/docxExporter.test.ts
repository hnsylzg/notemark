import JSZip from "jszip";
import { Schema } from "@milkdown/prose/model";
import { describe, expect, it } from "vitest";
import {
  buildDocx,
  buildHorizontalRuleXml,
  buildTocFieldXml,
  buildWordCheckboxXml,
  disableDocumentFieldUpdates,
} from "./docxExporter";

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
        /<w:style\b[^>]*w:styleId="Blockquote"[^>]*>[\s\S]*?<\/w:style>/
      )?.[0] ?? "";
    expect(blockquoteStyle).toContain('<w:textAlignment w:val="center"/>');
    expect(blockquoteStyle).toContain('w:color="FFFFFF"');
    expect(blockquoteStyle).toContain('w:space="6"');
    expect(blockquoteStyle).toContain('w:after="0"');
    expect(blockquoteStyle).toContain('w:line="240"');

    expect(styles).toContain('w:styleId="SourceCode"');
    expect(styles).toContain('w:ascii="Consolas"');
    expect(styles).toContain('w:line="320"');
    expect(styles).toContain('w:lineRule="auto"');
    expect(styles).toContain('w:fill="F5F5F5"');
    expect(styles).toContain('w:space="6"');
    expect(styles).toContain('w:space="9"');
    const sourceCodeStyle =
      styles.match(
        /<w:style\b[^>]*w:styleId="SourceCode"[^>]*>[\s\S]*?<\/w:style>/
      )?.[0] ?? "";
    expect(sourceCodeStyle).toContain('<w:ind w:left="200" w:right="200"/>');
    expect(styles).toContain('<w:textAlignment w:val="center"/>');
    expect(documentXml).toContain('<w:pStyle w:val="SourceCode"/>');
    expect(
      documentXml.match(/<w:pStyle w:val="Blockquote"\/>/g)
    ).toHaveLength(1);
    expect(documentXml.match(/<w:br\/>/g)).toHaveLength(2);
    expect(documentXml).toContain("<w:br/>");
    expect(documentXml).not.toContain("<w:tbl>");
  });
});

describe("Word table alignment", () => {
  it("maps every GFM cell alignment to the Word paragraph", async () => {
    const cellAttrs = {
      alignment: { default: "left" },
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
    const cell = (type: "table_header" | "table_cell", text: string, alignment: string) =>
      schema.node(type, { alignment }, schema.node("paragraph", null, schema.text(text)));
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

    expect(documentXml).toContain("<w:tbl>");
    expect(documentXml).toContain('<w:tblW w:type="dxa" w:w="9026"/>');
    expect(documentXml).toContain('<w:tblLayout w:type="fixed"/>');
    expect(
      documentXml.match(/<w:tcW w:type="dxa" w:w="3008"\/>/g)
    ).toHaveLength(4);
    expect(
      documentXml.match(/<w:tcW w:type="dxa" w:w="3010"\/>/g)
    ).toHaveLength(2);
    expect(documentXml.match(/<w:jc w:val="left"\/>/g)).toHaveLength(2);
    expect(documentXml.match(/<w:jc w:val="center"\/>/g)).toHaveLength(2);
    expect(documentXml.match(/<w:jc w:val="right"\/>/g)).toHaveLength(2);
  });
});
