import { describe, expect, it } from "vitest";
import {
  normalizeTableClipboardHtml,
  tableHtmlToAlignedPlainText,
} from "./table-clipboard";

describe("table clipboard", () => {
  it("pads plain-text columns using their display widths", () => {
    const text = tableHtmlToAlignedPlainText(`
      <table>
        <tr><th>A</th><th>Long</th></tr>
        <tr><td>中文</td><td>B</td></tr>
      </table>
    `);

    expect(text).toBe("A     Long\n中文  B");
  });

  it("respects explicit right alignment in plain text", () => {
    const text = tableHtmlToAlignedPlainText(`
      <table>
        <tr><td>A</td><td style="text-align: right">Long</td></tr>
        <tr><td>中文</td><td style="text-align: right">B</td></tr>
      </table>
    `);

    expect(text).toBe("A     Long\n中文     B");
  });

  it("omits default left alignment but keeps explicit center alignment", () => {
    const html = normalizeTableClipboardHtml(`
      <table>
        <tr>
          <td style="text-align: left">A</td>
          <td style="text-align: center">B</td>
        </tr>
      </table>
    `);

    expect(html).not.toContain("text-align: left");
    expect(html).toContain("text-align: center");
  });
});
