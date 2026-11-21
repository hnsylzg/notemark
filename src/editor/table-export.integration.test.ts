import { describe, expect, it } from "vitest";
import { createEditor, setMarkdown } from "./index";
import { getEditorHtml, htmlToPlainText } from "./exporter";
import {
  normalizeTableClipboardHtml,
  tableHtmlToAlignedPlainText,
} from "./table-clipboard";

describe("table text export", () => {
  it("uses the visible column alignment from a rendered Markdown table", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(
        editor,
        [
          "| A | Long | 数值 |",
          "| :--- | :---: | ---: |",
          "| 中文 | B | 1 |",
          "| x | yy | 100 |",
        ].join("\n")
      );

      const html = getEditorHtml(editor);
      const exported = htmlToPlainText(html);
      const copied = tableHtmlToAlignedPlainText(
        normalizeTableClipboardHtml(html)
      );

      expect(exported).toBe(
        "A     Long  数值\n中文   B       1\nx      yy    100\n"
      );
      expect(exported.trimEnd()).toBe(copied);
    } finally {
      await editor.destroy();
      root.remove();
    }
  });
});
