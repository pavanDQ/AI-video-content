import { Injectable } from '@angular/core';
import { Avatar3dService } from './avatar-3d.service';
import { MouthState } from './lip-sync.service';

export interface AvatarPreset {
  id: string;
  label: string;
  skin: string;
  skinShadow: string;
  hair: string;
  hairStyle: 'short' | 'tiedBack' | 'cropped';
  coat: 'clinical' | 'scrubs' | 'blazer';
  coatColor: string;
  shirt: string;
  accent: string;
  stethoscope: boolean;
  /**
   * A 3D model to present with. The drawn fields above are its fallback while
   * the model loads, or when WebGL is unavailable.
   */
  model?: string;
}

export const AVATAR_PRESETS: AvatarPreset[] = [
  {
    id: '3D Presenter', label: '3D presenter (realistic)', model: 'assets/avatars/presenter.glb',
    skin: '#d9a273', skinShadow: '#b57f52', hair: '#1d1712', hairStyle: 'tiedBack',
    coat: 'clinical', coatColor: '#f7fafc', shirt: '#b8cfe6', accent: '#123b63', stethoscope: true
  },
  {
    id: 'Doctor Avatar', label: 'Doctor (white coat)',
    skin: '#e8b98f', skinShadow: '#c99266', hair: '#2b2118', hairStyle: 'short',
    coat: 'clinical', coatColor: '#f7fafc', shirt: '#7aa7d4', accent: '#123b63', stethoscope: true
  },
  {
    id: 'Consultant Avatar', label: 'Consultant (tied back)',
    skin: '#d9a273', skinShadow: '#b57f52', hair: '#1d1712', hairStyle: 'tiedBack',
    coat: 'clinical', coatColor: '#f7fafc', shirt: '#b8cfe6', accent: '#123b63', stethoscope: true
  },
  {
    id: 'Surgeon Avatar', label: 'Surgeon (scrubs)',
    skin: '#c48b5f', skinShadow: '#9d6a43', hair: '#171310', hairStyle: 'cropped',
    coat: 'scrubs', coatColor: '#2f7d84', shirt: '#2f7d84', accent: '#0f4c52', stethoscope: false
  },
  {
    id: 'Presenter Avatar', label: 'Presenter (blazer)',
    skin: '#f0c39c', skinShadow: '#cf9b70', hair: '#3a2a1c', hairStyle: 'short',
    coat: 'blazer', coatColor: '#1f3a5f', shirt: '#ffffff', accent: '#4b83c5', stethoscope: false
  }
];

export interface AvatarFrame {
  /** Centre of the head. */
  x: number;
  y: number;
  /** 1 renders a head of roughly 200px. */
  scale: number;
  mouth: MouthState;
  /** Elapsed scene time, for blinking, breathing and idle motion. */
  timeMs: number;
  preset: AvatarPreset;
  speaking: boolean;
}

/**
 * Procedural AI presenter.
 *
 * Drawn rather than composited from photo layers, so it needs no licensed
 * assets and can be posed frame by frame from the lip-sync state. The parts
 * that sell it as a person are the ones that never stop moving: the jaw tracks
 * the mouth opening, the head drifts with the voice, the eyes blink and
 * saccade, and the chest breathes.
 */
@Injectable({ providedIn: 'root' })
export class AvatarRendererService {
  constructor(private readonly avatar3d: Avatar3dService) {}

  /** Resolve once the preset's 3D model (if any) is ready or has failed. */
  async preload(id: string): Promise<void> {
    const model = this.presetFor(id).model;
    if (model) await this.avatar3d.load(model);
  }

