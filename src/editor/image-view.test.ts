import { Schema } from "@milkdown/prose/model";
import { EditorState } from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import { describe, expect, it } from "vitest";
import { createImageNodeView } from "./image-view";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    image: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: {
        src: { default: "" },
        alt: { default: "" },
        title: { default: null },
      },
      toDOM: () => ["img"],
    },
    text: { group: "inline" },
  },
});

describe("inline image source editing", () => {
  it("turns edited Markdown back into ordinary text when markers are deleted", () => {
    const image = schema.nodes.image.create({
      src: "image.png",
      alt: "说明",
    });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, image),
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView(host, {
      state: EditorState.create({ schema, doc }),
      nodeViews: { image: createImageNodeView },
    });

    try {
      const imageDom = view.dom.querySelector<HTMLImageElement>("img")!;
      imageDom.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      const source = view.dom.querySelector<HTMLElement>(
        ".mt-image-source"
      )!;
      expect(source.hidden).toBe(false);
      expect(source.textContent).toBe("![说明](image.png)");

      source.textContent = "普通文本";
      source.dispatchEvent(new FocusEvent("blur"));

      expect(view.state.doc.textContent).toBe("普通文本");
      expect(view.state.doc.firstChild?.firstChild?.type.name).toBe("text");
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
