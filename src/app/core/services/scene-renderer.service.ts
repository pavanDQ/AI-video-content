import { Injectable } from '@angular/core';
import { GenerationSettings, OrganKind, Scene, WordFrame } from '../models/video.models';
import { AvatarPreset, AvatarRendererService } from './avatar-renderer.service';
import { MouthState } from './lip-sync.service';

/** Everything needed to draw one frame of the video. */
export interface SceneFrame {
  scene: Scene;
  sceneIndex: number;
  sceneCount: number;
  /** Elapsed time within this scene, in milliseconds. */
  sceneTimeMs: number;
  /** Duration of this scene, in milliseconds. */
  sceneDurationMs: number;
  /** Progress through the whole video, 0-1. */
  totalProgress: number;
  mouth: MouthState;
  words: WordFrame[];
  settings: GenerationSettings;
  preset: AvatarPreset;
  speaking: boolean;
  /** Shown bottom-right on unapproved renders. */
  watermark?: string;
}

/** The design is authored at 1280x720 and scaled to the output resolution. */
const WIDTH = 1280;
const HEIGHT = 720;

const INK = '#12263f';
const MUTED = '#5b6b7f';
const ACCENT = '#2f6fad';
const ACCENT_SOFT = '#e8f1fa';

@Injectable({ providedIn: 'root' })
export class SceneRendererService {
  constructor(private readonly avatars: AvatarRendererService) {}

  /**
   * Draw one frame.
   *
   * Everything is a pure function of `frame`, so the same inputs always produce
   * the same picture. That keeps a re-render after a reviewer's edit
   * comparable to the take it replaces.
   */
  render(ctx: CanvasRenderingContext2D, frame: SceneFrame): void {
    const canvas = ctx.canvas;
    ctx.setTransform(canvas.width / WIDTH, 0, 0, canvas.height / HEIGHT, 0, 0);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    this.drawBackdrop(ctx);
    this.drawHeader(ctx, frame);

    // Scenes fade in over their first 350ms, which hides the hard cut between
    // one narration track and the next. The opening scene is exempt: there is
    // no cut before it, and fading from zero would leave the video's first
    // frame — its poster and thumbnail — blank.
    const entry = frame.sceneIndex === 0 ? 1 : Math.min(1, frame.sceneTimeMs / 350);
    ctx.save();
    ctx.globalAlpha = entry;
    ctx.translate(0, (1 - entry) * 14);

    switch (frame.scene.visualType) {
      case 'avatar': this.drawAvatarScene(ctx, frame); break;
      case 'whiteboard': this.drawWhiteboardScene(ctx, frame); break;
      case 'diagram': this.drawDiagramScene(ctx, frame); break;
      case 'comparison': this.drawComparisonScene(ctx, frame); break;
      case 'medical-animation': this.drawProgressionScene(ctx, frame); break;
      case 'anatomy': this.drawAnatomyScene(ctx, frame); break;
    }

    ctx.restore();

    if (frame.settings.subtitles) this.drawSubtitles(ctx, frame);
    this.drawFooter(ctx, frame);
  }

  // ------------------------------------------------------------- chrome ----

