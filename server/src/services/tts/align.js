/**
 * Audio-anchored character timings for engines that report none.
 *
 * Piper and macOS `say` return audio but no timestamps. Spreading the
 * narration's sounds evenly across the clip drifts badly, because the engine's
 * real pauses (lead-in, after sentences and commas) are much longer and less
 * regular than any estimate: measured drift reached half a second by the end
 * of a scene. Instead, this finds the silences in the rendered audio and pins
 * each punctuation pause in the text to the silence it produced. Sounds are
 * then spread only within the stretches of actual speech, so any error is
 * confined to one clause instead of accumulating across the scene.
 *
 * The result has the same shape as ElevenLabs' character alignment, so the
 * viseme and subtitle timelines use it exactly as they would engine timings.
 */

import { phonemize } from '../visemes.js';

const FRAME_MS = 10;
/** Shorter silences are stop consonants ("t", "k") inside words, not pauses. */
const MIN_GAP_MS = 90;
/** Speech is anything louder than this fraction of the clip's typical loudness. */
const SILENCE_RATIO = 0.08;

const PAUSE_CHARS = new Set([',', ';', ':', '.', '!', '?', '—', '–', '…', '\n']);
const SENTENCE_END = new Set(['.', '!', '?', '\n']);

/** Alignment costs, in fractions of the clip's speech time. */
const SKIP_COMMA = 0.02;
const SKIP_SENTENCE = 0.06;
const SKIP_GAP = 0.05;

/** 16-bit PCM WAV -> mono samples in [-1, 1]. Returns null for anything else. */
function readWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bitsPerSample = 16;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      if (bitsPerSample !== 16 || !sampleRate) return null;
      const end = Math.min(buffer.length, offset + 8 + size);
      const frameBytes = 2 * channels;
      const count = Math.floor((end - offset - 8) / frameBytes);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = buffer.readInt16LE(offset + 8 + i * frameBytes) / 32768;
      return { samples, sampleRate };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** Speech bounds and internal silences, in ms. */
function findSpeech({ samples, sampleRate }) {
  const window = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const frames = Math.floor(samples.length / window);
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * window; i < (f + 1) * window; i++) sum += samples[i] * samples[i];
    rms[f] = Math.sqrt(sum / window);
  }

  const sorted = Float32Array.from(rms).sort();
  const threshold = (sorted[Math.floor(sorted.length * 0.95)] || 0) * SILENCE_RATIO;
  const loud = Array.from(rms, value => value > threshold);

  const first = loud.indexOf(true);
  const last = loud.lastIndexOf(true);
  if (first < 0) return null;

  const gaps = [];
  let run = -1;
  for (let f = first; f <= last; f++) {
    if (!loud[f] && run < 0) run = f;
    if (loud[f] && run >= 0) {
      if ((f - run) * FRAME_MS >= MIN_GAP_MS) gaps.push({ start: run * FRAME_MS, end: f * FRAME_MS });
      run = -1;
    }
  }
  return { start: first * FRAME_MS, end: (last + 1) * FRAME_MS, gaps };
}

/**
 * Match text pauses to audio gaps, in order, minimising how far each matched
 * pair sits from each other in relative speech time. Either side may skip:
 * a comma the engine read straight through, or a long stop consonant.
 *
 * @returns array of [pauseIndex, gapIndex] pairs
 */
function matchPauses(pauses, gaps) {
  const m = pauses.length;
  const k = gaps.length;
  const cost = Array.from({ length: m + 1 }, () => new Float64Array(k + 1).fill(Infinity));
  const move = Array.from({ length: m + 1 }, () => new Uint8Array(k + 1));
  cost[0][0] = 0;

  for (let i = 0; i <= m; i++) {
    for (let j = 0; j <= k; j++) {
      const here = cost[i][j];
      if (here === Infinity) continue;
      if (i < m) {
        const skip = here + (pauses[i].sentence ? SKIP_SENTENCE : SKIP_COMMA);
        if (skip < cost[i + 1][j]) { cost[i + 1][j] = skip; move[i + 1][j] = 1; }
      }
      if (j < k) {
        const skip = here + SKIP_GAP;
        if (skip < cost[i][j + 1]) { cost[i][j + 1] = skip; move[i][j + 1] = 2; }
      }
      if (i < m && j < k) {
        const pair = here + Math.abs(pauses[i].fraction - gaps[j].fraction);
        if (pair < cost[i + 1][j + 1]) { cost[i + 1][j + 1] = pair; move[i + 1][j + 1] = 3; }
      }
    }
  }

  const pairs = [];
  for (let i = m, j = k; i > 0 || j > 0;) {
    const step = move[i][j];
    if (step === 3) { pairs.unshift([i - 1, j - 1]); i--; j--; }
    else if (step === 1) i--;
    else j--;
  }
  return pairs;
}

