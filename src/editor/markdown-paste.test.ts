import { describe, expect, it } from "vitest";
import { normalizePastedMarkdown } from "./markdown-paste";

describe("escaped Markdown clipboard", () => {
  it("restores headings, emphasis, lists, links and code fences", () => {
    const source = String.raw`\\# 标题\

\\*\\*加粗\\*\\*&#x20;

1\\. 第一项

[python.org]\\(https\\://www\\.python\\.org/)

\\\`\\\`\\\`python
print("ok")
\\\`\\\`\\\``;

    expect(normalizePastedMarkdown(source)).toBe(`# 标题

**加粗** 

1. 第一项

[python.org](https://www.python.org/)

\`\`\`python
print("ok")
\`\`\``);
  });

  it("keeps ordinary Windows path backslashes", () => {
    expect(normalizePastedMarkdown(String.raw`C:\Users\demo`)).toBe(
      String.raw`C:\Users\demo`
    );
  });
});
