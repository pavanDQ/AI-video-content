/**
 * Review-and-publish store.
 *
 * A medical video does not go to doctors straight from the generator: it is
 * submitted, reviewed by a clinician, and only then served. This module owns
 * that lifecycle and persists it to disk so a restart does not lose the
 * review queue.
 *
 * Status flow:
 *   draft -> in_review -> approved   (publishable, appears in the doctor library)
 *                      -> changes_requested -> in_review -> ...
 *                      -> rejected
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const INDEX_PATH = join(DATA_DIR, 'library.json');
const MEDIA_DIR = join(DATA_DIR, 'media');

export const STATUSES = ['draft', 'in_review', 'approved', 'changes_requested', 'rejected'];

/** Serialises writes so two concurrent requests cannot clobber the index. */
let writeQueue = Promise.resolve();

async function ensureDirs() {
  await mkdir(MEDIA_DIR, { recursive: true });
}

async function readIndex() {
  try {
    return JSON.parse(await readFile(INDEX_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { videos: [] };
    throw error;
  }
}

/** Write via a temp file and rename, so the index is never half-written. */
async function writeIndex(index) {
  await ensureDirs();
  const temporary = `${INDEX_PATH}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(index, null, 2), 'utf8');
  await rename(temporary, INDEX_PATH);
}

function mutate(mutator) {
  const next = writeQueue.then(async () => {
    const index = await readIndex();
    const result = await mutator(index);
    await writeIndex(index);
    return result;
  });
  // Keep the chain alive even if this mutation rejected.
  writeQueue = next.catch(() => {});
  return next;
}

function appendHistory(video, entry) {
  video.history = video.history || [];
  video.history.push({ at: new Date().toISOString(), ...entry });
}

export async function listVideos({ status } = {}) {
  const { videos } = await readIndex();
  const filtered = status ? videos.filter(video => video.status === status) : videos;
  return [...filtered].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getVideo(id) {
  const { videos } = await readIndex();
  return videos.find(video => video.id === id) || null;
}

/**
 * Create a submission. The storyboard and generation settings are recorded
 * alongside it so a reviewer can see exactly what produced the video.
 */
export function createVideo({ title, topic, category, summary, storyboard, settings, reviewNotes, createdBy }) {
  return mutate(index => {
    const now = new Date().toISOString();
    const video = {
      id: randomUUID(),
      title: title || topic || 'Untitled video',
      topic: topic || '',
      category: category || '',
      summary: summary || '',
      status: 'in_review',
      createdBy: createdBy || 'unknown',
      createdAt: now,
      updatedAt: now,
      storyboard: storyboard || [],
      settings: settings || {},
      aiReviewNotes: reviewNotes || [],
      reviews: [],
      media: null,
      history: []
    };
    appendHistory(video, { action: 'submitted', by: video.createdBy });
    index.videos.push(video);
    return video;
  });
}

/**
 * Record a clinician's review decision.
 *
 * `sceneEdits` lets a reviewer correct narration without regenerating the
 * whole video; the corrected script is what a re-render will use.
 */
export function reviewVideo(id, { decision, reviewer, notes, sceneEdits }) {
  const allowed = { approve: 'approved', request_changes: 'changes_requested', reject: 'rejected' };
  const status = allowed[decision];
  if (!status) throw Object.assign(new Error(`Unknown review decision "${decision}".`), { statusCode: 400 });
  if (!reviewer?.trim()) throw Object.assign(new Error('A reviewer name is required.'), { statusCode: 400 });

  return mutate(index => {
    const video = index.videos.find(entry => entry.id === id);
    if (!video) throw Object.assign(new Error('Video not found.'), { statusCode: 404 });

    if (Array.isArray(sceneEdits)) {
      sceneEdits.forEach(edit => {
        const scene = video.storyboard[edit.index];
        if (scene && typeof edit.narration === 'string') {
          scene.narration = edit.narration;
          scene.editedByReviewer = true;
        }
      });
      // Edited narration invalidates the rendered audio, so flag a re-render.
      if (sceneEdits.length) video.needsRerender = true;
    }

    const review = {
      id: randomUUID(),
      decision,
      status,
      reviewer: reviewer.trim(),
      notes: (notes || '').trim(),
      sceneEdits: sceneEdits || [],
      at: new Date().toISOString()
    };
    video.reviews.push(review);
    video.status = status;
    video.updatedAt = review.at;
    if (status === 'approved') {
      video.approvedAt = review.at;
      video.approvedBy = review.reviewer;
      video.needsRerender = false;
    }
    appendHistory(video, { action: decision, by: review.reviewer, notes: review.notes });
    return video;
  });
}

export function resubmitVideo(id, { by } = {}) {
  return mutate(index => {
    const video = index.videos.find(entry => entry.id === id);
    if (!video) throw Object.assign(new Error('Video not found.'), { statusCode: 404 });
    video.status = 'in_review';
    video.updatedAt = new Date().toISOString();
    appendHistory(video, { action: 'resubmitted', by: by || 'unknown' });
    return video;
  });
}

/** Attach the rendered video file to a submission. */
export async function attachMedia(id, { bytes, mimeType, durationMs }) {
  await ensureDirs();
  const extension = mimeType?.includes('mp4') ? 'mp4' : 'webm';
  const filename = `${id}.${extension}`;
  await writeFile(join(MEDIA_DIR, filename), bytes);

  return mutate(index => {
    const video = index.videos.find(entry => entry.id === id);
    if (!video) throw Object.assign(new Error('Video not found.'), { statusCode: 404 });
    video.media = {
      filename,
      mimeType: mimeType || 'video/webm',
      bytes: bytes.length,
      durationMs: durationMs || 0,
      uploadedAt: new Date().toISOString()
    };
    video.updatedAt = video.media.uploadedAt;
    appendHistory(video, { action: 'media_attached', bytes: bytes.length });
    return video;
  });
}

export function mediaPath(video) {
  return join(MEDIA_DIR, video.media.filename);
}

export function mediaStream(video) {
  return createReadStream(mediaPath(video));
}

export function deleteVideo(id) {
  return mutate(async index => {
    const position = index.videos.findIndex(entry => entry.id === id);
    if (position === -1) throw Object.assign(new Error('Video not found.'), { statusCode: 404 });
    const [video] = index.videos.splice(position, 1);
    if (video.media) await unlink(join(MEDIA_DIR, video.media.filename)).catch(() => {});
    return video;
  });
}