  private drawBackdrop(ctx: CanvasRenderingContext2D): void {
    const wash = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
    wash.addColorStop(0, '#f7fbff');
    wash.addColorStop(1, '#e8eff7');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Faint grid: reads as a clinical slide rather than a blank page.
    ctx.strokeStyle = 'rgba(47,111,173,.055)';
    ctx.lineWidth = 1;
    for (let x = 0; x < WIDTH; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, HEIGHT);
      ctx.stroke();
    }
    for (let y = 0; y < HEIGHT; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(WIDTH, y + 0.5);
      ctx.stroke();
    }
  }

  private drawHeader(ctx: CanvasRenderingContext2D, frame: SceneFrame): void {
    const header = ctx.createLinearGradient(0, 0, WIDTH, 0);
    header.addColorStop(0, '#0f2f4f');
    header.addColorStop(1, '#1d4f80');
    ctx.fillStyle = header;
    ctx.fillRect(0, 0, WIDTH, 72);

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 25px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(frame.settings.topic || 'Medical Explainer', 36, 45);

    ctx.font = '600 14px "Helvetica Neue", Arial, sans-serif';
    ctx.fillStyle = 'rgba(219,234,254,.85)';
    const category = (frame.settings.category || 'Medical').toUpperCase();
    ctx.fillText(category, 36, 62);

    // Scene counter, right-aligned.
    ctx.textAlign = 'right';
    ctx.font = '600 15px "Helvetica Neue", Arial, sans-serif';
    ctx.fillStyle = 'rgba(219,234,254,.9)';
    ctx.fillText(`${frame.scene.title}  ·  ${frame.sceneIndex + 1}/${frame.sceneCount}`, WIDTH - 36, 45);
    ctx.textAlign = 'left';

    // Progress bar across the bottom of the header.
    ctx.fillStyle = 'rgba(255,255,255,.18)';
    ctx.fillRect(0, 69, WIDTH, 3);
    ctx.fillStyle = '#7fd3ff';
    ctx.fillRect(0, 69, WIDTH * frame.totalProgress, 3);
  }

  private drawFooter(ctx: CanvasRenderingContext2D, frame: SceneFrame): void {
    ctx.fillStyle = MUTED;
    ctx.font = '13px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(
      'For medical education. Verify clinical details against current guidelines before acting on them.',
      36, HEIGHT - 16
    );

    if (frame.watermark) {
      ctx.save();
      ctx.textAlign = 'right';
      ctx.font = '700 13px "Helvetica Neue", Arial, sans-serif';
      ctx.fillStyle = 'rgba(190,60,60,.75)';
      ctx.fillText(frame.watermark, WIDTH - 36, HEIGHT - 16);
      ctx.restore();
    }
  }

  /** Card that most scenes sit inside. */
  private drawCard(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
    ctx.save();
    ctx.shadowColor = 'rgba(15,47,79,.10)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 20);
    ctx.fill();
    ctx.restore();
  }

  private drawSceneHeading(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number): number {
    ctx.fillStyle = INK;
    ctx.font = '700 33px "Helvetica Neue", Arial, sans-serif';
    const lines = this.wrap(ctx, text, maxWidth);
    lines.forEach((line, index) => ctx.fillText(line, x, y + index * 40));

    // Accent rule under the heading.
    const bottom = y + (lines.length - 1) * 40 + 16;
    ctx.fillStyle = ACCENT;
    ctx.fillRect(x, bottom, 58, 4);
    return bottom + 22;
  }

  // -------------------------------------------------------------- scenes ----

  private drawAvatarScene(ctx: CanvasRenderingContext2D, frame: SceneFrame): void {
    this.drawCard(ctx, 32, 96, WIDTH - 64, 480);

    // Presenter on the left, inside a soft vignette.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(52, 112, 400, 448, 16);
    ctx.clip();

    const vignette = ctx.createRadialGradient(252, 300, 40, 252, 340, 330);
    vignette.addColorStop(0, '#dbeafe');
    vignette.addColorStop(1, '#eff4fa');
    ctx.fillStyle = vignette;
    ctx.fillRect(52, 112, 400, 448);

    this.avatars.draw(ctx, {
      x: 252, y: 300, scale: 1.02,
      mouth: frame.mouth, timeMs: frame.sceneTimeMs,
      preset: frame.preset, speaking: frame.speaking
    });
    ctx.restore();

    // "On air" chip.
    if (frame.speaking) {
      ctx.fillStyle = 'rgba(15,47,79,.72)';
      ctx.beginPath();
      ctx.roundRect(68, 128, 118, 30, 15);
      ctx.fill();
      ctx.fillStyle = '#ff6b6b';
      ctx.beginPath();
      ctx.arc(86, 143, 5 + Math.sin(frame.sceneTimeMs / 180) * 1.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 12px "Helvetica Neue", Arial, sans-serif';
      ctx.fillText('AI PRESENTER', 98, 147);
    }

    // Text panel on the right.
    const x = 496;
    const data = frame.scene.visualData;
    let y = this.drawSceneHeading(ctx, data.heading || frame.scene.title, x, 178, 700);

    if (frame.scene.highlight) {
      ctx.fillStyle = ACCENT;
      ctx.font = '600 22px "Helvetica Neue", Arial, sans-serif';
      this.wrap(ctx, frame.scene.highlight, 700).forEach((line, index) => ctx.fillText(line, x, y + index * 30));
      y += 52;
    }

    (data.points || []).forEach((point, index) => {
      const reveal = this.reveal(frame, index, 0.45);
      if (reveal <= 0) return;
      ctx.save();
      ctx.globalAlpha = reveal;
      this.drawBullet(ctx, point, x, y + index * 58, 690, index + 1);
      ctx.restore();
    });
  }

  private drawWhiteboardScene(ctx: CanvasRenderingContext2D, frame: SceneFrame): void {
    const x = 60;
    const y = 100;
    const width = WIDTH - 120;
    const height = 468;

    // Board.
    ctx.fillStyle = '#fffef8';
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 14);
    ctx.fill();
    ctx.strokeStyle = '#d7d3c4';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Tray.
    ctx.fillStyle = '#c9c2ae';
    ctx.beginPath();
    ctx.roundRect(x + 24, y + height - 4, width - 48, 12, 6);
    ctx.fill();

    const data = frame.scene.visualData;
    let cursorY = this.drawSceneHeading(ctx, data.heading || frame.scene.title, x + 46, y + 68, width - 120);

    const points = data.points || [];
    points.forEach((point, index) => {
      const reveal = this.reveal(frame, index, 0.55);
      if (reveal <= 0) return;

      const rowY = cursorY + index * 76;

      // A circle drawn as an arc that sweeps, as if by hand.
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(x + 74, rowY - 9, 13, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * reveal);
      ctx.stroke();

      ctx.fillStyle = ACCENT;
      ctx.font = '700 15px "Helvetica Neue", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.globalAlpha = reveal;
      ctx.fillText(String(index + 1), x + 74, rowY - 3);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;

      // The text wipes in left to right, like a marker stroke.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 104, rowY - 40, (width - 170) * reveal, 70);
      ctx.clip();
      ctx.fillStyle = INK;
      ctx.font = '500 25px "Helvetica Neue", Arial, sans-serif';
      this.wrap(ctx, point, width - 190).slice(0, 2).forEach((line, lineIndex) => {
        ctx.fillText(line, x + 104, rowY + lineIndex * 32);
      });
      ctx.restore();
    });

    // Marker following the most recent stroke.
    const active = points.findIndex((_, index) => {
      const reveal = this.reveal(frame, index, 0.55);
      return reveal > 0 && reveal < 1;
    });
    if (active >= 0) {
      const reveal = this.reveal(frame, active, 0.55);
      this.drawMarker(ctx, x + 104 + (width - 170) * reveal, cursorY + active * 76 + 6);
    }
  }

  private drawMarker(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.42);
    ctx.fillStyle = '#2b3a4d';
    ctx.beginPath();
    ctx.roundRect(-5, 0, 13, 58, 3);
    ctx.fill();
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.moveTo(-5, 0);
    ctx.lineTo(8, 0);
    ctx.lineTo(3, -13);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawDiagramScene(ctx: CanvasRenderingContext2D, frame: SceneFrame): void {
    this.drawCard(ctx, 32, 96, WIDTH - 64, 480);
    const data = frame.scene.visualData;
    const steps = (data.steps || []).slice(0, 5);
    const startY = this.drawSceneHeading(ctx, data.heading || 'Step by step', 76, 158, WIDTH - 200);

    const boxHeight = Math.min(66, (440 - startY + 96) / Math.max(1, steps.length) - 16);
    const boxWidth = WIDTH - 220;

    steps.forEach((step, index) => {
      const reveal = this.reveal(frame, index, 0.5);
      if (reveal <= 0) return;

      const y = startY + index * (boxHeight + 20);
      const isLast = index === steps.length - 1;

      ctx.save();
      ctx.globalAlpha = reveal;
      // Boxes slide in from the left as they appear.
      ctx.translate((1 - reveal) * -26, 0);

      ctx.fillStyle = isLast ? '#d7ebff' : ACCENT_SOFT;
      ctx.beginPath();
      ctx.roundRect(110, y, boxWidth, boxHeight, 12);
      ctx.fill();
      ctx.strokeStyle = isLast ? ACCENT : '#a8c8e6';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Numbered node on the left edge.
      ctx.fillStyle = ACCENT;
      ctx.beginPath();
      ctx.arc(110, y + boxHeight / 2, 19, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 17px "Helvetica Neue", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(index + 1), 110, y + boxHeight / 2 + 6);
      ctx.textAlign = 'left';

      ctx.fillStyle = INK;
      ctx.font = '500 22px "Helvetica Neue", Arial, sans-serif';
      const lines = this.wrap(ctx, step, boxWidth - 70).slice(0, 2);
      const textY = y + boxHeight / 2 + (lines.length === 1 ? 8 : -3);
      lines.forEach((line, lineIndex) => ctx.fillText(line, 146, textY + lineIndex * 27));

      ctx.restore();

      // Connector to the next box, with a pulse travelling along it.
      if (!isLast) {
        const nextReveal = this.reveal(frame, index + 1, 0.5);
        const connectorY = y + boxHeight;
        ctx.strokeStyle = '#a8c8e6';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(110, connectorY);
        ctx.lineTo(110, connectorY + 20);
        ctx.stroke();

        if (nextReveal > 0 && nextReveal < 1) {
          ctx.fillStyle = ACCENT;
          ctx.beginPath();
          ctx.arc(110, connectorY + 20 * nextReveal, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
  }

  private drawComparisonScene(ctx: CanvasRenderingContext2D, frame: SceneFrame): void {
    this.drawCard(ctx, 32, 96, WIDTH - 64, 480);
    const data = frame.scene.visualData;
    const startY = this.drawSceneHeading(ctx, data.heading || 'Comparison', 76, 158, WIDTH - 200);

    const columnWidth = 520;
    const columnHeight = 520 - startY + 130;

    this.drawComparisonColumn(
      ctx, 76, startY, columnWidth, columnHeight,
      data.leftTitle || 'Option A', data.leftItems || [], frame, -1
    );
    this.drawComparisonColumn(
      ctx, WIDTH - 76 - columnWidth, startY, columnWidth, columnHeight,
      data.rightTitle || 'Option B', data.rightItems || [], frame, 1
    );

    // "versus" divider.
    const centerY = startY + columnHeight / 2;
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.arc(WIDTH / 2, centerY, 25, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 15px "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('VS', WIDTH / 2, centerY + 5);
    ctx.textAlign = 'left';
  }

  private drawComparisonColumn(
    ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number,
    title: string, items: string[], frame: SceneFrame, direction: number
  ): void {
    // Columns slide in from opposite sides.
    const entry = Math.min(1, frame.sceneTimeMs / 500);
    ctx.save();
    ctx.globalAlpha = entry;
    ctx.translate(direction * (1 - entry) * 40, 0);

    ctx.fillStyle = '#f5f9fd';
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 16);
    ctx.fill();
    ctx.strokeStyle = '#c3d9ee';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Title band.
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    // Per-corner radii: rounded at the top only, so it seats on the column.
    ctx.roundRect(x, y, width, 52, [16, 16, 0, 0]);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 22px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(this.clip(ctx, title, width - 40), x + 22, y + 34);

    ctx.restore();

    items.slice(0, 4).forEach((item, index) => {
      const reveal = this.reveal(frame, index, 0.5, 400);
      if (reveal <= 0) return;
      ctx.save();
      ctx.globalAlpha = reveal * entry;
      const rowY = y + 92 + index * 62;

      ctx.fillStyle = ACCENT;
      ctx.beginPath();
      ctx.arc(x + 30, rowY - 7, 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = INK;
      ctx.font = '500 20px "Helvetica Neue", Arial, sans-serif';
      this.wrap(ctx, item, width - 70).slice(0, 2).forEach((line, lineIndex) => {
        ctx.fillText(line, x + 50, rowY + lineIndex * 25);
      });
      ctx.restore();
    });
  }

  private drawProgressionScene(ctx: CanvasRenderingContext2D, frame: SceneFrame): void {
    this.drawCard(ctx, 32, 96, WIDTH - 64, 480);
    const data = frame.scene.visualData;
    this.drawSceneHeading(ctx, data.heading || 'How it progresses', 76, 158, WIDTH - 200);

    const labels = (data.labels || ['Baseline', 'Change', 'Outcome']).slice(0, 3);
    const centers = [340, 640, 940];
    const centerY = 400;
    const seconds = frame.sceneTimeMs / 1000;

    // Connectors first, so the stages sit on top.
    labels.forEach((_, index) => {
      if (index === labels.length - 1) return;
      const from = centers[index] + 88;
      const to = centers[index + 1] - 88;
      const reveal = this.reveal(frame, index + 1, 0.5);

      ctx.strokeStyle = '#bcd6ee';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(from, centerY);
      ctx.lineTo(to, centerY);
      ctx.stroke();

      if (reveal > 0) {
        ctx.strokeStyle = ACCENT;
        ctx.beginPath();
        ctx.moveTo(from, centerY);
        ctx.lineTo(from + (to - from) * reveal, centerY);
        ctx.stroke();

        // Arrow head.
        const tipX = from + (to - from) * reveal;
        ctx.fillStyle = ACCENT;
        ctx.beginPath();
        ctx.moveTo(tipX, centerY);
        ctx.lineTo(tipX - 11, centerY - 8);
        ctx.lineTo(tipX - 11, centerY + 8);
        ctx.closePath();
        ctx.fill();
      }
    });

    labels.forEach((label, index) => {
      const reveal = this.reveal(frame, index, 0.5);
      if (reveal <= 0) return;

      const x = centers[index];
      const pulse = 1 + Math.sin(seconds * 2.6 + index * 1.1) * 0.045;
      const severity = index / Math.max(1, labels.length - 1);

      ctx.save();
      ctx.globalAlpha = reveal;
      ctx.translate(x, centerY);
      ctx.scale(pulse * (0.85 + reveal * 0.15), pulse * (0.85 + reveal * 0.15));

      // Colour shifts from calm blue to clinical red across the stages.
      const fill = ctx.createRadialGradient(-20, -24, 10, 0, 0, 86);
      fill.addColorStop(0, severity > 0.5 ? '#ffe9ea' : '#e9f3fd');
      fill.addColorStop(1, severity > 0.5 ? '#f7c5c8' : '#c9e0f5');
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(0, 0, 84, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = severity > 0.5 ? '#d97278' : ACCENT;
      ctx.lineWidth = 4;
      ctx.stroke();

      // Cells inside, multiplying as severity rises.
      const count = 3 + index * 4;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + seconds * 0.35;
        const radius = 22 + (i % 3) * 16;
        ctx.fillStyle = severity > 0.5 ? 'rgba(190,70,80,.5)' : 'rgba(47,111,173,.4)';
        ctx.beginPath();
        ctx.arc(Math.cos(angle) * radius, Math.sin(angle) * radius, 9, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();

      ctx.save();
      ctx.globalAlpha = reveal;
      ctx.fillStyle = INK;
      ctx.font = '700 20px "Helvetica Neue", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(this.clip(ctx, label, 230), x, centerY + 124);
      ctx.textAlign = 'left';
      ctx.restore();
    });
  }

  // ------------------------------------------------------------- anatomy ----

  private drawAnatomyScene(ctx: CanvasRenderingContext2D, frame: SceneFrame): void {
    this.drawCard(ctx, 32, 96, WIDTH - 64, 480);
    const data = frame.scene.visualData;
    this.drawSceneHeading(ctx, data.heading || 'Structures involved', 76, 158, 600);

    // Illustration on the right, labels on the left.
    const seconds = frame.sceneTimeMs / 1000;
    ctx.save();
    ctx.translate(900, 350);
    this.drawOrgan(ctx, data.organ || 'cell', seconds, frame.mouth.energy);
    ctx.restore();

    (data.labels || []).slice(0, 4).forEach((label, index) => {
      const reveal = this.reveal(frame, index, 0.5);
      if (reveal <= 0) return;
      ctx.save();
      ctx.globalAlpha = reveal;
      this.drawBullet(ctx, label, 90, 268 + index * 62, 500, index + 1);
      ctx.restore();
    });

    // A small presenter keeps the narrator present during illustration scenes.
    ctx.save();
    ctx.beginPath();
    ctx.arc(150, 505, 58, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#e4eef8';
    ctx.fillRect(92, 447, 116, 116);
    this.avatars.draw(ctx, {
      x: 150, y: 512, scale: 0.42,
      mouth: frame.mouth, timeMs: frame.sceneTimeMs,
      preset: frame.preset, speaking: frame.speaking
    });
    ctx.restore();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(150, 505, 58, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** Schematic organ illustrations, drawn about a 0,0 centre at ~220px tall. */
  private drawOrgan(ctx: CanvasRenderingContext2D, organ: OrganKind, seconds: number, energy: number): void {
    switch (organ) {
      case 'lungs': this.drawLungs(ctx, seconds); break;
      case 'heart': this.drawHeart(ctx, seconds); break;
      case 'brain': this.drawBrain(ctx, seconds); break;
      case 'kidney': this.drawKidney(ctx, seconds); break;
      case 'liver': this.drawLiver(ctx, seconds); break;
      case 'stomach': this.drawStomach(ctx, seconds); break;
      case 'bloodvessel': this.drawBloodVessel(ctx, seconds); break;
      default: this.drawCell(ctx, seconds, energy); break;
    }
  }

  /** Breathing lungs: the pleural outline expands and contracts. */
  private drawLungs(ctx: CanvasRenderingContext2D, seconds: number): void {
    // ~14 breaths per minute.
    const breath = (Math.sin(seconds * 1.45) + 1) / 2;
    const expand = 1 + breath * 0.075;

    // Trachea and main bronchi.
    ctx.strokeStyle = '#d7b8c4';
    ctx.lineWidth = 17;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -150);
    ctx.lineTo(0, -66);
    ctx.stroke();
    ctx.lineWidth = 12;
    [-1, 1].forEach(side => {
      ctx.beginPath();
      ctx.moveTo(0, -66);
      ctx.lineTo(side * 40, -30);
      ctx.stroke();
    });

    [-1, 1].forEach(side => {
      ctx.save();
      ctx.scale(side * expand, expand);

      const tissue = ctx.createRadialGradient(40, -20, 14, 56, 30, 130);
      tissue.addColorStop(0, '#f3c3cc');
      tissue.addColorStop(1, '#d4808f');
      ctx.fillStyle = tissue;

      ctx.beginPath();
      ctx.moveTo(16, -58);
      ctx.bezierCurveTo(66, -74, 116, -26, 112, 52);
      ctx.bezierCurveTo(110, 108, 78, 132, 46, 126);
      ctx.bezierCurveTo(20, 120, 14, 66, 16, -58);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#b4636f';
      ctx.lineWidth = 3;
      ctx.stroke();

      // Airway tree.
      ctx.strokeStyle = 'rgba(255,255,255,.55)';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(30, -34);
      ctx.lineTo(58, 16);
      ctx.moveTo(58, 16);
      ctx.lineTo(86, -4);
      ctx.moveTo(58, 16);
      ctx.lineTo(72, 66);
      ctx.moveTo(58, 16);
      ctx.lineTo(34, 62);
      ctx.stroke();

      ctx.restore();
    });

    this.drawOrganCaption(ctx, breath > 0.5 ? 'Inhalation' : 'Exhalation', 168);
  }

  /** Beating heart: systole and diastole, plus a contracting chamber. */
  private drawHeart(ctx: CanvasRenderingContext2D, seconds: number): void {
    // ~72 bpm, with a sharp systolic squeeze rather than a smooth sine.
    const cycle = (seconds * 1.2) % 1;
    const squeeze = cycle < 0.25
      ? Math.sin((cycle / 0.25) * Math.PI) * 0.09
      : 0;
    const scale = 1 - squeeze;

    ctx.save();
    ctx.scale(scale, scale);

    // Great vessels.
    ctx.strokeStyle = '#cf5f6c';
    ctx.lineWidth = 22;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-14, -104);
    ctx.quadraticCurveTo(26, -156, 66, -104);
    ctx.stroke();
    ctx.strokeStyle = '#6f8fc4';
    ctx.lineWidth = 17;
    ctx.beginPath();
    ctx.moveTo(-58, -96);
    ctx.quadraticCurveTo(-84, -136, -44, -150);
    ctx.stroke();

    const muscle = ctx.createRadialGradient(-26, -30, 16, 0, 20, 140);
    muscle.addColorStop(0, '#e3737f');
    muscle.addColorStop(1, '#a8323f');
    ctx.fillStyle = muscle;

    // Myocardium.
    ctx.beginPath();
    ctx.moveTo(0, -84);
    ctx.bezierCurveTo(-46, -128, -112, -88, -104, -18);
    ctx.bezierCurveTo(-98, 48, -38, 92, 2, 132);
    ctx.bezierCurveTo(44, 92, 104, 46, 108, -20);
    ctx.bezierCurveTo(112, -90, 46, -126, 0, -84);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#8a2130';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Coronary arteries.
    ctx.strokeStyle = 'rgba(255,215,215,.65)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(-6, -70);
    ctx.bezierCurveTo(-30, -20, -24, 40, 0, 100);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(6, -66);
    ctx.bezierCurveTo(50, -40, 60, 10, 44, 54);
    ctx.stroke();

    ctx.restore();

    // ECG-style trace under the heart, in step with the beat.
    this.drawEcg(ctx, seconds, 172);
  }

  private drawEcg(ctx: CanvasRenderingContext2D, seconds: number, y: number): void {
    ctx.save();
    ctx.translate(-150, y);
    ctx.strokeStyle = 'rgba(47,111,173,.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(300, 0);
    ctx.stroke();

    ctx.strokeStyle = '#2f9e6f';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    for (let x = 0; x <= 300; x++) {
      // One beat every 250px-equivalent, scrolling with time.
      const phase = ((x / 250) + seconds * 1.2) % 1;
      let amplitude = 0;
      if (phase < 0.08) amplitude = Math.sin(phase / 0.08 * Math.PI) * 4;          // P
      else if (phase < 0.13) amplitude = 0;
      else if (phase < 0.16) amplitude = -6;                                        // Q
      else if (phase < 0.20) amplitude = 30;                                        // R
      else if (phase < 0.24) amplitude = -12;                                       // S
      else if (phase < 0.42) amplitude = Math.sin((phase - 0.24) / 0.18 * Math.PI) * 8; // T
      if (x === 0) ctx.moveTo(x, -amplitude);
      else ctx.lineTo(x, -amplitude);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawBrain(ctx: CanvasRenderingContext2D, seconds: number): void {
    const tissue = ctx.createRadialGradient(-30, -40, 20, 0, 0, 150);
    tissue.addColorStop(0, '#f2cfd6');
    tissue.addColorStop(1, '#cf98a6');
    ctx.fillStyle = tissue;

    // Cerebrum.
    ctx.beginPath();
    ctx.moveTo(-118, 16);
    ctx.bezierCurveTo(-130, -78, -62, -134, 10, -128);
    ctx.bezierCurveTo(86, -122, 130, -64, 120, 8);
    ctx.bezierCurveTo(114, 52, 76, 74, 34, 70);
    ctx.bezierCurveTo(-24, 66, -110, 62, -118, 16);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#a9707f';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Sulci.
    ctx.strokeStyle = 'rgba(150,90,105,.6)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    const folds: [number, number, number, number, number, number][] = [
      [-92, -18, -56, -52, -18, -20], [-70, 24, -30, -8, 10, 26],
      [-16, -76, 22, -46, 62, -74], [16, 22, 56, -6, 96, 24],
      [46, -96, 74, -66, 104, -86], [-104, 40, -64, 56, -22, 48]
    ];
    folds.forEach(([x1, y1, cx, cy, x2, y2]) => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.quadraticCurveTo(cx, cy, x2, y2);
      ctx.stroke();
    });

    // Cerebellum and brainstem.
    ctx.fillStyle = '#bd8593';
    ctx.beginPath();
    ctx.ellipse(72, 82, 48, 30, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#a9707f';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#c9939f';
    ctx.beginPath();
    ctx.roundRect(4, 62, 34, 84, 16);
    ctx.fill();
    ctx.stroke();

    // Signal pulses travelling across the cortex.
    for (let i = 0; i < 3; i++) {
      const phase = (seconds * 0.55 + i / 3) % 1;
      const [x1, y1, , , x2, y2] = folds[i * 2];
      ctx.fillStyle = `rgba(90,200,255,${0.85 * (1 - phase)})`;
      ctx.beginPath();
      ctx.arc(x1 + (x2 - x1) * phase, y1 + (y2 - y1) * phase, 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawKidney(ctx: CanvasRenderingContext2D, seconds: number): void {
    [-1, 1].forEach(side => {
      ctx.save();
      ctx.translate(side * 72, 0);
      ctx.scale(side, 1);

      const tissue = ctx.createLinearGradient(-50, -100, 50, 100);
      tissue.addColorStop(0, '#c9707c');
      tissue.addColorStop(1, '#94434f');
      ctx.fillStyle = tissue;

      ctx.beginPath();
      ctx.moveTo(-6, -104);
      ctx.bezierCurveTo(54, -106, 66, -40, 62, 6);
      ctx.bezierCurveTo(58, 62, 30, 104, -10, 102);
      ctx.bezierCurveTo(-46, 100, -56, 56, -52, 0);
      ctx.bezierCurveTo(-48, -56, -40, -102, -6, -104);
      ctx.closePath();
      // The medial hilum indentation.
      ctx.fill();
      ctx.strokeStyle = '#7c303c';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.fillStyle = 'rgba(255,225,230,.45)';
      ctx.beginPath();
      ctx.ellipse(-16, 0, 20, 56, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    });

    // Ureters draining to the bladder, with filtrate moving down them.
    ctx.strokeStyle = '#d9a7b1';
    ctx.lineWidth = 9;
    [-1, 1].forEach(side => {
      ctx.beginPath();
      ctx.moveTo(side * 58, 86);
      ctx.quadraticCurveTo(side * 34, 140, 0, 162);
      ctx.stroke();
    });
    ctx.fillStyle = '#e8c4cc';
    ctx.beginPath();
    ctx.ellipse(0, 176, 38, 26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#c08a95';
    ctx.lineWidth = 3;
    ctx.stroke();

    for (let i = 0; i < 4; i++) {
      const phase = (seconds * 0.6 + i / 4) % 1;
      [-1, 1].forEach(side => {
        ctx.fillStyle = `rgba(255,240,180,${0.9 - phase * 0.6})`;
        ctx.beginPath();
        ctx.arc(side * 58 * (1 - phase), 86 + phase * 76, 4.5, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }

  private drawLiver(ctx: CanvasRenderingContext2D, _seconds: number): void {
    const tissue = ctx.createLinearGradient(-140, -70, 140, 90);
    tissue.addColorStop(0, '#9d5245');
    tissue.addColorStop(1, '#6f342c');
    ctx.fillStyle = tissue;

    // Right and left lobes.
    ctx.beginPath();
    ctx.moveTo(-138, -34);
    ctx.bezierCurveTo(-110, -84, 30, -92, 132, -58);
    ctx.bezierCurveTo(146, -18, 120, 52, 44, 74);
    ctx.bezierCurveTo(-20, 92, -122, 46, -138, -34);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#59261f';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Falciform ligament dividing the lobes.
    ctx.strokeStyle = 'rgba(255,220,200,.4)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(24, -84);
    ctx.quadraticCurveTo(14, -10, 34, 72);
    ctx.stroke();

    // Gallbladder.
    ctx.fillStyle = '#88a94f';
    ctx.beginPath();
    ctx.ellipse(-34, 58, 26, 17, -0.35, 0, Math.PI * 2);
    ctx.fill();

    // Portal vessels.
    ctx.strokeStyle = 'rgba(120,160,210,.55)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(-70, 16);
    ctx.bezierCurveTo(-30, -6, 10, 10, 60, -8);
    ctx.moveTo(-40, 30);
    ctx.bezierCurveTo(-10, 40, 30, 30, 76, 22);
    ctx.stroke();
  }

  private drawStomach(ctx: CanvasRenderingContext2D, seconds: number): void {
    // Peristaltic wave squeezing the body of the stomach.
    const wave = Math.sin(seconds * 1.6);

    const tissue = ctx.createLinearGradient(-90, -110, 90, 110);
    tissue.addColorStop(0, '#e0a091');
    tissue.addColorStop(1, '#b96e5f');
    ctx.fillStyle = tissue;

    ctx.beginPath();
    ctx.moveTo(-58, -118);
    ctx.bezierCurveTo(-8, -126, 46, -92, 62, -30);
    ctx.bezierCurveTo(76, 34, 42, 92, -14, 96);
    ctx.bezierCurveTo(-70, 100, -92, 40, -84, -22);
    ctx.bezierCurveTo(-80, -70, -84, -112, -58, -118);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#95503f';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Oesophagus in, duodenum out.
    ctx.strokeStyle = '#d9a294';
    ctx.lineWidth = 20;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-54, -156);
    ctx.lineTo(-48, -114);
    ctx.stroke();
    ctx.lineWidth = 17;
    ctx.beginPath();
    ctx.moveTo(24, 84);
    ctx.quadraticCurveTo(76, 108, 88, 156);
    ctx.stroke();

    // Rugae, shifting with the wave.
    ctx.strokeStyle = 'rgba(255,225,215,.45)';
    ctx.lineWidth = 5;
    for (let i = 0; i < 4; i++) {
      const y = -70 + i * 44;
      ctx.beginPath();
      ctx.moveTo(-70, y);
      ctx.quadraticCurveTo(-10 + wave * 14, y + 16, 50, y + 4);
      ctx.stroke();
    }
  }

  /** Vessel cross-section with flowing blood and an atherosclerotic plaque. */
  private drawBloodVessel(ctx: CanvasRenderingContext2D, seconds: number): void {
    const halfLength = 170;
    const radius = 62;

    // Vessel wall.
    ctx.fillStyle = '#e4b3b9';
    ctx.beginPath();
    ctx.roundRect(-halfLength, -radius, halfLength * 2, radius * 2, 26);
    ctx.fill();
    ctx.strokeStyle = '#c1858e';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Lumen.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(-halfLength + 12, -radius + 12, (halfLength - 12) * 2, (radius - 12) * 2, 18);
    ctx.clip();
    ctx.fillStyle = '#7f1d2a';
    ctx.fillRect(-halfLength, -radius, halfLength * 2, radius * 2);

    // Plaque narrowing the lumen on one side.
    ctx.fillStyle = '#e8d9a8';
    ctx.beginPath();
    ctx.moveTo(-10, -radius + 10);
    ctx.bezierCurveTo(34, -radius + 8, 58, -20, 96, -radius + 12);
    ctx.lineTo(96, -radius);
    ctx.lineTo(-10, -radius);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#c9b57e';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Red cells, speeding up through the stenosis.
    for (let i = 0; i < 14; i++) {
      const base = (seconds * 0.24 + i / 14) % 1;
      const x = -halfLength + base * halfLength * 2;
      // Constriction pushes cells downward and closer together.
      const narrowing = x > -10 && x < 96 ? 20 : 0;
      const y = Math.sin(i * 2.4) * (radius - 26 - narrowing) + narrowing * 0.6;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin(seconds * 2 + i) * 0.3);
      ctx.fillStyle = '#d64550';
      ctx.beginPath();
      ctx.ellipse(0, 0, 13, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      // Biconcave centre.
      ctx.fillStyle = 'rgba(140,30,40,.55)';
      ctx.beginPath();
      ctx.ellipse(0, 0, 6, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    this.drawOrganCaption(ctx, 'Narrowed lumen restricts flow', radius + 54);
  }

  /** A cell that progresses through mitosis while the scene plays. */
  private drawCell(ctx: CanvasRenderingContext2D, seconds: number, energy: number): void {
    const cycle = (seconds / 7) % 1;
    // Separation of the two daughter nuclei.
    const split = cycle < 0.5 ? 0 : Math.min(1, (cycle - 0.5) / 0.4);
    const offset = split * 52;

    // Membrane, pinching in as the cell divides.
    const membrane = ctx.createRadialGradient(-30, -34, 20, 0, 0, 150);
    membrane.addColorStop(0, '#cfe6f8');
    membrane.addColorStop(1, '#8fbcdf');
    ctx.fillStyle = membrane;

    ctx.beginPath();
    if (split < 0.05) {
      ctx.ellipse(0, 0, 132, 118, 0, 0, Math.PI * 2);
    } else {
      // Two overlapping lobes with a cleavage furrow between them.
      const waist = 118 * (1 - split * 0.78);
      ctx.moveTo(-132, 0);
      ctx.bezierCurveTo(-132, -118, -offset, -118, -offset * 0.5, -waist);
      ctx.bezierCurveTo(0, -waist * 0.72, 0, -waist * 0.72, offset * 0.5, -waist);
      ctx.bezierCurveTo(offset, -118, 132, -118, 132, 0);
      ctx.bezierCurveTo(132, 118, offset, 118, offset * 0.5, waist);
      ctx.bezierCurveTo(0, waist * 0.72, 0, waist * 0.72, -offset * 0.5, waist);
      ctx.bezierCurveTo(-offset, 118, -132, 118, -132, 0);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#5d95c4';
    ctx.lineWidth = 5;
    ctx.stroke();

    // Cytoplasmic organelles.
    for (let i = 0; i < 9; i++) {
      const angle = (i / 9) * Math.PI * 2 + seconds * 0.22;
      const radius = 64 + (i % 3) * 20;
      ctx.fillStyle = 'rgba(80,150,200,.28)';
      ctx.beginPath();
      ctx.ellipse(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.82, 15, 9, angle, 0, Math.PI * 2);
      ctx.fill();
    }

    // Nuclei.
    const nuclei: number[] = split < 0.05 ? [0] : [-offset, offset];
    nuclei.forEach(x => {
      const nucleus = ctx.createRadialGradient(x - 10, -10, 6, x, 0, 50);
      nucleus.addColorStop(0, '#8a5fbf');
      nucleus.addColorStop(1, '#5c3487');
      ctx.fillStyle = nucleus;
      ctx.beginPath();
      ctx.arc(x, 0, 44, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#472768';
      ctx.lineWidth = 3;
      ctx.stroke();

      // Chromatin.
      ctx.strokeStyle = 'rgba(230,210,255,.65)';
      ctx.lineWidth = 4;
      for (let i = 0; i < 4; i++) {
        const angle = i * 1.4 + seconds * 0.5;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(angle) * 8, Math.sin(angle) * 8);
        ctx.quadraticCurveTo(
          x + Math.cos(angle + 1) * 26, Math.sin(angle + 1) * 26,
          x + Math.cos(angle + 2) * 16, Math.sin(angle + 2) * 16
        );
        ctx.stroke();
      }
    });

    // Spindle fibres during separation.
    if (split > 0.05 && split < 0.95) {
      ctx.strokeStyle = `rgba(255,255,255,${0.7 * (1 - split)})`;
      ctx.lineWidth = 2;
      for (let i = -3; i <= 3; i++) {
        ctx.beginPath();
        ctx.moveTo(-offset, i * 12);
        ctx.lineTo(offset, i * 12);
        ctx.stroke();
      }
    }

    const caption = split < 0.05 ? 'Interphase' : split < 0.9 ? 'Dividing' : 'Two daughter cells';
    this.drawOrganCaption(ctx, caption, 158 + energy * 2);
  }

  private drawOrganCaption(ctx: CanvasRenderingContext2D, text: string, y: number): void {
    ctx.save();
    ctx.font = '600 16px "Helvetica Neue", Arial, sans-serif';
    const width = ctx.measureText(text).width + 30;
    ctx.fillStyle = 'rgba(18,38,63,.82)';
    ctx.beginPath();
    ctx.roundRect(-width / 2, y - 20, width, 30, 15);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(text, 0, y);
    ctx.restore();
  }

  // ----------------------------------------------------------- subtitles ----

  /**
   * Subtitles with the spoken word highlighted.
   *
   * The highlight comes from the same engine timings that drive the mouth, so
   * caption, voice and lips all agree.
   */
  private drawSubtitles(ctx: CanvasRenderingContext2D, frame: SceneFrame): void {
    const words = frame.words;
    if (!words.length) return;

    const spokenIndex = this.spokenWordIndex(words, frame.sceneTimeMs);

    // Show a window around the current word rather than the whole paragraph.
    ctx.font = '500 21px "Helvetica Neue", Arial, sans-serif';
    const maxWidth = WIDTH - 260;
    const lines = this.wrapWords(ctx, words, maxWidth);
    const activeLine = lines.find(line => spokenIndex >= line.from && spokenIndex <= line.to) || lines[0];
    const lineIndex = lines.indexOf(activeLine);
    const visible = lines.slice(lineIndex, lineIndex + 2);
    if (!visible.length) return;

    const boxHeight = 30 + visible.length * 30;
    const boxY = HEIGHT - 52 - boxHeight;

    ctx.save();
    ctx.fillStyle = 'rgba(9,20,34,.82)';
    ctx.beginPath();
    ctx.roundRect(110, boxY, WIDTH - 220, boxHeight, 12);
    ctx.fill();

    visible.forEach((line, row) => {
      const y = boxY + 34 + row * 30;
      let x = 130;
      for (let index = line.from; index <= line.to; index++) {
        const word = words[index];
        const isSpoken = index === spokenIndex;
        ctx.fillStyle = isSpoken ? '#7fd3ff' : index < spokenIndex ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.55)';
        ctx.font = isSpoken
          ? '700 21px "Helvetica Neue", Arial, sans-serif'
          : '500 21px "Helvetica Neue", Arial, sans-serif';
        ctx.fillText(word.text, x, y);
        x += ctx.measureText(`${word.text} `).width;
      }
    });
    ctx.restore();
  }

  private spokenWordIndex(words: WordFrame[], timeMs: number): number {
    let index = 0;
    while (index < words.length - 1 && words[index + 1].t <= timeMs) index++;
    return index;
  }

  /** Group words into lines that fit, keeping their indices. */
  private wrapWords(
    ctx: CanvasRenderingContext2D, words: WordFrame[], maxWidth: number
  ): { from: number; to: number }[] {
    const lines: { from: number; to: number }[] = [];
    let from = 0;
    let width = 0;

    words.forEach((word, index) => {
      const wordWidth = ctx.measureText(`${word.text} `).width;
      if (width + wordWidth > maxWidth && index > from) {
        lines.push({ from, to: index - 1 });
        from = index;
        width = 0;
      }
      width += wordWidth;
    });
    lines.push({ from, to: words.length - 1 });
    return lines;
  }

  // --------------------------------------------------------------- utils ----

  private drawBullet(
    ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, number: number
  ): void {
    ctx.fillStyle = ACCENT_SOFT;
    ctx.beginPath();
    ctx.arc(x + 13, y - 8, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ACCENT;
    ctx.font = '700 14px "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(number), x + 13, y - 3);
    ctx.textAlign = 'left';

    ctx.fillStyle = '#334155';
    ctx.font = '500 21px "Helvetica Neue", Arial, sans-serif';
    this.wrap(ctx, text, maxWidth - 46).slice(0, 2).forEach((line, index) => {
      ctx.fillText(line, x + 40, y + index * 26);
    });
  }

  /**
   * How far a staged element has revealed itself.
   *
   * Items appear in sequence rather than all at once, so the visual keeps pace
   * with the narration instead of giving everything away in the first frame.
   */
  private reveal(frame: SceneFrame, index: number, staggerSeconds: number, delayMs = 250): number {
    const start = delayMs + index * staggerSeconds * 1000;
    const elapsed = frame.sceneTimeMs - start;
    if (elapsed <= 0) return 0;
    return Math.min(1, elapsed / 420);
  }

  private wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  private clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let result = text;
    while (result.length > 1 && ctx.measureText(`${result}…`).width > maxWidth) {
      result = result.slice(0, -1);
    }
    return `${result}…`;
  }
}
