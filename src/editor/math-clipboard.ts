import { texToMathMl } from "./mathjax";
import { formatMathMlString } from "./mathml-format";

/** 公式 NodeView 把已提交的 TeX 原文保存在 data-value 中。 */
export function mathTex(element: HTMLElement): string {
  // 编辑态下 data-value 仍是上次提交值，右键复制必须优先取输入框当前内容。
  const input = element.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    ".milkdown-math-inline-input, .math-block-editor"
  );
  if (element.classList.contains("is-editing") && input) {
    if (input.classList.contains("milkdown-math-inline-input")) {
      const match = /^\$([\s\S]*)\$$/.exec(input.value);
      return match ? match[1] : input.value;
    }
    return input.value;
  }
  return element.dataset.value ?? "";
}

/** 把 TeX 生成 Typora 同类的 MathML 源码（只复制 <math> 元素本身）。 */
export async function mathToMathMl(
  tex: string,
  displayMode = false
): Promise<string> {
  return formatMathMlString(await texToMathMl(tex, displayMode));
}

/** Typora 的公式剪贴板文本：Word 使用原始 MathML，MathML 项使用格式化源码。 */
export async function mathClipboardText(
  tex: string,
  action: "word" | "mathml" | "tex",
  displayMode = false
): Promise<string> {
  if (action === "tex") return tex;
  const mathml = await texToMathMl(tex, displayMode);
  return action === "word" ? mathml : formatMathMlString(mathml);
}
