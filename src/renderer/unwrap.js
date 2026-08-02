// Detection and removal of "artificial" hard line breaks in pasted text
// (typical for text copied from PDFs, emails or terminals, where paragraphs
// were wrapped at a fixed column width — sometimes even mid-word with a
// hyphen). Loaded before renderer.js; also requirable from Node for tests.
(function (global) {
  const TERMINAL = /[.!?:]["')\]]?$/; // line ends a sentence/clause
  const HYPHEN_BREAK = /\p{L}-$/u; //   line ends mid-word ("eingerichte-")
  const LOWER_START = /^\p{Ll}/u; //    line starts lowercase → continuation
  const UPPER_START = /^[\p{Lu}\d]/u;
  const LIST_ITEM = /^([-•*·]|\d+[.)])\s/;

  // A text counts as hard-wrapped when a meaningful share of consecutive
  // non-empty line pairs look like a sentence continuing across the break.
  function detectHardWrap(text) {
    const lines = text.split('\n').map((l) => l.trim());
    let pairs = 0;
    let joinable = 0;
    for (let i = 0; i < lines.length - 1; i++) {
      const a = lines[i];
      const b = lines[i + 1];
      if (!a || !b) continue;
      if (LIST_ITEM.test(b)) continue;
      pairs++;
      if (
        (HYPHEN_BREAK.test(a) && LOWER_START.test(b)) ||
        (!TERMINAL.test(a) && LOWER_START.test(b)) ||
        (/,$/.test(a) && LOWER_START.test(b))
      ) {
        joinable++;
      }
    }
    return pairs >= 2 && joinable >= 2 && joinable / pairs >= 0.25;
  }

  // Joins wrapped lines back into flowing paragraphs:
  // - blank lines stay paragraph breaks, unless the next paragraph starts
  //   lowercase (a page-break artifact splitting a sentence)
  // - list items keep their own lines
  // - a line break stays when it sits on a clear sentence boundary
  // - hyphenated word splits are merged back together
  function unwrapHardWrap(text) {
    const lines = text.split('\n').map((l) => l.trim());
    const out = [];
    let cur = '';

    const flush = () => {
      if (cur) out.push(cur);
      cur = '';
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (!line) {
        const next = lines.slice(i + 1).find((l) => l);
        // Swallow the blank line when the sentence clearly continues past it:
        // the next text starts lowercase, or the text so far ends mid-sentence
        const continues =
          cur && next && !LIST_ITEM.test(next) &&
          (LOWER_START.test(next) || !TERMINAL.test(cur));
        if (continues) continue;
        flush();
        if (out.length && out[out.length - 1] !== '') out.push('');
        continue;
      }

      if (!cur) {
        cur = line;
        continue;
      }
      if (LIST_ITEM.test(line) || (TERMINAL.test(cur) && UPPER_START.test(line))) {
        flush();
        cur = line;
        continue;
      }
      if (HYPHEN_BREAK.test(cur) && LOWER_START.test(line)) {
        cur = cur.slice(0, -1) + line;
      } else {
        cur += ' ' + line;
      }
    }
    flush();
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  }

  const api = { detectHardWrap, unwrapHardWrap };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.tranzlUnwrap = api;
})(typeof window !== 'undefined' ? window : globalThis);
