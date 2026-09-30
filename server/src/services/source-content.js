/**
 * Source content normaliser.
 *
 * Clinicians often paste article HTML straight from a CMS or a JSON payload,
 * complete with inline styles, entities and escaped `\"` / `\r\n`. Everything
 * downstream (the script writer, the planner and the voice engine) wants plain
 * prose, so this turns that HTML into readable text and pulls the images out
 * separately so they can be shown on screen instead of being read aloud.
 *
 * Output text is one block per line. Images stay in place as `[Image N]`
 * lines, so both the AI script writer and the offline planner know which part
 * of the article each image belongs to.
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  deg: '°', plusmn: '±', times: '×', divide: '÷', micro: 'µ', le: '≤', ge: '≥',
  ne: '≠', asymp: '≈', minus: '−', frac12: '½', frac14: '¼', frac34: '¾',
  sup2: '²', sup3: '³', trade: '™', reg: '®', copy: '©', sect: '§', para: '¶',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', kappa: 'κ',
  lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', tau: 'τ', omega: 'ω',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Omega: 'Ω',
  auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Eacute: 'É',
  agrave: 'à', egrave: 'è', ograve: 'ò', acirc: 'â', ecirc: 'ê', ocirc: 'ô',
  ccedil: 'ç', ntilde: 'ñ', szlig: 'ß', oslash: 'ø', aring: 'å'
};

/** Headings that start the bibliography: narrating a DOI helps nobody. */
const REFERENCE_HEADING = /^(references?|bibliography|sources?|citations?)\s*:?$/i;

const BLOCK_TAGS = 'p|div|h[1-6]|li|ul|ol|tr|table|blockquote|section|article|header|footer|figure|figcaption|pre';

export function looksLikeHtml(text) {
  return /<\/?(?:[a-z][a-z0-9]*)(?:\s[^>]*)?\/?>/i.test(text);
}

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

/** Undo the escaping left behind when HTML is copied out of a JSON string. */
function unescapeJsonArtifacts(text) {
  if (!/\\["'\/nrt]/.test(text)) return text;
  return text
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\\(["'\/])/g, '$1');
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim() : '';
}

/** Only absolute web images can be fetched and drawn. */
function imageUrl(src) {
  const url = src.startsWith('//') ? `https:${src}` : src;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * A paragraph that is only bold text, short, and unpunctuated is a subheading
 * in CMS output ("<p><strong>Future Directions</strong></p>").
 */
function isBoldHeading(innerHtml) {
  const text = stripTags(innerHtml);
  if (!text || text.length > 120 || /[.!?]$/.test(text)) return false;
  const withoutBold = innerHtml.replace(/<(strong|b)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  return stripTags(withoutBold) === '';
}

/**
 * @returns {{ text: string, images: { url: string, alt: string }[], references: string[], wasHtml: boolean }}
 */
export function parseSourceContent(raw) {
  const input = String(raw || '').trim();
  if (!input) return { text: '', images: [], references: [], wasHtml: false };

  const unescaped = unescapeJsonArtifacts(input);
  if (!looksLikeHtml(unescaped)) {
    return { text: decodeEntities(unescaped).trim(), images: [], references: [], wasHtml: false };
  }

  const images = [];
  // Private-use sentinels survive tag stripping and cannot occur in real text.
  const HEADING = '';
  const IMAGE = '';

  let html = unescaped
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|iframe|svg)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<img\b[^>]*>/gi, tag => {
      const url = imageUrl(attribute(tag, 'src'));
      if (!url || images.some(image => image.url === url)) return ' ';
      images.push({ url, alt: attribute(tag, 'alt') || attribute(tag, 'title') });
      return `\n${IMAGE}${images.length}\n`;
    })
    .replace(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner) => `\n${HEADING}${stripTags(inner)}\n`)
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (match, inner) =>
      isBoldHeading(inner) ? `\n${HEADING}${stripTags(inner)}\n` : `\n${inner}\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]*>/g, ' ');

  html = decodeEntities(html);

  const lines = html
    .split(/\n+/)
    // Removed inline tags leave a space before punctuation ("<em>Cell</em>.").
    .map(line => line.replace(/[ \t ]+/g, ' ').replace(/ ([.,;:!?)])/g, '$1').trim())
    .filter(Boolean);

  const output = [];
  const references = [];
  let inReferences = false;

  for (const line of lines) {
    if (line.startsWith(HEADING)) {
      const heading = line.slice(1).trim();
      if (!heading) continue;
      inReferences = REFERENCE_HEADING.test(heading);
      if (!inReferences) output.push(heading);
    } else if (line.startsWith(IMAGE)) {
      // Images inside the reference list are logos or thumbnails, not figures.
      if (!inReferences) output.push(`[Image ${line.slice(1)}]`);
    } else if (inReferences) {
      references.push(line);
    } else {
      output.push(line);
    }
  }

  // Keep only images that are still referenced in the text, renumbered.
  const kept = [];
  const text = output
    .map(line => {
      const match = line.match(/^\[Image (\d+)\]$/);
      if (!match) return line;
      kept.push(images[Number(match[1]) - 1]);
      return `[Image ${kept.length}]`;
    })
    .join('\n');

  return { text, images: kept, references, wasHtml: true };
}
