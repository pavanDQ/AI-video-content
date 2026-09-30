import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { GenerationSettings, Scene, VoiceTrack } from '../models/video.models';
import { ApiService } from './api.service';
import { AvatarRendererService } from './avatar-renderer.service';
import { FrameClockService } from './frame-clock.service';
import { LipSyncService } from './lip-sync.service';
import { SceneRendererService } from './scene-renderer.service';

/** One scene with its rendered narration and analysis, ready to play. */
interface PreparedScene {
  scene: Scene;
  track: VoiceTrack;
  buffer: AudioBuffer;
  envelope: Float32Array;
  /** Offset of this scene from the start of the video, in milliseconds. */
  startMs: number;
  durationMs: number;
}

export interface ProductionResult {
  blob: Blob;
  url: string;
  durationMs: number;
  scenes: { title: string; durationMs: number; voice: string }[];
  engineLabel: string;
  hasAudio: boolean;
}

export interface ProductionProgress {
  phase: 'voicing' | 'recording' | 'finishing';
  percent: number;
  message: string;
}

/** Silence between scenes: enough to breathe, short enough not to drag. */
const SCENE_GAP_MS = 320;
const FPS = 30;

@Injectable({ providedIn: 'root' })
export class VideoProducerService {
  private audioContext?: AudioContext;
  private cancelled = false;

