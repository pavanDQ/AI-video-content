/**
 * Offline neural voice engine built on Piper (https://github.com/rhasspy/piper).
 *
 * The Linux counterpart of the macOS engine: no account, no network, and it
 * writes a real WAV file that can be muxed into the downloadable video.
 * The binary and voice models live in `server/vendor/piper/` (not committed).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wavDurationMs } from './macos.js';

const VENDOR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../vendor/piper');
const BINARY = process.env.PIPER_BINARY || join(VENDOR_DIR, 'piper/piper');
const VOICES_DIR = process.env.PIPER_VOICES_DIR || join(VENDOR_DIR, 'voices');

const VOICES = {
  female: process.env.PIPER_VOICE_FEMALE || 'en_US-lessac-medium',
  male: process.env.PIPER_VOICE_MALE || 'en_US-ryan-medium'
};

/** >1 speaks slower. Narration for clinicians reads better a little slower. */
const LENGTH_SCALE = process.env.PIPER_LENGTH_SCALE || '1.1';

function modelPath(name) {
  return join(VOICES_DIR, `${name}.onnx`);
}

/** Map a UI voice label ("AI Male Voice") to an installed Piper model. */
function resolveVoice(requested) {
  const label = requested || '';
  if (existsSync(modelPath(label))) return label;
  const wantsMale = /male/i.test(label) && !/female/i.test(label);
  const ordered = wantsMale ? [VOICES.male, VOICES.female] : [VOICES.female, VOICES.male];
  return ordered.find(name => existsSync(modelPath(name))) || null;
}

function runPiper(args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(BINARY, args);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolvePromise();
      else reject(new Error(`piper exited with ${code}: ${stderr.trim()}`));
    });
    // Narration goes in on stdin, so quotes and dashes need no escaping.
    child.stdin.end(input, 'utf8');
  });
}

/**
 * Render narration to a 22.05 kHz mono WAV.
 *
 * @returns { audio: Buffer, mimeType, durationMs, voice, charTimes: null }
 */
export async function synthesize({ text, voice }) {
  const resolved = resolveVoice(voice);
  if (!resolved) throw new Error(`No Piper voice model found in ${VOICES_DIR}.`);

  const dir = await mkdtemp(join(tmpdir(), 'ai-med-tts-'));
  const wavPath = join(dir, 'narration.wav');

  try {
    await runPiper(
      ['--model', modelPath(resolved), '--output_file', wavPath, '--length_scale', String(LENGTH_SCALE)],
      text
    );
    const audio = await readFile(wavPath);
    return {
      audio,
      mimeType: 'audio/wav',
      durationMs: wavDurationMs(audio),
      voice: resolved,
      charTimes: null
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const id = 'piper';
export const label = 'Piper Neural Voice (offline)';
export function isAvailable() {
  return existsSync(BINARY) && Boolean(resolveVoice(null));
}
