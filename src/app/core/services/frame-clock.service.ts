import { Injectable } from '@angular/core';

/**
 * A frame clock that keeps running when the tab is in the background.
 *
 * `requestAnimationFrame` is suspended outright while a tab is hidden, and
 * `setTimeout` on a hidden page is clamped to roughly one tick per second.
 * Either would stall a recording the moment the user switches tabs — measured
 * in Chrome over a 2 second window with the tab hidden:
 *
 *   requestAnimationFrame   0 ticks
 *   setTimeout(33)          3 ticks
 *   Worker setInterval(33)  90 ticks   (a full 30 fps)
 *
 * Timers inside a dedicated worker are not throttled that way, so the worker
 * drives the clock and the main thread only draws. Rendering a video is
 * exactly the case where "pause when the user looks away" is the wrong
 * behaviour.
 */
@Injectable({ providedIn: 'root' })
export class FrameClockService {
  /**
   * Run `onFrame` at approximately `fps` until the returned function is called.
   * The callback receives the milliseconds elapsed since the clock started.
   */
  start(fps: number, onFrame: (elapsedMs: number) => void): () => void {
    const intervalMs = Math.max(1, Math.round(1000 / fps));

    // Inlined as a blob so the worker needs no separate build entry.
    const source = `
      let handle = 0;
      onmessage = event => {
        if (event.data.type === 'start') {
          handle = setInterval(() => postMessage('tick'), event.data.intervalMs);
        } else {
          clearInterval(handle);
          close();
        }
      };
    `;
    const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(blobUrl);

    const startedAt = performance.now();
    let stopped = false;

    worker.onmessage = () => {
      if (stopped) return;
      onFrame(performance.now() - startedAt);
    };
    worker.postMessage({ type: 'start', intervalMs });

    return () => {
      if (stopped) return;
      stopped = true;
      worker.postMessage({ type: 'stop' });
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
    };
  }
}
