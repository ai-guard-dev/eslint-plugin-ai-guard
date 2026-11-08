/**
 * Tolerant JSON parsing for config files that allow comments and trailing
 * commas: tsconfig.json, .vscode/mcp.json, .claude/settings.json.
 */

/**
 * Parses JSON with comments and trailing commas, as tsconfig allows.
 * Comments and trailing commas are removed only outside string literals,
 * so string values are never altered. Throws on invalid JSON.
 */
export function parseJsonc(text: string): unknown {
  const out: string[] = [];
  let inString = false;
  // Index in `out` of a comma that may turn out to be trailing.
  let pendingComma = -1;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (inString) {
      out.push(char);
      if (char === '\\') {
        out.push(next ?? '');
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out.push('\n');
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++;
      out.push(' ');
      continue;
    }
    if (char === '}' || char === ']') {
      if (pendingComma >= 0) out[pendingComma] = ' ';
      pendingComma = -1;
      out.push(char);
      continue;
    }
    if (char === ',') {
      pendingComma = out.length;
      out.push(char);
      continue;
    }
    if (!/\s/.test(char)) pendingComma = -1;
    if (char === '"') inString = true;
    out.push(char);
  }
  return JSON.parse(out.join(''));
}

/** Like parseJsonc, but returns null instead of throwing. */
export function tryParseJsonc(text: string): unknown {
  try {
    return parseJsonc(text);
  } catch {
    return null;
  }
}
