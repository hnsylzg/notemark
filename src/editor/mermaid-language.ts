/** Canonical fenced-code language for Mermaid diagrams. */
export const MERMAID_LANGUAGE = "mermaid";

/** Mermaid language names are case-insensitive in the editor UI. */
export function isMermaidLanguage(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim().toLowerCase() === MERMAID_LANGUAGE
  );
}
