import { fail } from './errors.js';

// Bounded callers supply byte limits and their own fixed error code.
export function parseStrictJson(bytes, code) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const stack = [];
    // Reject duplicate decoded keys and excessive nesting before JSON.parse.
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        const start = i++;
        while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
        if (i === text.length) fail(code);
        let next = i + 1;
        while (next < text.length && /[\t\r\n ]/.test(text[next])) next++;
        if (text[next] === ':') {
          const frame = stack.at(-1), key = JSON.parse(text.slice(start, i + 1));
          if (frame?.kind !== '{' || frame.keys.has(key)) fail(code);
          frame.keys.add(key);
        }
      } else if (char === '{' || char === '[') {
        stack.push({ kind: char, keys: new Set() });
        if (stack.length > 6) fail(code);
      } else if (char === '}' || char === ']') {
        if (stack.pop()?.kind !== (char === '}' ? '{' : '[')) fail(code);
      }
    }
    return JSON.parse(text);
  } catch { fail(code); }
}
