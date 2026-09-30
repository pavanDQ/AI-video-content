/**
 * Grapheme -> phoneme -> viseme pipeline.
 *
 * Real lip sync needs three things: which mouth shape, when it starts, and how
 * long it lasts. A forced aligner is overkill for narration we authored
 * ourselves, so we derive the phoneme sequence from English spelling rules and
 * then anchor it to real time in one of two ways:
 *
 *   1. If the voice engine returned character timestamps (ElevenLabs does),
 *      each phoneme is placed on the exact audio time of the characters that
 *      produced it. This is frame-accurate.
 *   2. Otherwise phonemes are distributed across the measured audio duration
 *      in proportion to how long each sound actually takes to say.
 *
 * The browser then multiplies the resulting mouth shape by the audio's own
 * amplitude envelope, so the mouth closes during silence no matter what the
 * timeline says. That combination is what makes it read as synced.
 */

/** Preston-Blair style viseme set: the distinct mouth shapes speech needs. */
export const VISEMES = [
  'REST', // closed, neutral
  'MBP',  // m, b, p      - lips pressed together
  'FV',   // f, v         - lower lip under upper teeth
  'TH',   // th           - tongue between teeth
  'SS',   // s, z, sh, ch - narrow, teeth showing
  'DD',   // t, d, n, l   - tongue to alveolar ridge
  'KG',   // k, g, ng, h  - slightly open, back of tongue
  'RR',   // r            - rounded and tense
  'AA',   // father, cat  - wide open
  'E',    // bed, say     - mid, spread
  'I',    // sit, machine - narrow, spread
  'O',    // go, thought  - rounded
  'U'     // boot, would  - tightly rounded
];

/**
 * Relative spoken length of each viseme class. Plosives are brief; vowels
 * carry most of the duration. These weights are what make the distributed
 * timeline sound right rather than robotically even.
 */
const WEIGHT = {
  REST: 1.0, MBP: 0.55, FV: 0.85, TH: 0.85, SS: 0.95, DD: 0.6,
  KG: 0.6, RR: 0.8, AA: 1.6, E: 1.35, I: 1.1, O: 1.5, U: 1.35
};

/** Longest-match-first spelling table. Order within each length matters. */
const GRAPHEMES = [
  // --- four letters ---
  ['ough', 'O'], ['augh', 'AA'], ['tion', 'SS'], ['sion', 'SS'],
  // --- three letters ---
  ['igh', 'I'], ['air', 'E'], ['are', 'E'], ['ear', 'I'], ['eer', 'I'],
  ['oor', 'O'], ['our', 'AA'], ['eau', 'O'], ['sch', 'SS'], ['tch', 'SS'],
  ['dge', 'SS'], ['ngu', 'KG'],
  // --- two letters ---
  ['ch', 'SS'], ['sh', 'SS'], ['th', 'TH'], ['ph', 'FV'], ['gh', 'KG'],
  ['ck', 'KG'], ['ng', 'KG'], ['kn', 'DD'], ['wr', 'RR'], ['wh', 'U'],
  ['qu', 'U'], ['ps', 'SS'], ['gn', 'DD'],
  ['ee', 'I'], ['ea', 'I'], ['ie', 'I'], ['ei', 'I'], ['ey', 'I'],
  ['ai', 'E'], ['ay', 'E'], ['ae', 'E'],
  ['oo', 'U'], ['ou', 'O'], ['ow', 'O'], ['oa', 'O'], ['oe', 'O'],
  ['oi', 'O'], ['oy', 'O'], ['au', 'O'], ['aw', 'O'],
  ['ew', 'U'], ['ue', 'U'], ['ui', 'U'], ['uo', 'U'],
  ['er', 'RR'], ['ir', 'RR'], ['ur', 'RR'], ['or', 'O'], ['ar', 'AA'],
  // --- single letters ---
  ['a', 'AA'], ['e', 'E'], ['i', 'I'], ['o', 'O'], ['u', 'U'], ['y', 'I'],
  ['b', 'MBP'], ['p', 'MBP'], ['m', 'MBP'],
  ['f', 'FV'], ['v', 'FV'],
  ['s', 'SS'], ['z', 'SS'], ['c', 'SS'], ['x', 'SS'], ['j', 'SS'],
  ['t', 'DD'], ['d', 'DD'], ['n', 'DD'], ['l', 'DD'],
  ['k', 'KG'], ['g', 'KG'], ['h', 'KG'], ['q', 'KG'],
  ['r', 'RR'], ['w', 'U']
];

/** How long a pause each punctuation mark buys, as a weight. */
const PAUSE_WEIGHT = { ',': 1.1, ';': 1.3, ':': 1.3, '.': 2.2, '!': 2.2, '?': 2.2, '—': 1.2, '\n': 2.2 };

