import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  Capabilities, GenerationSettings, Scene, Storyboard, VisualType
} from '../../core/models/video.models';
import { ApiService } from '../../core/services/api.service';
import { AVATAR_PRESETS, AvatarRendererService } from '../../core/services/avatar-renderer.service';
import { LipSyncService } from '../../core/services/lip-sync.service';
import { SceneRendererService } from '../../core/services/scene-renderer.service';
import { ProductionResult, VideoProducerService } from '../../core/services/video-producer.service';

@Component({
  selector: 'app-studio',
  templateUrl: './studio.component.html',
  styleUrls: ['./studio.component.css']
})
export class StudioComponent implements OnInit, OnDestroy {
  @ViewChild('stage', { static: true }) stageRef!: ElementRef<HTMLCanvasElement>;

  readonly avatarPresets = AVATAR_PRESETS;
  readonly visualStyles = [
    'AI decides', 'Whiteboard', 'Step diagram', 'Anatomy illustration', 'Medical animation', 'Doctor presentation'
  ];
  readonly visualTypes: VisualType[] = [
    'avatar', 'whiteboard', 'diagram', 'comparison', 'medical-animation', 'anatomy', 'image'
  ];
  readonly organs = ['cell', 'lungs', 'heart', 'brain', 'kidney', 'liver', 'stomach', 'bloodvessel'];

  settings: GenerationSettings = {
    category: 'Medical',
    topic: 'Types of Cancer',
    duration: 30,
    sourceContent: '',
    visualStyle: 'AI decides',
    voice: 'AI Female Voice',
    avatar: '3D Presenter',
    lipSync: true,
    subtitles: true,
    medicalAnimations: true,
    resolution: '720p'
  };

  capabilities?: Capabilities;
  storyboard?: Storyboard;
  scenes: Scene[] = [];

  writingScript = false;
  generating = false;
  progress = 0;
  status = 'Ready.';
  error = '';
  result?: ProductionResult;
  submitted?: { id: string; title: string };
  submitting = false;
  authorName = '';
  expandedScene = -1;

  private idleHandle = 0;
  private stopPreview?: () => void;
  private previewingScene = -1;

  constructor(
    private readonly api: ApiService,
    private readonly producer: VideoProducerService,
    private readonly sceneRenderer: SceneRendererService,
    private readonly lipSync: LipSyncService,
    private readonly avatars: AvatarRendererService
  ) {}

