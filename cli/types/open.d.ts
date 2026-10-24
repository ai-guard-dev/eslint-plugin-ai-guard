// `open` is an optional runtime dependency of `ai-guard report` (loaded with a
// guarded dynamic import and a platform-command fallback); it is not installed
// as a dependency, so declare the one call shape used.
declare module 'open' {
  export default function open(target: string): Promise<unknown>;
}
