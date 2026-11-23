import { isMermaidLanguage } from "./mermaid-language";

export const MARKMAP_LANGUAGE = "markmap";
export { MERMAID_LANGUAGE } from "./mermaid-language";

export type DiagramLanguage = "mermaid" | "markmap";

export function isMarkmapLanguage(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim().toLowerCase() === MARKMAP_LANGUAGE
  );
}

export function diagramLanguage(value: unknown): DiagramLanguage | null {
  if (isMermaidLanguage(value)) return "mermaid";
  if (isMarkmapLanguage(value)) return "markmap";
  return null;
}
