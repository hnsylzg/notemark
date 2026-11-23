const CUSTOM_PROPERTY_PATTERN = /(--[\w-]+)\s*:\s*([^;}]+)/g;
const VARIABLE_REFERENCE_PATTERN =
  /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g;

const PAINT_ATTRIBUTES = [
  "style",
  "color",
  "fill",
  "stroke",
  "stop-color",
  "flood-color",
  "lighting-color",
] as const;

function collectThemeTokens(doc: Document): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const style of doc.querySelectorAll("style")) {
    for (const match of style.textContent?.matchAll(CUSTOM_PROPERTY_PATTERN) ??
      []) {
      tokens.set(match[1], match[2].trim());
    }
  }
  return tokens;
}

function resolveReferences(
  value: string,
  tokens: ReadonlyMap<string, string>
): string {
  let current = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = current.replace(
      VARIABLE_REFERENCE_PATTERN,
      (_match, name: string, fallback: string | undefined) =>
        tokens.get(name) ?? fallback?.trim() ?? ""
    );
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * Word's SVG renderer does not resolve CSS custom properties. Replace every
 * Markmap paint reference with its concrete theme color before embedding.
 */
export function inlineMarkmapSvgTheme(svg: string): string {
  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = doc.documentElement;
    if (root.localName !== "svg" || doc.querySelector("parsererror")) {
      return svg;
    }

    const tokens = collectThemeTokens(doc);
    for (const element of [root, ...root.querySelectorAll("*")]) {
      for (const attribute of PAINT_ATTRIBUTES) {
        const value = element.getAttribute(attribute);
        if (!value) continue;
        element.setAttribute(
          attribute,
          resolveReferences(value, tokens)
        );
      }
    }
    for (const style of root.querySelectorAll("style")) style.remove();
    return new XMLSerializer().serializeToString(root);
  } catch {
    return svg;
  }
}