  draw(ctx: CanvasRenderingContext2D, frame: AvatarFrame): void {
    const model = frame.preset.model;
    if (model) {
      if (this.avatar3d.isReady(model)) {
        this.avatar3d.draw(ctx, model, frame);
        return;
      }
      // Show the drawn presenter until the model arrives.
      void this.avatar3d.load(model);
    }

    const { x, y, scale, mouth, timeMs, preset, speaking } = frame;
    const seconds = timeMs / 1000;

    // Idle motion. Two out-of-phase sines read as organic; one reads as a
    // metronome. Energy from the voice adds emphasis on stressed syllables.
    const energy = speaking ? mouth.energy : 0;
    const sway = Math.sin(seconds * 0.7) * 3.2 + Math.sin(seconds * 1.9) * 1.1;
    const nod = Math.sin(seconds * 0.9) * 2.4 + energy * 2.6;
    const tilt = (Math.sin(seconds * 0.45) * 1.6 + energy * 1.2) * Math.PI / 180;
    const breathe = Math.sin(seconds * 1.15) * 1.6;

    ctx.save();
    ctx.translate(x + sway, y + nod);
    ctx.scale(scale, scale);

    this.drawTorso(ctx, preset, breathe, sway);
    this.drawNeck(ctx, preset);

    ctx.save();
    ctx.rotate(tilt);
    this.drawHead(ctx, preset, mouth, seconds, energy);
    ctx.restore();

    ctx.restore();
  }

  presetFor(id: string): AvatarPreset {
    return AVATAR_PRESETS.find(preset => preset.id === id) || AVATAR_PRESETS[0];
  }

  // ---------------------------------------------------------------- torso ---

  private drawTorso(ctx: CanvasRenderingContext2D, preset: AvatarPreset, breathe: number, sway: number): void {
    const shoulderY = 118;
    const halfWidth = 132 + breathe * 0.5;

    // Shoulders and chest as one rounded silhouette.
    ctx.save();
    ctx.translate(-sway * 0.35, 0);

    const body = ctx.createLinearGradient(-halfWidth, shoulderY, halfWidth, shoulderY + 200);
    body.addColorStop(0, this.shade(preset.coatColor, -0.1));
    body.addColorStop(0.45, preset.coatColor);
    body.addColorStop(1, this.shade(preset.coatColor, -0.16));
    ctx.fillStyle = body;

    ctx.beginPath();
    ctx.moveTo(-halfWidth, 330);
    ctx.lineTo(-halfWidth + 6, shoulderY + 52);
    ctx.quadraticCurveTo(-halfWidth + 14, shoulderY - 4, -58, shoulderY - 16);
    ctx.lineTo(58, shoulderY - 16);
    ctx.quadraticCurveTo(halfWidth - 14, shoulderY - 4, halfWidth - 6, shoulderY + 52);
    ctx.lineTo(halfWidth, 330);
    ctx.closePath();
    ctx.fill();

    // Shirt or scrub top showing at the neckline.
    ctx.fillStyle = preset.shirt;
    ctx.beginPath();
    ctx.moveTo(-42, shoulderY - 14);
    ctx.quadraticCurveTo(0, shoulderY + 58, 42, shoulderY - 14);
    ctx.lineTo(42, 330);
    ctx.lineTo(-42, 330);
    ctx.closePath();
    ctx.fill();

    if (preset.coat === 'clinical' || preset.coat === 'blazer') {
      // Lapels: two mirrored wedges framing the neckline.
      ctx.fillStyle = this.shade(preset.coatColor, -0.07);
      [-1, 1].forEach(side => {
        ctx.beginPath();
        ctx.moveTo(side * 40, shoulderY - 14);
        ctx.quadraticCurveTo(side * 30, shoulderY + 90, side * 68, 330);
        ctx.lineTo(side * 108, 330);
        ctx.quadraticCurveTo(side * 96, shoulderY + 40, side * 58, shoulderY - 16);
        ctx.closePath();
        ctx.fill();
      });

      ctx.strokeStyle = this.shade(preset.coatColor, -0.22);
      ctx.lineWidth = 1.6;
      [-1, 1].forEach(side => {
        ctx.beginPath();
        ctx.moveTo(side * 40, shoulderY - 12);
        ctx.quadraticCurveTo(side * 30, shoulderY + 90, side * 68, 330);
        ctx.stroke();
      });
    }

    if (preset.coat === 'scrubs') {
      // V-neck.
      ctx.strokeStyle = this.shade(preset.coatColor, -0.3);
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(-44, shoulderY - 12);
      ctx.lineTo(0, shoulderY + 62);
      ctx.lineTo(44, shoulderY - 12);
      ctx.stroke();
    }

    if (preset.stethoscope) this.drawStethoscope(ctx, preset, shoulderY, breathe);

    ctx.restore();
  }