  constructor(
    private readonly api: ApiService,
    private readonly lipSync: LipSyncService,
    private readonly sceneRenderer: SceneRendererService,
    private readonly avatars: AvatarRendererService,
    private readonly clock: FrameClockService
  ) {}

  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Produce a downloadable video with the AI voice baked in.
   *
   * The original POC recorded `canvas.captureStream()` on its own, which is why
   * the download was silent: browser SpeechSynthesis plays straight to the
   * output device and never appears in a capturable track. Here the narration
   * arrives as audio bytes, is decoded into the Web Audio graph, and is routed
   * into a `MediaStreamAudioDestinationNode`. That node's audio track is
   * combined with the canvas video track into one MediaStream, so MediaRecorder
   * writes a single file containing both.
   */
  async produce(
    canvas: HTMLCanvasElement,
    scenes: Scene[],
    settings: GenerationSettings,
    onProgress: (progress: ProductionProgress) => void,
    options: { monitor?: boolean; watermark?: string } = {}
  ): Promise<ProductionResult> {
    this.cancelled = false;

    const [width, height] = settings.resolution === '1080p' ? [1920, 1080] : [1280, 720];
    canvas.width = width;
    canvas.height = height;

    const context = this.context();
    // Autoplay policy suspends new contexts until a gesture; generation is
    // always user-initiated, so resuming here is safe.
    if (context.state === 'suspended') await context.resume();

    // --- 1. Render every narration track up front ---------------------------
    const prepared = await this.prepareScenes(scenes, settings, context, onProgress);
    if (!prepared.length) throw new Error('No narration could be rendered for this storyboard.');

    const totalMs = prepared[prepared.length - 1].startMs + prepared[prepared.length - 1].durationMs;

    // --- 2. Build a stream that carries both picture and sound --------------
    const destination = context.createMediaStreamDestination();

    // A single master gain keeps every scene at a consistent level and gives
    // one place to fade out at the end.
    const master = context.createGain();
    master.gain.value = 1;
    master.connect(destination);
    if (options.monitor !== false) master.connect(context.destination);

    const videoTrack = canvas.captureStream(FPS).getVideoTracks()[0];
    const audioTrack = destination.stream.getAudioTracks()[0];
    const stream = new MediaStream([videoTrack, audioTrack]);

    const mimeType = this.pickMimeType();
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: settings.resolution === '1080p' ? 6_000_000 : 3_500_000,
      audioBitsPerSecond: 128_000
    });

    const chunks: Blob[] = [];
    recorder.ondataavailable = event => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    const recordingComplete = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
      recorder.onerror = event => reject((event as unknown as { error: Error }).error);
    });

    // --- 3. Schedule the audio and drive the canvas ------------------------
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) throw new Error('Could not get a 2D drawing context.');

    // Draw the first frame before recording starts, so the video never opens
    // on a blank frame.
    this.drawFrame(ctx2d, prepared, 0, settings, totalMs, options.watermark);

    recorder.start(200);

    // Everything is scheduled against one baseline, which is what keeps the
    // picture and the voice aligned for the whole video rather than drifting.
    const startedAt = context.currentTime + 0.12;
    const sources = prepared.map(item => {
      const source = context.createBufferSource();
      source.buffer = item.buffer;
      source.connect(master);
      source.start(startedAt + item.startMs / 1000);
      return source;
    });

    try {
      await this.runRenderLoop(ctx2d, prepared, settings, startedAt, totalMs, onProgress, options.watermark);
    } finally {
      sources.forEach(source => {
        try { source.stop(); } catch { /* already finished */ }
        source.disconnect();
      });
      master.disconnect();
    }

    onProgress({ phase: 'finishing', percent: 98, message: 'Writing the video file…' });

    // Give the recorder a moment to flush the final frames before stopping.
    await new Promise(resolve => setTimeout(resolve, 260));
    if (recorder.state !== 'inactive') recorder.stop();

    const blob = await recordingComplete;
    videoTrack.stop();
    audioTrack.stop();

    onProgress({ phase: 'finishing', percent: 100, message: 'Done.' });

    return {
      blob,
      url: URL.createObjectURL(blob),
      durationMs: totalMs,
      scenes: prepared.map(item => ({
        title: item.scene.title,
        durationMs: item.durationMs,
        voice: item.track.voice
      })),
      engineLabel: prepared[0].track.engineLabel,
      hasAudio: true
    };
  }

  /**
   * Synthesise each scene's narration and analyse it.
   *
   * Scene length comes from the audio, not from the planner's estimate: a scene
   * that ends while the presenter is still mid-sentence is the fastest way to
   * make a video look automated.
   */
  private async prepareScenes(
    scenes: Scene[], settings: GenerationSettings, context: AudioContext,
    onProgress: (progress: ProductionProgress) => void
  ): Promise<PreparedScene[]> {
    const prepared: PreparedScene[] = [];
    let cursor = 0;

    for (let index = 0; index < scenes.length; index++) {
      if (this.cancelled) throw new Error('Generation cancelled.');
      const scene = scenes[index];

      onProgress({
        phase: 'voicing',
        percent: Math.round((index / scenes.length) * 45),
        message: `Generating AI voice for scene ${index + 1} of ${scenes.length}: ${scene.title}`
      });

      const track = await firstValueFrom(this.api.synthesizeVoice(scene.narration, settings.voice));
      const buffer = await context.decodeAudioData(this.toArrayBuffer(track.audioBase64));

      // Trust the decoded buffer over the engine's reported duration.
      const durationMs = Math.round(buffer.duration * 1000);

      prepared.push({
        scene,
        track,
        buffer,
        envelope: this.lipSync.buildEnvelope(buffer),
        startMs: cursor,
        durationMs
      });

      cursor += durationMs + (index < scenes.length - 1 ? SCENE_GAP_MS : 0);
    }

    return prepared;
  }

  /** Draw frames in step with the audio clock until the video is over. */
  private runRenderLoop(
    ctx: CanvasRenderingContext2D, prepared: PreparedScene[], settings: GenerationSettings,
    startedAt: number, totalMs: number,
    onProgress: (progress: ProductionProgress) => void, watermark?: string
  ): Promise<void> {
    const context = this.context();

    return new Promise<void>((resolve, reject) => {
      // Driven by a worker clock rather than requestAnimationFrame, so the
      // recording keeps rendering at full rate if the user switches tabs.
      const stop = this.clock.start(FPS, () => {
        if (this.cancelled) {
          stop();
          reject(new Error('Generation cancelled.'));
          return;
        }

        // The AudioContext clock is the source of truth. Using the wall clock
        // here would let the picture drift away from the voice over a long
        // video.
        const elapsedMs = (context.currentTime - startedAt) * 1000;

        if (elapsedMs >= totalMs) {
          // Hold the closing frame rather than cutting to black.
          this.drawFrame(ctx, prepared, totalMs - 1, settings, totalMs, watermark);
          stop();
          resolve();
          return;
        }

        if (elapsedMs >= 0) {
          this.drawFrame(ctx, prepared, elapsedMs, settings, totalMs, watermark);
          const percent = 45 + Math.round((elapsedMs / totalMs) * 52);
          const current = this.sceneAt(prepared, elapsedMs);
          onProgress({
            phase: 'recording',
            percent: Math.min(97, percent),
            message: `Recording: ${current.scene.title}`
          });
        }
      });
    });
  }

  private drawFrame(
    ctx: CanvasRenderingContext2D, prepared: PreparedScene[], elapsedMs: number,
    settings: GenerationSettings, totalMs: number, watermark?: string
  ): void {
    const index = this.sceneIndexAt(prepared, elapsedMs);
    const item = prepared[index];
    const sceneTimeMs = elapsedMs - item.startMs;

    // In the gap between scenes the voice has stopped, so the mouth must be
    // closed — clamping to the end of the audio does exactly that.
    const audioTimeMs = Math.max(0, Math.min(item.durationMs, sceneTimeMs));
    const speaking = sceneTimeMs >= 0 && sceneTimeMs <= item.durationMs;

    const mouth = this.lipSync.mouthAt(
      item.track.visemes, item.envelope, audioTimeMs, settings.lipSync && speaking
    );

    this.sceneRenderer.render(ctx, {
      scene: item.scene,
      sceneIndex: index,
      sceneCount: prepared.length,
      sceneTimeMs: Math.max(0, sceneTimeMs),
      sceneDurationMs: item.durationMs,
      totalProgress: Math.min(1, elapsedMs / totalMs),
      mouth,
      words: item.track.words,
      settings,
      preset: this.avatars.presetFor(settings.avatar),
      speaking,
      watermark
    });
  }

  private sceneIndexAt(prepared: PreparedScene[], elapsedMs: number): number {
    for (let index = prepared.length - 1; index >= 0; index--) {
      if (elapsedMs >= prepared[index].startMs) return index;
    }
    return 0;
  }

  private sceneAt(prepared: PreparedScene[], elapsedMs: number): PreparedScene {
    return prepared[this.sceneIndexAt(prepared, elapsedMs)];
  }

  private toArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  /**
   * Pick a container the browser can both record and play back.
   *
   * Every candidate names an audio codec: a video-only mime type would put us
   * back to a silent download.
   */
  private pickMimeType(): string {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=h264,opus',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/webm'
    ];
    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
  }

  private context(): AudioContext {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  /**
   * Preview a single scene without recording, so a reviewer can check a
   * narration edit without regenerating the whole video.
   */
  async previewScene(
    canvas: HTMLCanvasElement, scene: Scene, settings: GenerationSettings,
    onDone: () => void
  ): Promise<() => void> {
    const context = this.context();
    if (context.state === 'suspended') await context.resume();

    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get a 2D drawing context.');

    const track = await firstValueFrom(this.api.synthesizeVoice(scene.narration, settings.voice));
    const buffer = await context.decodeAudioData(this.toArrayBuffer(track.audioBase64));
    const envelope = this.lipSync.buildEnvelope(buffer);
    const durationMs = buffer.duration * 1000;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const startedAt = context.currentTime + 0.08;
    source.start(startedAt);

    let stopped = false;

    const stopClock = this.clock.start(FPS, () => {
      if (stopped) return;
      const elapsedMs = (context.currentTime - startedAt) * 1000;
      if (elapsedMs > durationMs) {
        stopped = true;
        stopClock();
        onDone();
        return;
      }

      const time = Math.max(0, elapsedMs);
      this.sceneRenderer.render(ctx, {
        scene,
        sceneIndex: 0,
        sceneCount: 1,
        sceneTimeMs: time,
        sceneDurationMs: durationMs,
        totalProgress: time / durationMs,
        mouth: this.lipSync.mouthAt(track.visemes, envelope, time, settings.lipSync),
        words: track.words,
        settings,
        preset: this.avatars.presetFor(settings.avatar),
        speaking: true
      });
    });

    return () => {
      stopped = true;
      stopClock();
      try { source.stop(); } catch { /* already finished */ }
    };
  }
}
