// Constrained Markdown → HTML for the user guides (docs/user-guide/*.md).
//
// Deliberately NOT a general Markdown implementation: it covers exactly the
// constructs the guides use — headings (#/##/###), paragraphs, bold/italic,
// code spans and fenced blocks, links, images, ordered/unordered lists (one
// nesting level) and pipe tables. Anything else FAILS THE BUILD loudly rather
// than leaking raw Markdown into docs/index.html (see UNSUPPORTED below).
//
// Same philosophy as esc()/prose() in gen_docs_html.mjs: escape everything
// first, then convert, so guide source can never inject tags into the site.

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Constructs this renderer does not handle. A guide that starts using one
// must extend the renderer — silently publishing raw Markdown is worse than a
// red build. Matched against raw source lines, so code-fence bodies are
// excluded before scanning.
const UNSUPPORTED = [
  [/^#{4,}\s/, 'heading deeper than ###'],
  [/^\s*>/, 'blockquote'],
  [/^\s*(-{3,}|\*{3,}|_{3,})\s*$/, 'horizontal rule'],
  [/^\[[^\]]+\]:/, 'reference-style link definition'],
];

function checkSupported(md, file) {
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    for (const [re, what] of UNSUPPORTED) {
      if (re.test(line)) {
        throw new Error(`${file}: unsupported Markdown (${what}): "${line.trim()}". `
          + 'Extend dev/md2html.mjs or rewrite the line.');
      }
    }
  }
}

/**
 * Inline Markdown on ALREADY-escaped text. Order matters: code spans first so
 * their content stays verbatim (`*` inside backticks is never emphasis), then
 * images/links, then bold before italic. Link targets are resolved by the
 * caller: resolveHref returns a URL, or null to demote the link to plain text
 * (used for links pointing outside the guide set); resolveImg returns a
 * rewritten src and throws if the target does not exist.
 */
function inline(t, { resolveHref, resolveImg }) {
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_, alt, src) => `<img src="${resolveImg(src)}" alt="${alt}" loading="lazy">`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const url = resolveHref(href);
    // Demoted links keep the visible label and name the original target, so
    // the reader still knows where the Markdown file would have taken them.
    return url == null ? `${label} <code class="dim">${href}</code>` : `<a href="${url}">${label}</a>`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s.,;:)]|$)/g, '$1<i>$2</i>');
  return t;
}

// Guides demote by one level: the guide's `# Title` is a section h2 on the
// page, `##` → h3, `###` → h4.
const heading = m => `<h${m[1].length + 1}>`;

const isTableSep = line => /^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
const isListItem = line => /^(-|\d+\.)\s/.test(line);
const isBlockStart = (line, next) =>
  /^\s*$/.test(line) || /^(#{1,3})\s/.test(line) || /^\s*```/.test(line)
  || isListItem(line) || (line.startsWith('|') && next != null && isTableSep(next));

/**
 * Render one guide. `file` is only for error messages. `resolveHref(href)`
 * and `resolveImg(src)` map guide-relative targets into docs/index.html space.
 */
export function renderGuide(md, { file, resolveHref, resolveImg }) {
  checkSupported(md, file);
  const cx = { resolveHref, resolveImg };
  const lines = md.split('\n');
  const out = [];
  let i = 0;

  const parseList = () => {
    const ordered = /^\d+\.\s/.test(lines[i]);
    const items = []; // { text: string, sub: string[] } — one nesting level
    let cur = null, curSub = null;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if ((m = /^(-|\d+\.)\s+(.*)$/.exec(line))) {
        if (/^\d+\./.test(line) !== ordered) break; // a different list starts
        cur = { text: m[2], sub: [] }; items.push(cur); curSub = null;
      } else if ((m = /^\s+-\s+(.*)$/.exec(line))) {
        if (!cur) throw new Error(`${file}: nested bullet with no parent item`);
        curSub = m[1]; cur.sub.push(curSub);
      } else if (/^\s*$/.test(line)) {
        break;
      } else if (/^\s+\S/.test(line) && cur) {
        // continuation of the current (possibly nested) item
        if (curSub != null) cur.sub[cur.sub.length - 1] += ' ' + line.trim();
        else cur.text += ' ' + line.trim();
      } else break;
      i++;
    }
    const tag = ordered ? 'ol' : 'ul';
    const li = it => `<li>${inline(esc(it.text), cx)}`
      + (it.sub.length ? `<ul>${it.sub.map(s => `<li>${inline(esc(s), cx)}</li>`).join('')}</ul>` : '')
      + '</li>';
    out.push(`<${tag}>${items.map(li).join('')}</${tag}>`);
  };

  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (/^\s*$/.test(line)) { i++; continue; }

    if ((m = /^\s*```(\w*)\s*$/.exec(line))) {           // fenced code
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      if (i >= lines.length) throw new Error(`${file}: unclosed code fence`);
      i++;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {           // heading
      out.push(`${heading(m)}${inline(esc(m[2]), cx)}</h${m[1].length + 1}>`);
      i++;
      continue;
    }
    if (line.startsWith('|')) {                           // pipe table
      if (lines[i + 1] == null || !isTableSep(lines[i + 1])) {
        throw new Error(`${file}: table-like line with no separator row: "${line.trim()}"`);
      }
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        // alignment colons in the separator row are ignored — the site's
        // table.ref style left-aligns everything anyway
        if (!isTableSep(lines[i])) rows.push(lines[i].split('|').slice(1, -1).map(c => c.trim()));
        i++;
      }
      const [head, ...bodyRows] = rows;
      out.push(`<div class="scroll-x"><table class="ref"><thead><tr>${head.map(c => `<th>${inline(esc(c), cx)}</th>`).join('')}</tr></thead>`
        + `<tbody>${bodyRows.map(r => `<tr>${r.map(c => `<td>${inline(esc(c), cx)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (isListItem(line)) { parseList(); continue; }

    // paragraph: hard-wrapped source lines join with a space (this is also
    // what lets inline formatting span source lines, e.g. `**data\nbrowser**`)
    const para = [];
    while (i < lines.length && !isBlockStart(lines[i], lines[i + 1])) para.push(lines[i++].trim());
    const text = para.join(' ');
    // a paragraph that is exactly one image renders as a figure with caption
    if ((m = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(text))) {
      out.push(`<figure><img src="${resolveImg(m[2])}" alt="${m[1]}" loading="lazy">`
        + (m[1] ? `<figcaption>${esc(m[1])}</figcaption>` : '') + '</figure>');
    } else {
      out.push(`<p>${inline(esc(text), cx)}</p>`);
    }
  }
  return out.join('\n');
}
