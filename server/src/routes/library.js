/** Review queue and the doctor-facing library. */

import { Router, raw } from 'express';
import {
  attachMedia, createVideo, deleteVideo, getVideo, listVideos, mediaStream, resubmitVideo, reviewVideo
} from '../services/store.js';
import { statSync } from 'node:fs';
import { mediaPath } from '../services/store.js';

export const libraryRouter = Router();

/**
 * Strip the reviewer-only fields from a record before it is served to doctors.
 */
function publicView(video) {
  return {
    id: video.id,
    title: video.title,
    topic: video.topic,
    category: video.category,
    summary: video.summary,
    approvedAt: video.approvedAt,
    approvedBy: video.approvedBy,
    durationMs: video.media?.durationMs || 0,
    hasMedia: Boolean(video.media),
    sceneCount: video.storyboard?.length || 0
  };
}

/** Review queue. `?status=` filters; `?audience=doctor` returns approved only. */
libraryRouter.get('/', async (request, response, next) => {
  try {
    if (request.query.audience === 'doctor') {
      const approved = await listVideos({ status: 'approved' });
      return response.json({ videos: approved.filter(video => video.media).map(publicView) });
    }
    response.json({ videos: await listVideos({ status: request.query.status }) });
  } catch (error) {
    next(error);
  }
});

libraryRouter.get('/:id', async (request, response, next) => {
  try {
    const video = await getVideo(request.params.id);
    if (!video) return response.status(404).json({ error: 'Video not found.' });
    response.json(video);
  } catch (error) {
    next(error);
  }
});

/** Submit a generated video for clinical review. */
libraryRouter.post('/', async (request, response, next) => {
  try {
    const { title, topic, category, summary, storyboard, settings, reviewNotes, createdBy } = request.body || {};
    if (!Array.isArray(storyboard) || !storyboard.length) {
      return response.status(400).json({ error: 'A storyboard with at least one scene is required.' });
    }
    response.status(201).json(
      await createVideo({ title, topic, category, summary, storyboard, settings, reviewNotes, createdBy })
    );
  } catch (error) {
    next(error);
  }
});

/**
 * Upload the rendered video.
 *
 * Sent as a raw body rather than multipart: the browser already holds the
 * recording as a single Blob, so there is nothing to gain from form encoding.
 */
libraryRouter.put(
  '/:id/media',
  // A matcher function rather than a media-type pattern: MediaRecorder always
  // labels its output with codec parameters ("video/webm;codecs=vp9,opus"),
  // and `video/*` does not match a type carrying those parameters — which
  // silently rejected every real recording.
  raw({ type: () => true, limit: '250mb' }),
  async (request, response, next) => {
    try {
      if (!request.body?.length) return response.status(400).json({ error: 'Empty upload.' });
      const video = await attachMedia(request.params.id, {
        bytes: request.body,
        mimeType: request.get('content-type'),
        durationMs: Number(request.get('x-duration-ms')) || 0
      });
      response.json(video);
    } catch (error) {
      next(error);
    }
  }
);

/** Stream the rendered video, with range support so scrubbing works. */
libraryRouter.get('/:id/media', async (request, response, next) => {
  try {
    const video = await getVideo(request.params.id);
    if (!video?.media) return response.status(404).json({ error: 'No media for this video.' });

    // Only approved videos are servable, unless a reviewer explicitly asks to
    // preview one that is still in the queue.
    if (video.status !== 'approved' && request.query.preview !== '1') {
      return response.status(403).json({ error: 'This video has not been approved for distribution yet.' });
    }

    const { size } = statSync(mediaPath(video));
    response.setHeader('Content-Type', video.media.mimeType);
    response.setHeader('Accept-Ranges', 'bytes');
    if (request.query.download === '1') {
      const safe = video.title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase();
      response.setHeader('Content-Disposition', `attachment; filename="${safe || 'medical-video'}.webm"`);
    }
    response.setHeader('Content-Length', size);
    mediaStream(video).pipe(response);
  } catch (error) {
    next(error);
  }
});

/** Record a review decision. */
libraryRouter.post('/:id/review', async (request, response, next) => {
  try {
    const { decision, reviewer, notes, sceneEdits } = request.body || {};
    response.json(await reviewVideo(request.params.id, { decision, reviewer, notes, sceneEdits }));
  } catch (error) {
    next(error);
  }
});

libraryRouter.post('/:id/resubmit', async (request, response, next) => {
  try {
    response.json(await resubmitVideo(request.params.id, { by: request.body?.by }));
  } catch (error) {
    next(error);
  }
});

libraryRouter.delete('/:id', async (request, response, next) => {
  try {
    await deleteVideo(request.params.id);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});
