import { describe, expect, it } from "vitest";
import { formatImageMarkdown, parseImageMarkdown } from "./image-markdown";

describe("Markdown image source", () => {
  it("formats the three standard image attributes", () => {
    expect(
      formatImageMarkdown({
        src: "assets/example.png",
        alt: "示例",
        title: "图片标题",
      })
    ).toBe('![示例](assets/example.png "图片标题")');
  });

  it("keeps paths with spaces valid using angle brackets", () => {
    expect(
      formatImageMarkdown({
        src: "assets/my image.png",
        alt: "A [B]",
        title: null,
      })
    ).toBe("![A \\[B\\]](<assets/my image.png>)");
  });

  it("parses a complete image and round-trips its attributes", () => {
    const source = '![说明](<assets/my image.png> "标题 \\"A\\"")';
    const attrs = parseImageMarkdown(source);

    expect(attrs).toEqual({
      src: "assets/my image.png",
      alt: "说明",
      title: '标题 "A"',
    });
    expect(formatImageMarkdown(attrs!)).toBe(source);
  });

  it("rejects incomplete source", () => {
    expect(parseImageMarkdown("![说明](assets/a.png")).toBeNull();
    expect(parseImageMarkdown("普通文字")).toBeNull();
  });
});
