/**
 * Voice engine selection and the narration -> (audio + lip-sync data) pipeline.
 */

import * as elevenlabs from './elevenlabs.js';
import * as macos from './macos.js';
import * as piper from './piper.js';
import { buildVisemeTimeline, buildWordTimeline } from '../visemes.js';
import { alignToAudio } from './align.js';

/** Best first. `auto` walks this list and takes the first available engine. */
const ENGINES = [elevenlabs, macos, piper];

export function availableEngines() {
  return ENGINES.map(engine => ({
    id: engine.id,
    label: engine.label,
    available: engine.isAvailable()
  }));
}

function pickEngine(requested) {
  const preference = requested || process.env.TTS_ENGINE || 'auto';
  if (preference !== 'auto') {
    const named = ENGINES.find(engine => engine.id === preference);
    if (named?.isAvailable()) return named;
  }
  return ENGINES.find(engine => engine.isAvailable()) || null;
}

/**
 * Normalise narration before it reaches the voice engine.
 *
 * Both the audio and the viseme timeline must be derived from the *same*
 * string, otherwise character offsets drift and the mouth desynchronises.
 */
function normalizeScript(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Render one scene's narration.
 *
 * @returns audio bytes plus everything the browser needs to animate a mouth:
 *          a viseme timeline, a word timeline for subtitles, and the duration.
 */
export async function speak({ text, voice, engine: requestedEngine }) {
  const script = normalizeScript(text);
  if (!script) throw new Error('Narration text is empty.');

  const engine = pickEngine(requestedEngine);
  if (!engine) {
    throw new Error(
      'No voice engine available. Set ELEVENLABS_API_KEY, run the server on macOS to use `say`, or install Piper into server/vendor/piper.'
    );
  }

  const result = await engine.synthesize({ text: script, voice });

  // Phonemize exactly what the engine reported speaking, so `charTimes`
  // indices line up with the characters we are converting to visemes.
  const spoken = result.spokenText || script;
  const durationMs = result.durationMs || estimateDuration(script);
  // Engines without timestamps: measure the pauses in the audio itself, so
  // the mouth does not drift away from the voice over a scene.
  const charTimes = result.charTimes
    || (result.mimeType === 'audio/wav' ? alignToAudio(spoken, result.audio) : null);

  return {
    engine: engine.id,
    engineLabel: engine.label,
    voice: result.voice,
    mimeType: result.mimeType,
    durationMs,
    audioBase64: result.audio.toString('base64'),
    visemes: buildVisemeTimeline(spoken, durationMs, charTimes),
    words: buildWordTimeline(spoken, durationMs, charTimes),
    script
  };
}

/** Last-resort duration guess: ~2.6 spoken characters per 10 ms at 170 wpm. */
function estimateDuration(text) {
  return Math.max(1200, Math.round((text.length / 14) * 1000));
}