/**
 * @param text   narration exactly as sent to the engine
 * @param audio  the engine's WAV output
 * @returns per-character start times in ms, index-aligned to `text`, or null
 *          when the audio cannot be analysed
 */
export function alignToAudio(text, audio) {
  const pcm = readWav(audio);
  if (!pcm || !text) return null;
  const speech = findSpeech(pcm);
  if (!speech) return null;

  // Spoken weight per character. Punctuation pauses get none: their time
  // comes from the audio's measured silences instead.
  const weight = new Float64Array(text.length);
  for (const unit of phonemize(text)) {
    if (PAUSE_CHARS.has(text[unit.start])) continue;
    const span = Math.max(1, unit.end - unit.start);
    for (let c = unit.start; c < Math.min(text.length, unit.start + span); c++) weight[c] += unit.weight / span;
  }
  const cumulative = new Float64Array(text.length + 1);
  for (let c = 0; c < text.length; c++) cumulative[c + 1] = cumulative[c] + weight[c];
  const totalWeight = cumulative[text.length];
  if (!totalWeight) return null;

  // Pauses: punctuation followed by whitespace or the end, not "2.5".
  const pauses = [];
  for (let c = 0; c < text.length; c++) {
    if (!PAUSE_CHARS.has(text[c]) || !(c + 1 >= text.length || /\s/.test(text[c + 1]))) continue;
    let next = c + 1;
    while (next < text.length && (/\s/.test(text[next]) || PAUSE_CHARS.has(text[next]))) next++;
    if (next >= text.length) continue; // the final full stop is the trailing silence
    pauses.push({ at: c, next, sentence: SENTENCE_END.has(text[c]), fraction: cumulative[c] / totalWeight });
    c = next - 1;
  }

  // Position of each gap as a fraction of speech time, silences excluded.
  const speechMs = speech.end - speech.start - speech.gaps.reduce((sum, gap) => sum + gap.end - gap.start, 0);
  let silenceBefore = 0;
  const gaps = speech.gaps.map(gap => {
    const fraction = (gap.start - speech.start - silenceBefore) / Math.max(1, speechMs);
    silenceBefore += gap.end - gap.start;
    return { ...gap, fraction };
  });

  // Anchors: character index -> time. Between anchors, time follows weight.
  const firstLetter = Math.max(0, text.search(/[a-z0-9]/i));
  const anchors = [{ char: firstLetter, time: speech.start }];
  const holds = [];
  for (const [p, g] of matchPauses(pauses, gaps)) {
    anchors.push({ char: pauses[p].at, time: gaps[g].start });
    anchors.push({ char: pauses[p].next, time: gaps[g].end });
    holds.push({ from: pauses[p].at + 1, to: pauses[p].next, time: gaps[g].end });
  }
  anchors.push({ char: text.length, time: speech.end });

  const times = new Array(text.length);
  for (let a = 0; a < anchors.length - 1; a++) {
    const from = anchors[a];
    const to = anchors[a + 1];
    const span = cumulative[to.char] - cumulative[from.char];
    for (let c = from.char; c < to.char; c++) {
      const progress = span > 0 ? (cumulative[c] - cumulative[from.char]) / span : 0;
      times[c] = from.time + progress * (to.time - from.time);
    }
  }
  for (let c = 0; c < firstLetter; c++) times[c] = speech.start;
  // The punctuation itself marks the start of the silence; what follows it up
  // to the next word belongs to the silence's end, so the pause shows as rest.
  for (const hold of holds) for (let c = hold.from; c < hold.to; c++) times[c] = hold.time;

  return times.map(time => Math.round(time ?? speech.end));
}