  private drawStethoscope(ctx: CanvasRenderingContext2D, preset: AvatarPreset, shoulderY: number, breathe: number): void {
    ctx.strokeStyle = '#243447';
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';

    // Tubing draped around the neck, hanging down both sides.
    ctx.beginPath();
    ctx.moveTo(-52, shoulderY + 4);
    ctx.quadraticCurveTo(-72, shoulderY + 120 + breathe, -58, shoulderY + 196 + breathe);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(52, shoulderY + 4);
    ctx.quadraticCurveTo(80, shoulderY + 110 + breathe, 46, shoulderY + 168 + breathe);
    ctx.stroke();

    // Chest piece.
    ctx.beginPath();
    ctx.arc(46, shoulderY + 182 + breathe, 15, 0, Math.PI * 2);
    ctx.fillStyle = '#cbd5e1';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#94a3b8';
    ctx.stroke();

    // Ear tips.
    ctx.fillStyle = '#243447';
    ctx.beginPath();
    ctx.arc(-58, shoulderY + 200 + breathe, 7, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawNeck(ctx: CanvasRenderingContext2D, preset: AvatarPreset): void {
    const neck = ctx.createLinearGradient(-32, 60, 32, 60);
    neck.addColorStop(0, preset.skinShadow);
    neck.addColorStop(0.4, preset.skin);
    neck.addColorStop(1, this.shade(preset.skin, -0.14));
    ctx.fillStyle = neck;
    ctx.beginPath();
    ctx.moveTo(-33, 52);
    ctx.lineTo(-37, 130);
    ctx.lineTo(37, 130);
    ctx.lineTo(33, 52);
    ctx.closePath();
    ctx.fill();

    // Shadow the jaw casts on the neck; without it the head looks pasted on.
    ctx.fillStyle = 'rgba(0,0,0,.16)';
    ctx.beginPath();
    ctx.ellipse(0, 58, 42, 17, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // ----------------------------------------------------------------- head ---

  private drawHead(
    ctx: CanvasRenderingContext2D, preset: AvatarPreset, mouth: MouthState, seconds: number, energy: number
  ): void {
    // The jaw drops as the mouth opens, so the whole lower face moves with
    // speech rather than only the lips.
    const jawDrop = mouth.height * 26;

    ctx.save();

    // --- skull ---
    const face = ctx.createRadialGradient(-26, -34, 18, 0, 6, 122);
    face.addColorStop(0, this.shade(preset.skin, 0.1));
    face.addColorStop(0.62, preset.skin);
    face.addColorStop(1, preset.skinShadow);
    ctx.fillStyle = face;

    ctx.beginPath();
    // Cranium.
    ctx.moveTo(-82, -12);
    ctx.bezierCurveTo(-82, -96, -46, -128, 0, -128);
    ctx.bezierCurveTo(46, -128, 82, -96, 82, -12);
    // Cheeks tapering into the chin, which follows the jaw.
    ctx.bezierCurveTo(82, 34, 62, 60 + jawDrop * 0.5, 34, 72 + jawDrop);
    ctx.bezierCurveTo(20, 80 + jawDrop, -20, 80 + jawDrop, -34, 72 + jawDrop);
    ctx.bezierCurveTo(-62, 60 + jawDrop * 0.5, -82, 34, -82, -12);
    ctx.closePath();
    ctx.fill();

    this.drawEars(ctx, preset);
    this.drawHair(ctx, preset);
    this.drawBrows(ctx, preset, energy, seconds);
    this.drawEyes(ctx, preset, seconds);
    this.drawNose(ctx, preset);
    this.drawCheeks(ctx, preset, energy);
    this.drawMouth(ctx, preset, mouth, jawDrop);

    ctx.restore();
  }

  private drawEars(ctx: CanvasRenderingContext2D, preset: AvatarPreset): void {
    [-1, 1].forEach(side => {
      ctx.fillStyle = preset.skin;
      ctx.beginPath();
      ctx.ellipse(side * 82, 2, 13, 22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = this.shade(preset.skinShadow, -0.1);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(side * 82, 2, 6, 12, 0, 0, Math.PI * 2);
      ctx.stroke();
    });
  }

  private drawHair(ctx: CanvasRenderingContext2D, preset: AvatarPreset): void {
    const hair = ctx.createLinearGradient(-80, -130, 80, -10);
    hair.addColorStop(0, this.shade(preset.hair, 0.16));
    hair.addColorStop(0.5, preset.hair);
    hair.addColorStop(1, this.shade(preset.hair, -0.2));
    ctx.fillStyle = hair;

    if (preset.hairStyle === 'tiedBack') {
      // Bun behind the head, drawn first so the skull overlaps it.
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, -108, 34, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.beginPath();
    ctx.moveTo(-84, -6);
    ctx.bezierCurveTo(-88, -100, -48, -134, 0, -134);
    ctx.bezierCurveTo(48, -134, 88, -100, 84, -6);
    // Hairline: a slight widow's peak reads as a face rather than a helmet.
    ctx.bezierCurveTo(70, -34, 58, -52, 38, -58);
    ctx.bezierCurveTo(18, -64, 8, -50, 0, -50);
    ctx.bezierCurveTo(-8, -50, -18, -64, -38, -58);
    ctx.bezierCurveTo(-58, -52, -70, -34, -84, -6);
    ctx.closePath();
    ctx.fill();

    if (preset.hairStyle === 'short') {
      // A parted sweep across the forehead.
      ctx.fillStyle = this.shade(preset.hair, 0.07);
      ctx.beginPath();
      ctx.moveTo(-44, -62);
      ctx.bezierCurveTo(-12, -82, 36, -84, 62, -56);
      ctx.bezierCurveTo(34, -70, -8, -68, -44, -62);
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawBrows(ctx: CanvasRenderingContext2D, preset: AvatarPreset, energy: number, seconds: number): void {
    // Brows rise on emphasis. This is what makes a talking head look engaged
    // rather than sedated.
    const lift = energy * 5 + Math.sin(seconds * 0.6) * 1.2;
    ctx.strokeStyle = this.shade(preset.hair, -0.02);
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';

    // Started from the inner corner of each eye, not the bridge of the nose —
    // brows that meet in the middle read as a permanent scowl.
    [-1, 1].forEach(side => {
      ctx.beginPath();
      ctx.moveTo(side * 21, -42 - lift);
      ctx.quadraticCurveTo(side * 38, -52 - lift * 1.25, side * 55, -43 - lift * 0.7);
      ctx.stroke();
    });
  }

  private drawEyes(ctx: CanvasRenderingContext2D, preset: AvatarPreset, seconds: number): void {
    const openness = this.blinkOpenness(seconds);

    // Gaze holds the camera but drifts slightly; a perfectly fixed stare is
    // unsettling.
    const gazeX = Math.sin(seconds * 0.33) * 2.4 + Math.sin(seconds * 1.7) * 0.7;
    const gazeY = Math.sin(seconds * 0.51) * 1.3;

    [-1, 1].forEach(side => {
      const centerX = side * 36;
      const centerY = -18;
      const halfWidth = 21;
      const halfHeight = 13 * openness;

      ctx.save();

      // Eye socket shadow.
      ctx.fillStyle = 'rgba(0,0,0,.07)';
      ctx.beginPath();
      ctx.ellipse(centerX, centerY + 1, halfWidth + 5, 16, 0, 0, Math.PI * 2);
      ctx.fill();

      if (halfHeight < 1.2) {
        // Closed: a lid line, not a slit of white.
        ctx.strokeStyle = this.shade(preset.skinShadow, -0.35);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(centerX - halfWidth, centerY);
        ctx.quadraticCurveTo(centerX, centerY + 5, centerX + halfWidth, centerY);
        ctx.stroke();
        ctx.restore();
        return;
      }

      // Sclera, clipped so the iris cannot spill outside the lids.
      ctx.beginPath();
      ctx.ellipse(centerX, centerY, halfWidth, halfHeight, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#fbfdff';
      ctx.fill();
      ctx.save();
      ctx.clip();

      const irisX = centerX + gazeX;
      const irisY = centerY + gazeY;

      const iris = ctx.createRadialGradient(irisX - 2, irisY - 2, 1, irisX, irisY, 10);
      iris.addColorStop(0, '#6f9bbf');
      iris.addColorStop(0.55, '#3f6a8f');
      iris.addColorStop(1, '#1f3c56');
      ctx.fillStyle = iris;
      ctx.beginPath();
      ctx.arc(irisX, irisY, 9.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#101b28';
      ctx.beginPath();
      ctx.arc(irisX, irisY, 4.4, 0, Math.PI * 2);
      ctx.fill();

      // Catchlight. Small, but it is most of what makes eyes look wet.
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.beginPath();
      ctx.arc(irisX - 3.6, irisY - 4, 2.6, 0, Math.PI * 2);
      ctx.fill();

      // Upper lid casts a shadow on the eyeball.
      ctx.fillStyle = 'rgba(0,0,0,.14)';
      ctx.beginPath();
      ctx.ellipse(centerX, centerY - halfHeight - 3, halfWidth, 7, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();

      // Lash line.
      ctx.strokeStyle = '#2a2018';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(centerX, centerY, halfWidth, halfHeight, 0, Math.PI, Math.PI * 2);
      ctx.stroke();

      // Lower lid.
      ctx.strokeStyle = this.shade(preset.skinShadow, -0.12);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(centerX, centerY, halfWidth - 1, halfHeight, 0, 0, Math.PI);
      ctx.stroke();

      ctx.restore();
    });
  }

  /**
   * Blink schedule.
   *
   * Derived from the clock rather than Math.random so a re-render of the same
   * script produces the same video — which matters when a reviewer asks for a
   * change and needs to compare two takes.
   */
  private blinkOpenness(seconds: number): number {
    const INTERVAL = 3.4;
    const DURATION = 0.13;
    const cycle = Math.floor(seconds / INTERVAL);
    // Deterministic jitter so blinks are not metronomic.
    const jitter = ((Math.sin(cycle * 12.9898) * 43758.5453) % 1 + 1) % 1;
    const start = cycle * INTERVAL + jitter * (INTERVAL - DURATION);
    const into = seconds - start;

    if (into < 0 || into > DURATION) return 1;
    // Down fast, up slightly slower, as a real lid moves.
    const phase = into / DURATION;
    return phase < 0.4
      ? 1 - phase / 0.4
      : (phase - 0.4) / 0.6;
  }

  private drawNose(ctx: CanvasRenderingContext2D, preset: AvatarPreset): void {
    ctx.strokeStyle = this.shade(preset.skinShadow, -0.08);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-3, -14);
    ctx.quadraticCurveTo(-9, 12, -12, 20);
    ctx.quadraticCurveTo(-2, 26, 9, 20);
    ctx.stroke();

    // Nostrils.
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    [-9, 8].forEach(offsetX => {
      ctx.beginPath();
      ctx.ellipse(offsetX, 22, 3.2, 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
    });

    // Tip highlight.
    ctx.fillStyle = 'rgba(255,255,255,.18)';
    ctx.beginPath();
    ctx.ellipse(-1, 16, 7, 5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawCheeks(ctx: CanvasRenderingContext2D, preset: AvatarPreset, energy: number): void {
    // Kept faint: a visible disc of blush reads as a doll, not a clinician.
    ctx.fillStyle = `rgba(206,120,106,${0.05 + energy * 0.03})`;
    [-1, 1].forEach(side => {
      ctx.beginPath();
      ctx.ellipse(side * 54, 26, 22, 12, 0, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // ---------------------------------------------------------------- mouth ---

  /**
   * Draw the mouth from the current viseme state.
   *
   * Order matters: oral cavity, then tongue, then teeth, then lips on top.
   * Anything else and the teeth float in front of the lips.
   */
  private drawMouth(ctx: CanvasRenderingContext2D, preset: AvatarPreset, mouth: MouthState, jawDrop: number): void {
    const centerY = 44 + jawDrop * 0.82;
    const halfWidth = mouth.width * 42;
    const halfHeight = Math.max(0.6, mouth.height * 30);

    ctx.save();
    ctx.translate(0, centerY);

    // Rounding pulls the corners in and pushes the opening taller.
    const cornerX = halfWidth * (1 - mouth.rounding * 0.42);
    const cornerLift = -mouth.cornerLift * 7;

    // --- oral cavity ---
    ctx.beginPath();
    ctx.moveTo(-cornerX, cornerLift);
    ctx.quadraticCurveTo(0, -halfHeight * 1.05, cornerX, cornerLift);
    ctx.quadraticCurveTo(0, halfHeight * 1.15, -cornerX, cornerLift);
    ctx.closePath();

    const cavity = ctx.createLinearGradient(0, -halfHeight, 0, halfHeight);
    cavity.addColorStop(0, '#3d1418');
    cavity.addColorStop(1, '#63202a');
    ctx.fillStyle = cavity;
    ctx.fill();

    // Everything inside the mouth is clipped to the opening.
    ctx.save();
    ctx.clip();

    if (mouth.tongue > 0.05) {
      ctx.fillStyle = '#c4626e';
      ctx.beginPath();
      ctx.ellipse(0, halfHeight * (1 - mouth.tongue * 0.75), halfWidth * 0.62, halfHeight * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    if (mouth.upperTeeth > 0.05) {
      ctx.fillStyle = '#fdfdfb';
      ctx.beginPath();
      ctx.rect(-cornerX, -halfHeight * 1.05, cornerX * 2, halfHeight * 0.52 * mouth.upperTeeth + 2.5);
      ctx.fill();
      // Gaps between the incisors.
      ctx.strokeStyle = 'rgba(160,160,150,.45)';
      ctx.lineWidth = 0.9;
      for (let offset = -cornerX + 7; offset < cornerX; offset += 9) {
        ctx.beginPath();
        ctx.moveTo(offset, -halfHeight * 1.05);
        ctx.lineTo(offset, -halfHeight * 1.05 + halfHeight * 0.52 * mouth.upperTeeth + 2.5);
        ctx.stroke();
      }
    }

    if (mouth.lowerTeeth > 0.05) {
      ctx.fillStyle = '#f2f2ee';
      ctx.beginPath();
      ctx.rect(-cornerX * 0.9, halfHeight * 1.15 - halfHeight * 0.4 * mouth.lowerTeeth - 2, cornerX * 1.8, halfHeight * 0.4 * mouth.lowerTeeth + 3);
      ctx.fill();
    }

    ctx.restore();

    // --- lips ---
    const lip = ctx.createLinearGradient(0, -halfHeight - 8, 0, halfHeight + 8);
    lip.addColorStop(0, '#b9695f');
    lip.addColorStop(0.5, '#c8776c');
    lip.addColorStop(1, '#a85a53');
    ctx.strokeStyle = lip;
    ctx.lineWidth = 6 + mouth.press * 6;
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(-cornerX, cornerLift);
    ctx.quadraticCurveTo(0, -halfHeight * 1.05, cornerX, cornerLift);
    ctx.quadraticCurveTo(0, halfHeight * 1.15, -cornerX, cornerLift);
    ctx.closePath();
    ctx.stroke();

    // Cupid's bow on the upper lip.
    ctx.strokeStyle = 'rgba(150,80,72,.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-cornerX * 0.8, cornerLift - halfHeight * 0.5 - 4);
    ctx.quadraticCurveTo(-cornerX * 0.3, cornerLift - halfHeight * 0.75 - 7, 0, cornerLift - halfHeight * 0.55 - 5);
    ctx.quadraticCurveTo(cornerX * 0.3, cornerLift - halfHeight * 0.75 - 7, cornerX * 0.8, cornerLift - halfHeight * 0.5 - 4);
    ctx.stroke();

    // For "f" and "v" the lower lip tucks under the upper teeth.
    if (mouth.upperTeeth > 0.6 && mouth.height < 0.2) {
      ctx.fillStyle = '#a85a53';
      ctx.beginPath();
      ctx.ellipse(0, halfHeight * 0.8, cornerX * 0.85, 4.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Shadow under the lower lip, which gives the chin its form.
    ctx.fillStyle = 'rgba(0,0,0,.09)';
    ctx.beginPath();
    ctx.ellipse(0, halfHeight + 13, halfWidth * 0.72, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // ---------------------------------------------------------------- utils ---

  /** Lighten (positive) or darken (negative) a hex colour. */
  private shade(hex: string, amount: number): string {
    const value = parseInt(hex.replace('#', ''), 16);
    const channel = (shift: number) => {
      const base = (value >> shift) & 0xff;
      const next = amount >= 0 ? base + (255 - base) * amount : base * (1 + amount);
      return Math.max(0, Math.min(255, Math.round(next)));
    };
    return `rgb(${channel(16)},${channel(8)},${channel(0)})`;
  }
}
