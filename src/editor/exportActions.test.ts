import type { Editor } from "@milkdown/kit/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportDocument } from "./exportActions";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  invoke: vi.fn(),
  buildStandaloneHtml: vi.fn(() => "<html>export</html>"),
  getEditorHtml: vi.fn(() => "<p>editor</p>"),
  getExportHtml: vi.fn(async () => "<p>export</p>"),
  getWordExportSource: vi.fn(),
  htmlToPlainText: vi.fn(() => "plain"),
  inlineImages: vi.fn(async (html: string) => html),
  pickExportFile: vi.fn(),
  warmUpCodeBlocks: vi.fn(async () => undefined),
  writeExportFile: vi.fn(async () => undefined),
}));

vi.mock("./exporter", () => ({
  buildStandaloneHtml: mocks.buildStandaloneHtml,
  getEditorHtml: mocks.getEditorHtml,
  getExportHtml: mocks.getExportHtml,
  getWordExportSource: mocks.getWordExportSource,
  htmlToPlainText: mocks.htmlToPlainText,
  inlineImages: mocks.inlineImages,
  pickExportFile: mocks.pickExportFile,
  warmUpCodeBlocks: mocks.warmUpCodeBlocks,
  writeExportFile: mocks.writeExportFile,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: mocks.save,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

describe("PDF export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inlineImages.mockImplementation(async (html: string) => html);
    mocks.buildStandaloneHtml.mockReturnValue("<html>export</html>");
  });

  it("reports silent export failures without opening a print dialog", async () => {
    mocks.save.mockResolvedValue("E:\\exports\\document.pdf");
    mocks.invoke.mockRejectedValue(new Error("disk unavailable"));
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const childCount = document.body.childElementCount;

    await expect(
      exportDocument("pdf", {
        editor: {} as Editor,
        title: "document",
        dark: false,
      })
    ).rejects.toThrow("导出 PDF 失败：disk unavailable");

    expect(mocks.invoke).toHaveBeenCalledWith("export_pdf", {
      html: "<html>export</html>",
      pdfPath: "E:\\exports\\document.pdf",
    });
    expect(print).not.toHaveBeenCalled();
    expect(document.body.childElementCount).toBe(childCount);
    print.mockRestore();
  });
});
