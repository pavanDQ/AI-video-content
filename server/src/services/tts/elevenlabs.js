/**
 * Production AI voice engine.
 *
 * Preferred over the offline engine because the `with-timestamps` endpoint
 * returns a start time for every character of the script. Those timestamps let
 * us anchor each viseme to the exact moment its sound is produced, which is the
 * difference between "approximately synced" and "actually synced".
 */

const API_ROOT = 'https://api.elevenlabs.io/v1';

function voiceIdFor(label) {
  const male = /male/i.test(label || '') && !/female/i.test(label || '');
  return male
    ? process.env.ELEVENLABS_VOICE_MALE || 'onwK4e9ZLuTAKqWW03F9'
    : process.env.ELEVENLABS_VOICE_FEMALE || '21m00Tcm4TlvDq8ikWAM';
}

export async function synthesize({ text, voice }) {
  const voiceId = voiceIdFor(voice);
  const response = await fetch(`${API_ROOT}/text-to-speech/${voiceId}/with-timestamps`, {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      text,
      model_id: process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5',
      // Medical narration should sound measured and consistent, not expressive.
      voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true }
    })
  });

  if (!response.ok) {
    throw new Error(`ElevenLabs responded ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const payload = await response.json();
  const audio = Buffer.from(payload.audio_base64, 'base64');
  const alignment = payload.alignment || payload.normalized_alignment;

  // The alignment array is index-aligned to the characters the engine actually
  // spoke, which can differ from our input after normalisation. Hand both the
  // times and the spoken text back so the caller phonemizes the same string.
  const charTimes = alignment
    ? alignment.character_start_times_seconds.map(seconds => seconds * 1000)
    : null;
  const spokenText = alignment ? alignment.characters.join('') : text;
  const endTimes = alignment?.character_end_times_seconds;

  return {
    audio,
    mimeType: 'audio/mpeg',
    durationMs: endTimes?.length ? Math.round(endTimes[endTimes.length - 1] * 1000) : 0,
    voice: voiceId,
    charTimes,
    spokenText
  };
}

export const id = 'elevenlabs';
export const label = 'ElevenLabs (character-accurate timing)';
export function isAvailable() {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}
