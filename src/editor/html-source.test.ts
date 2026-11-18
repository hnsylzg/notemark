import { describe, expect, it } from "vitest";
import { formatHtmlFragment, prepareClipboardHtml } from "./html-source";

function fragment(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("HTML source formatting", () => {
  it("puts block elements on separate lines and keeps inline elements inline", () => {
    expect(
      formatHtmlFragment(
        fragment(
          '<h1>标题</h1><p><strong>加粗</strong> 普通文本</p><ul><li>第一项</li><li>第二项</li></ul>'
        )
      )
    ).toBe(
      [
        "<h1>标题</h1>",
        "<p><strong>加粗</strong> 普通文本</p>",
        "<ul>",
        "<li>第一项</li>",
        "<li>第二项</li>",
        "</ul>",
      ].join("\n")
    );
  });

  it("preserves whitespace inside preformatted code", () => {
    expect(
      formatHtmlFragment(
        fragment('<pre><code>const a = 1;\n  return a;</code></pre>')
      )
    ).toBe("<pre><code>const a = 1;\n  return a;</code></pre>");
  });

  it("matches Typora's compact list HTML without editor metadata", () => {
    const root = fragment(
      '<p><strong>教学目标</strong>：</p><ol data-spread="false"><li data-label="1." data-list-type="ordered" data-spread="false"><p>掌握文件操作。</p></li><li data-label="2." data-list-type="ordered"><p>学会使用<code>wordcloud</code>库。</p></li></ol>'
    );
    prepareClipboardHtml(root);

    expect(formatHtmlFragment(root)).toBe(
      [
        "<p><strong>教学目标</strong>：</p>",
        "<ol>",
        "<li>掌握文件操作。</li>",
        "<li>学会使用<code>wordcloud</code>库。</li>",
        "</ol>",
      ].join("\n")
    );
  });
});