  ngOnInit(): void {
    this.api.capabilities().subscribe({
      next: capabilities => {
        this.capabilities = capabilities;
        // Offer the voices this machine actually has, not a hardcoded list.
        if (capabilities.systemVoices.length && !capabilities.aiScriptWriter) {
          this.settings.voice = capabilities.systemVoices[0].name;
        }
      },
      error: () => {
        this.error = 'Could not reach the API server. Start it with `npm start` inside the `server` folder.';
      }
    });
    this.startIdleLoop();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.idleHandle);
    this.stopPreview?.();
    this.producer.cancel();
  }

  get voiceOptions(): string[] {
    const system = this.capabilities?.systemVoices.map(voice => `${voice.name}`) || [];
    return system.length ? system : ['AI Female Voice', 'AI Male Voice'];
  }

  get engineSummary(): string {
    const engine = this.capabilities?.voiceEngines.find(item => item.available);
    return engine ? engine.label : 'No voice engine available';
  }

  get totalPlannedSeconds(): number {
    return this.scenes.reduce((sum, scene) => sum + scene.seconds, 0);
  }

  // ------------------------------------------------------------- scripting --

  async writeScript(): Promise<void> {
    if (this.writingScript) return;
    this.error = '';
    this.writingScript = true;
    this.status = this.capabilities?.aiScriptWriter
      ? 'Claude is writing the script and choosing visuals…'
      : 'Planning the storyboard…';

    try {
      const storyboard = await firstValueFrom(this.api.writeScript({
        category: this.settings.category,
        topic: this.settings.topic,
        duration: this.settings.duration,
        sourceContent: this.settings.sourceContent,
        visualStyle: this.settings.visualStyle
      }));

      this.storyboard = storyboard;
      this.scenes = storyboard.scenes.map(scene => ({ ...scene, visualData: { ...scene.visualData } }));
      this.result = undefined;
      this.submitted = undefined;
      this.status = storyboard.source === 'claude'
        ? `Script written by ${storyboard.model || 'Claude'} — ${this.scenes.length} scenes.`
        : `Storyboard planned locally — ${this.scenes.length} scenes.`;
    } catch (error) {
      this.error = this.messageFrom(error);
      this.status = 'Ready.';
    } finally {
      this.writingScript = false;
    }
  }

  // ------------------------------------------------------------ generation --

  async generate(): Promise<void> {
    if (this.generating) return;
    if (!this.scenes.length) {
      await this.writeScript();
      if (!this.scenes.length) return;
    }

    this.stopPreview?.();
    cancelAnimationFrame(this.idleHandle);
    this.error = '';
    this.generating = true;
    this.progress = 0;
    this.result = undefined;
    this.submitted = undefined;

    try {
      this.result = await this.producer.produce(
        this.stageRef.nativeElement,
        this.scenes,
        this.settings,
        update => {
          this.progress = update.percent;
          this.status = update.message;
        },
        { monitor: true, watermark: 'AWAITING CLINICAL REVIEW' }
      );
      this.status = `Video ready — ${(this.result.durationMs / 1000).toFixed(1)}s with AI voice.`;
    } catch (error) {
      this.error = this.messageFrom(error);
      this.status = 'Generation stopped.';
      this.startIdleLoop();
    } finally {
      this.generating = false;
    }
  }

  cancelGeneration(): void {
    this.producer.cancel();
  }

  download(): void {
    if (!this.result) return;
    const anchor = document.createElement('a');
    anchor.href = this.result.url;
    const slug = (this.settings.topic || 'medical-video')
      .toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
    anchor.download = `${slug || 'medical-video'}-${Date.now()}.webm`;
    anchor.click();
  }

  /** Play one scene with voice and lip sync, without recording. */
  async previewScene(index: number): Promise<void> {
    if (this.generating) return;
    this.stopPreview?.();

    if (this.previewingScene === index) {
      this.previewingScene = -1;
      this.startIdleLoop();
      return;
    }

    cancelAnimationFrame(this.idleHandle);
    this.previewingScene = index;
    this.error = '';

    try {
      this.stopPreview = await this.producer.previewScene(
        this.stageRef.nativeElement, this.scenes[index], this.settings,
        () => {
          this.previewingScene = -1;
          this.startIdleLoop();
        }
      );
    } catch (error) {
      this.error = this.messageFrom(error);
      this.previewingScene = -1;
      this.startIdleLoop();
    }
  }

  isPreviewing(index: number): boolean {
    return this.previewingScene === index;
  }

  // ---------------------------------------------------------------- review --

  async submitForReview(): Promise<void> {
    if (!this.result || this.submitting) return;
    if (!this.authorName.trim()) {
      this.error = 'Add your name so the reviewer knows who submitted this video.';
      return;
    }

    this.submitting = true;
    this.error = '';
    this.status = 'Submitting for clinical review…';

    try {
      const record = await firstValueFrom(this.api.submitForReview({
        title: this.storyboard?.title || this.settings.topic,
        topic: this.settings.topic,
        category: this.settings.category,
        summary: this.storyboard?.summary || '',
        storyboard: this.scenes,
        settings: this.settings,
        reviewNotes: this.storyboard?.reviewNotes || [],
        createdBy: this.authorName.trim()
      }));

      this.status = 'Uploading the video file…';
      await firstValueFrom(this.api.uploadMedia(record.id, this.result.blob, this.result.durationMs));

      this.submitted = { id: record.id, title: record.title };
      this.status = 'Submitted. It will appear to doctors once a reviewer approves it.';
    } catch (error) {
      this.error = this.messageFrom(error);
      this.status = 'Submission failed.';
    } finally {
      this.submitting = false;
    }
  }

  // ------------------------------------------------------- scene authoring --

  toggleScene(index: number): void {
    this.expandedScene = this.expandedScene === index ? -1 : index;
  }

  addScene(): void {
    this.scenes.push({
      title: `Scene ${this.scenes.length + 1}`,
      narration: 'Describe what the presenter should say here.',
      visualType: 'whiteboard',
      seconds: 7,
      highlight: '',
      visualData: { heading: 'New scene', points: ['First point'] }
    });
    this.expandedScene = this.scenes.length - 1;
  }

  removeScene(index: number): void {
    this.scenes.splice(index, 1);
    if (this.expandedScene >= this.scenes.length) this.expandedScene = -1;
  }

  moveScene(index: number, offset: number): void {
    const target = index + offset;
    if (target < 0 || target >= this.scenes.length) return;
    const [scene] = this.scenes.splice(index, 1);
    this.scenes.splice(target, 0, scene);
    this.expandedScene = target;
  }

  /** Comma-separated editing for the list fields, which keeps the form small. */
  listValue(scene: Scene, field: 'points' | 'steps' | 'labels' | 'leftItems' | 'rightItems'): string {
    return (scene.visualData[field] || []).join(' | ');
  }

  setListValue(scene: Scene, field: 'points' | 'steps' | 'labels' | 'leftItems' | 'rightItems', value: string): void {
    scene.visualData[field] = value.split('|').map(item => item.trim()).filter(Boolean);
  }

  /** Roughly how long the narration will take to speak, at ~165 wpm. */
  estimatedSeconds(scene: Scene): number {
    const words = scene.narration.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(2, Math.round((words / 165) * 60));
  }

  // ------------------------------------------------------------ idle stage --

  /**
   * Keep the presenter alive on the canvas when nothing is playing, so the
   * avatar is visible before anything is generated.
   */
  private startIdleLoop(): void {
    cancelAnimationFrame(this.idleHandle);
    const canvas = this.stageRef?.nativeElement;
    if (!canvas) return;

    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const started = performance.now();
    const scene: Scene = this.scenes[0] || {
      title: 'Preview',
      narration: 'Write a script to see the AI presenter explain your content.',
      visualType: 'avatar',
      seconds: 6,
      highlight: 'AI presenter, AI voice, lip sync',
      visualData: {
        heading: this.settings.topic || 'AI Medical Explainer',
        points: ['Script written by AI', 'Narrated by an AI voice', 'Lip sync driven by the audio']
      }
    };
    const previewScene: Scene = scene.visualType === 'avatar' ? scene : { ...scene, visualType: 'avatar' };

    const step = () => {
      const elapsed = performance.now() - started;
      this.sceneRenderer.render(ctx, {
        scene: previewScene,
        sceneIndex: 0,
        sceneCount: Math.max(1, this.scenes.length),
        sceneTimeMs: elapsed,
        sceneDurationMs: 10000,
        totalProgress: 0,
        // No audio is playing, so lip sync is off: the mouth idles closed.
        mouth: this.lipSync.mouthAt([], new Float32Array(0), elapsed, false),
        words: [],
        settings: this.settings,
        preset: this.avatars.presetFor(this.settings.avatar),
        speaking: false
      });
      this.idleHandle = requestAnimationFrame(step);
    };
    this.idleHandle = requestAnimationFrame(step);
  }

  private messageFrom(error: unknown): string {
    if (typeof error === 'object' && error !== null) {
      const candidate = error as { error?: { error?: string }; message?: string };
      return candidate.error?.error || candidate.message || 'Unexpected error.';
    }
    return String(error);
  }
}
