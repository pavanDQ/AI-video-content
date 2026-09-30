/**
 * Offline AI voice engine built on the macOS speech synthesiser.
 *
 * This is the zero-configuration default. Unlike the browser's
 * SpeechSynthesis API it writes a real audio file, which is the whole point:
 * audio we hold as bytes can be muxed into the downloadable video and can be
 * analysed for an amplitude envelope. Browser SpeechSynthesis can do neither.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAMPLE_RATE = 24000;

/** Words per minute. Narration for clinicians reads better a little slower. */
const DEFAULT_RATE = 170;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

let voiceCache = null;

/** Enumerate the English voices actually installed on this machine. */
export async function listVoices() {
  if (voiceCache) return voiceCache;

  const output = await new Promise((resolve, reject) => {
    const child = spawn('say', ['-v', '?']);
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(stdout));
  });

  // Novelty voices ("Bells", "Boing") sing rather than speak; they are useless
  // for clinical narration, so keep only the natural-sounding ones.
  const NOVELTY = new Set([
    'Albert', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Wobble', 'Jester',
    'Organ', 'Superstar', 'Trinoids', 'Whisper', 'Zarvox', 'Hysterical',
    'Bad News', 'Good News', 'Deranged', 'Pipe Organ'
  ]);

  voiceCache = output
    .split('\n')
    .map(line => line.match(/^(.+?)\s{2,}(\w{2}_\w{2})\s/))
    .filter(Boolean)
    .map(([, name, locale]) => ({ name: name.trim(), locale }))
    .filter(voice => voice.locale.startsWith('en_') && !NOVELTY.has(voice.name));

  return voiceCache;
}

/**
 * Resolve a UI voice label to an installed system voice, degrading to whatever
 * English voice exists rather than failing.
 */
async function resolveVoice(requested) {
  const voices = await listVoices();
  const names = voices.map(voice => voice.name);
  const has = name => names.includes(name);

  if (requested && has(requested)) return requested;

  const preferences = {
    female: ['Samantha', 'Karen', 'Moira', 'Tessa', 'Kathy'],
    male: ['Daniel', 'Rishi', 'Alex', 'Fred', 'Ralph']
  };
  const wantsMale = /male/i.test(requested || '') && !/female/i.test(requested || '');
  const ordered = wantsMale
    ? [...preferences.male, ...preferences.female]
    : [...preferences.female, ...preferences.male];

  return ordered.find(has) || names[0] || null;
}

/** Read the sample count out of a canonical 16-bit PCM WAV header. */
export function wavDurationMs(buffer) {
  let offset = 12;
  let sampleRate = SAMPLE_RATE;
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
      const bytesPerFrame = channels * (bitsPerSample / 8);
      return Math.round((size / bytesPerFrame / sampleRate) * 1000);
    }

    offset += 8 + size + (size % 2);
  }
  return 0;
}

/**
 * Render narration to a 24 kHz mono WAV.
 *
 * @returns { audio: Buffer, mimeType, durationMs, voice, charTimes: null }
 */
export async function synthesize({ text, voice, rate = DEFAULT_RATE }) {
  const resolved = await resolveVoice(voice);
  const dir = await mkdtemp(join(tmpdir(), 'ai-med-tts-'));
  const textPath = join(dir, 'narration.txt');
  const aiffPath = join(dir, 'narration.aiff');
  const wavPath = join(dir, 'narration.wav');

  try {
    // Pass the script through a file: narration can contain quotes, dashes and
    // newlines that would otherwise need shell-safe escaping.
    await writeFile(textPath, text, 'utf8');

    const args = ['-f', textPath, '-o', aiffPath, '-r', String(rate)];
    if (resolved) args.unshift('-v', resolved);
    await run('say', args);

    // `say` only writes CAF/AIFF; afconvert normalises it to the PCM WAV that
    // the browser's AudioContext can decode.
    await run('afconvert', ['-f', 'WAVE', '-d', `LEI16@${SAMPLE_RATE}`, '-c', '1', aiffPath, wavPath]);

    const audio = await readFile(wavPath);
    return {
      audio,
      mimeType: 'audio/wav',
      durationMs: wavDurationMs(audio),
      voice: resolved || 'system default',
      charTimes: null
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const id = 'macos';
export const label = 'macOS Neural Voice (offline)';
export function isAvailable() {
  return process.platform === 'darwin';
}
