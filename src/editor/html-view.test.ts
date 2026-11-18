import { describe, expect, it } from "vitest";
import { sanitizeHtml, sanitizeHtmlBlock } from "./html-view";

describe("HTML sanitizer", () => {
  it("removes scripts, event handlers and dangerous URL protocols", () => {
    const result = sanitizeHtml(
      '<span onclick="alert(1)">safe</span><script>alert(1)</script><a href="javascript:alert(1)">bad</a>'
    );
    expect(result).toContain("safe");
    expect(result).not.toContain("onclick");
    expect(result).not.toContain("<script");
    expect(result).not.toContain("javascript:");
  });

  it("forces remote iframes into an opaque sandbox", () => {
    const result = sanitizeHtml(
      '<iframe src="https://example.com/embed" sandbox="allow-top-navigation" allow="camera; fullscreen"></iframe>'
    );
    expect(result).toContain('sandbox="allow-scripts allow-presentation allow-popups');
    expect(result).not.toContain("allow-top-navigation");
    expect(result).not.toContain("camera");
    expect(result).toContain("referrerpolicy=\"no-referrer\"");
  });

  it("allows same-origin requests only for Python Tutor embeds", () => {
    const pythonTutor = sanitizeHtml(
      '<iframe src="https://pythontutor.com/iframe-embed.html#code=print(1)" height="620"></iframe>'
    );
    const untrusted = sanitizeHtml(
      '<iframe src="https://example.com/embed"></iframe>'
    );

    expect(pythonTutor).toContain("allow-same-origin");
    expect(pythonTutor).toContain('data-md-embed-provider="pythontutor"');
    expect(pythonTutor).toContain("--md-iframe-height: 620px");
    expect(untrusted).not.toContain("allow-same-origin");
  });

  it("sanitizes block HTML with the same frame policy", () => {
    const result = sanitizeHtmlBlock(
      '<div><iframe src="https://example.com" allow="top-navigation"></iframe></div>'
    );
    expect(result).toContain("md-iframe-wrap");
    expect(result).not.toContain("top-navigation");
  });
});
