// Minimal declarations for the subset of js-yaml (bundled devDependency) used by
// integrity analysis. js-yaml 4 ships no types; @types/js-yaml is not installed.
declare module 'js-yaml' {
  export function load(text: string, options?: { filename?: string; json?: boolean }): unknown;
}
