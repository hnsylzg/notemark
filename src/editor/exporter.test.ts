import { describe, expect, it } from "vitest";
import { buildStandaloneHtml, htmlToPlainText } from "./exporter";

describe("PDF table borders", () => {
  it("keeps standard collapsed theme borders during print layout adaptation", () => {
    const html = buildStandaloneHtml({
      title: "table",
      bodyHtml: "<table><tr><th>A</th></tr><tr><td>B</td></tr></table>",
      forPrint: true,
    });

    expect(html).toContain("border-collapse: collapse !important");
    expect(html).toContain("border-spacing: 0 !important");
    expect(html).toContain("break-inside: auto !important");
    expect(html).toContain(".mt-export-body thead");
    expect(html).toContain(".mt-export-body th,\n.mt-export-body td {");
    expect(html).toContain("position: static !important");
    expect(html).toContain(".mt-export-body,\n.mt-export-body * {");
    expect(html).toContain("var(\n    --mt-hr-print-border,");
    expect(html).toContain("print-color-adjust: exact");
    expect(html).toContain("-webkit-print-color-adjust: exact");
    expect(html).not.toContain("border-collapse: separate !important");
    expect(html).not.toContain(".mt-export-body tr > :first-child");
  });
});

describe("TXT export plain text", () => {
  it("keeps standard HTML list items from serialized selections", () => {
    const text = htmlToPlainText(`
      <ul>
        <li><p>第一项</p></li>
        <li><p>第二项</p></li>
      </ul>
      <ol>
        <li><p>有序一</p></li>
        <li><p>有序二</p></li>
      </ol>
    `);

    expect(text).toBe("• 第一项\n• 第二项\n\n1. 有序一\n2. 有序二\n");
  });

  it("keeps ordered-list NodeView wrappers on separate lines", () => {
    const text = htmlToPlainText(`
      <ol>
        <div class="milkdown-list-item-block">
          <li class="list-item">
            <div class="label-wrapper"><span class="label ordered">1.</span></div>
            <div class="children">
              <div class="content-dom">
                <p>第一项</p>
                <ol>
                  <div class="milkdown-list-item-block">
                    <li class="list-item">
                      <div class="label-wrapper"><span class="label ordered">1.</span></div>
                      <div class="children">
                        <p>子项一</p>
                        <ol>
                          <div class="milkdown-list-item-block">
                            <li class="list-item">
                              <div class="label-wrapper"><span class="label ordered">1.</span></div>
                              <div class="children"><p>孙项</p></div>
                            </li>
                          </div>
                        </ol>
                      </div>
                    </li>
                  </div>
                  <div class="milkdown-list-item-block">
                    <li class="list-item">
                      <div class="label-wrapper"><span class="label ordered">2.</span></div>
                      <div class="children"><p>子项二</p></div>
                    </li>
                  </div>
                </ol>
              </div>
            </div>
          </li>
        </div>
        <div class="milkdown-list-item-block">
          <li class="list-item">
            <div class="label-wrapper"><span class="label ordered">2.</span></div>
            <div class="children"><p>第二项</p></div>
          </li>
        </div>
      </ol>
    `);

    expect(text).toBe(
      "1. 第一项\n  1. 子项一\n    1. 孙项\n  2. 子项二\n2. 第二项\n"
    );
  });

  it("keeps nested unordered-list NodeView items on separate lines", () => {
    const text = htmlToPlainText(`
      <ul>
        <div class="milkdown-list-item-block">
          <li class="list-item">
            <div class="label-wrapper"></div>
            <div class="children">
              <div class="content-dom">
                <p>父项</p>
                <ul>
                  <div class="milkdown-list-item-block">
                    <li class="list-item">
                      <div class="label-wrapper"></div>
                      <div class="children"><p>子项一</p></div>
                    </li>
                  </div>
                  <div class="milkdown-list-item-block">
                    <li class="list-item">
                      <div class="label-wrapper"></div>
                      <div class="children">
                        <p>子项二</p>
                        <ul>
                          <div class="milkdown-list-item-block">
                            <li class="list-item">
                              <div class="label-wrapper"></div>
                              <div class="children"><p>孙项</p></div>
                            </li>
                          </div>
                        </ul>
                      </div>
                    </li>
                  </div>
                </ul>
              </div>
            </div>
          </li>
        </div>
      </ul>
    `);

    expect(text).toBe(
      "• 父项\n  • 子项一\n  • 子项二\n    • 孙项\n"
    );
  });

  it("aligns table columns when copying or exporting plain text", () => {
    const text = htmlToPlainText(`
      <table>
        <tr><th>A</th><th>Long</th></tr>
        <tr><td>中文</td><td>B</td></tr>
      </table>
    `);

    expect(text).toBe("A     Long\n中文  B\n");
  });
});
