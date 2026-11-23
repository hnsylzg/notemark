import type { Editor } from "@milkdown/kit/core";
import {
  buildStandaloneHtml,
  getEditorHtml,
  getExportHtml,
  getWordExportSource,
  htmlToPlainText,
  inlineImages,
  pickExportFile,
  warmUpCodeBlocks,
  writeExportFile,
} from "./exporter";

export type ExportFormat = "html" | "txt" | "docx" | "pdf";

export interface ExportContext {
  editor: Editor;
  title: string;
  dark: boolean;
}

async function currentEditorHtml(
  editor: Editor,
  prepareMermaid = true
): Promise<string> {
  await warmUpCodeBlocks(editor);
  return prepareMermaid ? getExportHtml(editor) : getEditorHtml(editor);
}

function downloadMessage(format: ExportFormat): string {
  if (format === "html") return "导出 HTML 失败";
  if (format === "txt") return "导出纯文本失败";
  if (format === "docx") return "导出 Word 失败";
  return "导出 PDF 失败";
}

export async function exportDocument(
  format: ExportFormat,
  ctx: ExportContext
): Promise<void> {
  try {
    await exportDocumentInner(format, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${downloadMessage(format)}：${message}`);
  }
}

async function exportDocumentInner(
  format: ExportFormat,
  ctx: ExportContext
): Promise<void> {
  if (format === "docx") {
    const source = getWordExportSource(ctx.editor);
    const target = await pickExportFile(`${ctx.title}.docx`, [
      { name: "Word 文档", extensions: ["docx"] },
    ]);
    if (!target) return;
    const { buildDocx } = await import("./docxExporter");
    await writeExportFile(target, await buildDocx(source));
    return;
  }

  if (format === "pdf") {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const target = await save({
      defaultPath: `${ctx.title}.pdf`,
      filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
    });
    if (!target) return;

    const html = await inlineImages(await currentEditorHtml(ctx.editor));
    const full = buildStandaloneHtml({
      title: ctx.title,
      bodyHtml: html,
      dark: ctx.dark,
      forPrint: true,
    });
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<void>("export_pdf", { html: full, pdfPath: target });
    return;
  }

  const extension = format === "html" ? "html" : "txt";
  const filter =
    format === "html"
      ? { name: "网页", extensions: ["html"] }
      : { name: "纯文本", extensions: ["txt"] };
  const target = await pickExportFile(`${ctx.title}.${extension}`, [filter]);
  if (!target) return;

  if (format === "html") {
    const html = await inlineImages(await currentEditorHtml(ctx.editor));
    await writeExportFile(
      target,
      buildStandaloneHtml({
        title: ctx.title,
        bodyHtml: html,
        dark: ctx.dark,
      })
    );
    return;
  }
  await writeExportFile(
    target,
    htmlToPlainText(await currentEditorHtml(ctx.editor, false))
  );
}
