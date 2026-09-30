/** Script writing and voice synthesis endpoints. */

import { Router } from 'express';
import { fetchPublicImage } from '../services/image-proxy.js';
import { isAiAvailable, writeScript } from '../services/script-writer.js';
import { parseSourceContent } from '../services/source-content.js';
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
    // Pasted CMS HTML becomes plain prose plus a list of images to show.
    const source = parseSourceContent(sourceContent);
    if (!topic?.trim() && !source.text) {
      return response.status(400).json({ error: 'Provide a topic or some source content.' });
    }

    const storyboard = await writeScript({
      category: category || 'Medical',
      topic: (topic || '').trim(),
      duration: Number(duration) || 30,
      sourceContent: source.text,
      images: source.images,
      visualStyle: visualStyle || 'AI decides',
      audience
    });

    if (source.references.length) {
      storyboard.reviewNotes = [
        ...(storyboard.reviewNotes || []),
        ...source.references.map(reference => `Source reference: ${reference}`)
      ];
    }

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

/**
 * Serve a source-content image from this origin, so the canvas that draws it
 * stays recordable. See services/image-proxy.js for what is allowed.
 */
studioRouter.get('/image', async (request, response, next) => {
  try {
    const url = String(request.query.url || '');
    if (!url) return response.status(400).json({ error: 'url is required.' });
    const { body, contentType } = await fetchPublicImage(url);
    response.set({
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox"
    });
    response.send(body);
  } catch (error) {
    next(error);
  }
});
