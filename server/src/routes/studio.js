/** Script writing and voice synthesis endpoints. */

import { Router } from 'express';
import { isAiAvailable, writeScript } from '../services/script-writer.js';
import { availableEngines, speak } from '../services/tts/index.js';
import { listVoices } from '../services/tts/macos.js';

export const studioRouter = Router();

/** What the UI needs to know about this deployment's capabilities. */
studioRouter.get('/capabilities', async (_request, response) => {
  const systemVoices = process.platform === 'darwin' ? await listVoices().catch(() => []) : [];
  response.json({
    aiScriptWriter: isAiAvailable(),
    scriptWriterModel: isAiAvailable() ? process.env.ANTHROPIC_MODEL || 'claude-opus-5' : null,
    voiceEngines: availableEngines(),
    systemVoices
  });
});

/** Write a storyboard for a topic and optional source content. */
studioRouter.post('/script', async (request, response, next) => {
  try {
    const { category, topic, duration, sourceContent, visualStyle, audience } = request.body || {};
    if (!topic?.trim() && !sourceContent?.trim()) {
      return response.status(400).json({ error: 'Provide a topic or some source content.' });
    }

    const storyboard = await writeScript({
      category: category || 'Medical',
      topic: (topic || '').trim(),
      duration: Number(duration) || 30,
      sourceContent: sourceContent || '',
      visualStyle: visualStyle || 'AI decides',
      audience
    });

    response.json(storyboard);
  } catch (error) {
    next(error);
  }
});

/**
 * Synthesise one scene's narration.
 *
 * Returns the audio as base64 together with the viseme and word timelines, so
 * the browser can drive the avatar's mouth and the subtitles from the same
 * source of truth as the audio it is about to record.
 */
studioRouter.post('/voice', async (request, response, next) => {
  try {
    const { text, voice, engine } = request.body || {};
    if (!text?.trim()) return response.status(400).json({ error: 'Narration text is required.' });
    response.json(await speak({ text, voice, engine }));
  } catch (error) {
    next(error);
  }
});
