import { Schema } from "@milkdown/prose/model";
import { EditorState, TextSelection } from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import { GapCursor } from "@milkdown/prose/gapcursor";
import { describe, expect, it } from "vitest";
import {
  createFrontmatterGapGuardPlugin,
  createFrontmatterNodeView,
  parseFrontmatterRows,
} from "./frontmatter";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    yaml: {
      group: "block",
      atom: true,
      attrs: { value: { default: "" } },
      toDOM: () => ["div", { class: "mt-frontmatter" }],
    },
    text: { group: "inline" },
  },
});

function createView(value: string) {
  const yaml = schema.nodes.yaml.create({ value });
  const doc = schema.node("doc", null, [yaml]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView(host, {
    state: EditorState.create({ schema, doc }),
    nodeViews: {
      yaml: createFrontmatterNodeView,
    },
  });
  return { view, host };
}

describe("Front Matter preview", () => {
  it("parses simple YAML properties for display", () => {
    expect(parseFrontmatterRows("title: 文档标题\ntags: test")).toEqual([
      { key: "title", value: "文档标题" },
      { key: "tags", value: "test" },
    ]);
  });

  it("renders committed values and exits source mode on blur", async () => {
    const { view, host } = createView("title: 旧标题");

    try {
      const dom = view.dom.querySelector<HTMLElement>(".mt-frontmatter")!;
      const body = dom.querySelector<HTMLTextAreaElement>(
        ".mt-frontmatter-body"
      )!;
      const source = dom.querySelector<HTMLElement>(".mt-block-source")!;

      dom.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(source.style.display).toBe("");

      body.value = "title: 新标题\ndate: 2026-11-17";
      body.dispatchEvent(new FocusEvent("blur"));

      expect(view.state.doc.firstChild!.attrs.value).toBe(
        "title: 新标题\ndate: 2026-11-17"
      );
      expect(source.style.display).toBe("none");
      expect(dom.textContent).toContain("新标题");
      expect(dom.textContent).toContain("2026-11-17");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("removes empty Front Matter when editing ends", async () => {
    const { view, host } = createView("");

    try {
      const dom = view.dom.querySelector<HTMLElement>(".mt-frontmatter")!;
      const body = dom.querySelector<HTMLTextAreaElement>(
        ".mt-frontmatter-body"
      )!;

      dom.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      body.dispatchEvent(new FocusEvent("blur"));

      expect(view.state.doc.firstChild!.type.name).toBe("paragraph");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("rejects a GapCursor before Front Matter", () => {
    const yaml = schema.nodes.yaml.create({ value: "title: Test" });
    const paragraph = schema.node("paragraph");
    const doc = schema.node("doc", null, [yaml, paragraph]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 2),
      plugins: [createFrontmatterGapGuardPlugin()],
    });

    const next = state.applyTransaction(
      state.tr.setSelection(new GapCursor(doc.resolve(0)))
    ).state;
    expect(next.selection).not.toBeInstanceOf(GapCursor);
  });
});