const isLetter = ch => /[a-z']/i.test(ch);

/**
 * Split one word into viseme units, recording the character span each unit
 * came from so it can later be anchored to engine timestamps.
 */
function visemesForWord(word, base) {
  const lower = word.toLowerCase();
  const units = [];
  let i = 0;

  while (i < lower.length) {
    if (lower[i] === "'") { i++; continue; }

    // A trailing silent "e" is spelled but not spoken ("case", "rate").
    const isFinalSilentE =
      lower[i] === 'e' && i === lower.length - 1 && lower.length > 2 && !'aeiou'.includes(lower[i - 1]);
    if (isFinalSilentE) { i++; continue; }

    const match = GRAPHEMES.find(([g]) => lower.startsWith(g, i));
    if (!match) { i++; continue; }

    const [grapheme, viseme] = match;
    // Doubled consonants ("cell", "little") are one sound, not two.
    const previous = units[units.length - 1];
    if (previous && previous.viseme === viseme && grapheme.length === 1 && !'aeiouy'.includes(grapheme)) {
      previous.end = base + i + grapheme.length;
    } else {
      units.push({ viseme, weight: WEIGHT[viseme], start: base + i, end: base + i + grapheme.length });
    }
    i += grapheme.length;
  }

  return units;
}

/**
 * Convert narration text into an ordered list of viseme units with the
 * character span each one covers.
 */
export function phonemize(text) {
  const units = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (isLetter(ch)) {
      let j = i;
      while (j < text.length && isLetter(text[j])) j++;
      units.push(...visemesForWord(text.slice(i, j), i));
      // Word gap: a brief return toward rest keeps words from slurring.
      units.push({ viseme: 'REST', weight: 0.25, start: j, end: j + 1 });
      i = j;
      continue;
    }

    const pause = PAUSE_WEIGHT[ch];
    if (pause) units.push({ viseme: 'REST', weight: pause, start: i, end: i + 1 });
    i++;
  }

  return units.filter((unit, index) => !(unit.viseme === 'REST' && index === 0));
}

/**
 * Place viseme units on the audio timeline.
 *
 * @param text        narration exactly as it was sent to the voice engine
 * @param durationMs  measured duration of the rendered audio
 * @param charTimes   optional per-character start times in ms, index-aligned
 *                    to `text` (ElevenLabs `alignment`)
 * @returns frames of { t, d, viseme } in ms, ordered and non-overlapping
 */
export function buildVisemeTimeline(text, durationMs, charTimes = null) {
  const units = phonemize(text);
  if (!units.length) return [{ t: 0, d: durationMs, viseme: 'REST' }];

  if (charTimes && charTimes.length) {
    const at = index => {
      const clamped = Math.max(0, Math.min(charTimes.length - 1, index));
      return charTimes[clamped];
    };
    const frames = units.map(unit => {
      const start = at(unit.start);
      const end = Math.max(start + 20, at(unit.end));
      return { t: Math.round(start), d: Math.round(end - start), viseme: unit.viseme };
    });
    return normalize(frames, durationMs);
  }

  const totalWeight = units.reduce((sum, unit) => sum + unit.weight, 0);
  let cursor = 0;
  const frames = units.map(unit => {
    const d = (unit.weight / totalWeight) * durationMs;
    const frame = { t: Math.round(cursor), d: Math.round(d), viseme: unit.viseme };
    cursor += d;
    return frame;
  });
  return normalize(frames, durationMs);
}

/** Sort, clamp and close gaps so the client can binary-search the timeline. */
function normalize(frames, durationMs) {
  const sorted = frames
    .filter(frame => frame.d > 0)
    .sort((a, b) => a.t - b.t);

  for (let i = 0; i < sorted.length - 1; i++) {
    const overlap = sorted[i].t + sorted[i].d - sorted[i + 1].t;
    if (overlap > 0) sorted[i].d -= overlap;
  }

  const last = sorted[sorted.length - 1];
  if (last && last.t + last.d < durationMs) last.d = durationMs - last.t;
  return sorted.filter(frame => frame.d > 0);
}

/**
 * Word-level timeline, used to highlight subtitles in time with the voice.
 */
export function buildWordTimeline(text, durationMs, charTimes = null) {
  const words = [];
  const pattern = /[^\s]+/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    words.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  if (!words.length) return [];

  if (charTimes && charTimes.length) {
    const at = index => charTimes[Math.max(0, Math.min(charTimes.length - 1, index))];
    return words.map(word => ({
      text: word.text,
      t: Math.round(at(word.start)),
      d: Math.max(60, Math.round(at(word.end) - at(word.start)))
    }));
  }

  // No engine timings: weight each word by its spoken length, not its
  // character count, so "a" does not get the same slot as "carcinoma".
  const weights = words.map(word => phonemize(word.text).reduce((sum, u) => sum + u.weight, 0) || 1);
  const total = weights.reduce((sum, w) => sum + w, 0);
  let cursor = 0;
  return words.map((word, index) => {
    const d = (weights[index] / total) * durationMs;
    const frame = { text: word.text, t: Math.round(cursor), d: Math.round(d) };
    cursor += d;
    return frame;
  });
}
