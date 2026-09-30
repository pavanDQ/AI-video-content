import { Injectable } from '@angular/core';
import { VisemeFrame } from '../models/video.models';

/** Geometry of one mouth shape, in normalised units the avatar scales up. */
export interface MouthShape {
  /** Corner-to-corner width. */
  width: number;
  /** Vertical opening between the lips. */
  height: number;
  /** 0 = spread wide, 1 = pursed into a circle. */
  rounding: number;
  /** How much of the upper tooth row shows. */
  upperTeeth: number;
  /** How much of the lower tooth row shows. */
  lowerTeeth: number;
  /** Tongue visibility, for "th" and "l". */
  tongue: number;
  /** Lips pressed flat together, for "m", "b", "p". */
  press: number;
  /** Corner lift; negative pulls the corners down. */
  cornerLift: number;
}

/**
 * The canonical shapes. These are the distinct positions a mouth actually
 * takes; everything else is interpolation between them.
 */
const SHAPES: Record<string, MouthShape> = {
  REST: { width: 0.54, height: 0.05, rounding: 0.15, upperTeeth: 0, lowerTeeth: 0, tongue: 0, press: 0.15, cornerLift: 0.05 },
  MBP:  { width: 0.56, height: 0.02, rounding: 0.10, upperTeeth: 0, lowerTeeth: 0, tongue: 0, press: 1.00, cornerLift: 0 },
  FV:   { width: 0.60, height: 0.14, rounding: 0.10, upperTeeth: 0.9, lowerTeeth: 0, tongue: 0, press: 0.45, cornerLift: 0 },
  TH:   { width: 0.62, height: 0.24, rounding: 0.05, upperTeeth: 0.5, lowerTeeth: 0.2, tongue: 0.85, press: 0, cornerLift: 0 },
  SS:   { width: 0.68, height: 0.15, rounding: 0.05, upperTeeth: 0.8, lowerTeeth: 0.6, tongue: 0, press: 0, cornerLift: 0.1 },
  DD:   { width: 0.60, height: 0.30, rounding: 0.10, upperTeeth: 0.45, lowerTeeth: 0.1, tongue: 0.55, press: 0, cornerLift: 0 },
  KG:   { width: 0.62, height: 0.36, rounding: 0.15, upperTeeth: 0.3, lowerTeeth: 0.15, tongue: 0.2, press: 0, cornerLift: 0 },
  RR:   { width: 0.48, height: 0.30, rounding: 0.60, upperTeeth: 0.1, lowerTeeth: 0, tongue: 0.3, press: 0, cornerLift: -0.05 },
  AA:   { width: 0.84, height: 0.82, rounding: 0.05, upperTeeth: 0.35, lowerTeeth: 0.25, tongue: 0.25, press: 0, cornerLift: 0 },
  E:    { width: 0.90, height: 0.44, rounding: 0.00, upperTeeth: 0.55, lowerTeeth: 0.35, tongue: 0.1, press: 0, cornerLift: 0.18 },
  I:    { width: 0.82, height: 0.24, rounding: 0.00, upperTeeth: 0.6, lowerTeeth: 0.4, tongue: 0, press: 0, cornerLift: 0.22 },
  O:    { width: 0.50, height: 0.62, rounding: 0.88, upperTeeth: 0.05, lowerTeeth: 0, tongue: 0, press: 0, cornerLift: -0.08 },
  U:    { width: 0.38, height: 0.40, rounding: 1.00, upperTeeth: 0, lowerTeeth: 0, tongue: 0, press: 0, cornerLift: -0.12 }
};

/**
 * How long the mouth takes to travel between two shapes. Real speech
 * co-articulates — the mouth is already moving toward the next sound before
 * the current one finishes — and this blend is what removes the puppet-like
 * snapping that a hard cut between shapes produces.
 */
const BLEND_MS = 55;

/** Lip closures must fully form even on quiet syllables, or "b" reads as "a". */
const CLOSURES = new Set(['MBP', 'FV']);

/** The mouth state at one instant, ready to draw. */
export interface MouthState extends MouthShape {
  /** Jaw rotation in radians, driven by how open the mouth is. */
  jaw: number;
  /** 0-1 loudness at this instant, used for head motion and eyebrows. */
  energy: number;
  viseme: string;
  /**
   * How strongly each viseme is formed right now, 0-1. A 3D face blends these
   * directly; the 2D mouth uses the pre-mixed geometry above instead.
   */
  visemes: Record<string, number>;
}

@Injectable({ providedIn: 'root' })
export class LipSyncService {
  /**
   * Measure the loudness envelope of a decoded narration track.
   *
   * The viseme timeline says which shape; the envelope says how much. Without
   * it the mouth keeps moving through pauses, which is the single most obvious
   * tell of fake lip sync. Sampling at 120 Hz is well above the ~10 Hz at
   * which syllables arrive, so nothing audible is missed.
   */
  buildEnvelope(buffer: AudioBuffer, sampleRateHz = 120): Float32Array {
    const samples = buffer.getChannelData(0);
    const windowSize = Math.max(1, Math.floor(buffer.sampleRate / sampleRateHz));
    const frameCount = Math.ceil(samples.length / windowSize);
    const envelope = new Float32Array(frameCount);

    for (let frame = 0; frame < frameCount; frame++) {
      const start = frame * windowSize;
      const end = Math.min(samples.length, start + windowSize);
      let sumOfSquares = 0;
      for (let i = start; i < end; i++) sumOfSquares += samples[i] * samples[i];
      envelope[frame] = Math.sqrt(sumOfSquares / Math.max(1, end - start));
    }

    // Normalise against a high percentile rather than the absolute peak, so a
    // single plosive spike does not flatten the rest of the track.
    const sorted = Float32Array.from(envelope).sort();
    const reference = sorted[Math.floor(sorted.length * 0.95)] || 1;

    for (let i = 0; i < envelope.length; i++) {
      // A gentle curve keeps quiet consonants visible without making the mouth
      // gape on every vowel.
      envelope[i] = Math.min(1, Math.pow(envelope[i] / reference, 0.7));
    }
    return envelope;
  }

  /** Read the envelope at a point in time, interpolating between samples. */
  sampleEnvelope(envelope: Float32Array, timeMs: number, sampleRateHz = 120): number {
    if (!envelope.length) return 0;
    const position = (timeMs / 1000) * sampleRateHz;
    const index = Math.floor(position);
    if (index < 0) return envelope[0];
    if (index >= envelope.length - 1) return envelope[envelope.length - 1];
    const fraction = position - index;
    return envelope[index] * (1 - fraction) + envelope[index + 1] * fraction;
  }

  /**
   * Resolve the mouth state for a moment in a scene.
   *
   * @param timeline  viseme frames from the voice engine
   * @param envelope  loudness envelope of the same audio
   * @param timeMs    playback position within the scene
   * @param enabled   when lip sync is switched off the mouth idles gently
   */
  mouthAt(timeline: VisemeFrame[], envelope: Float32Array, timeMs: number, enabled = true): MouthState {
    const energy = this.sampleEnvelope(envelope, timeMs);

    if (!enabled || !timeline.length) {
      // Not a fake talking mouth: a closed, faintly breathing one. Claiming
      // sync we are not doing would be worse than visibly not doing it.
      const idle = { ...SHAPES['REST'] };
      idle.height += Math.sin(timeMs / 900) * 0.01;
      return { ...idle, jaw: 0, energy, viseme: 'REST', visemes: {} };
    }

    const index = this.frameIndexAt(timeline, timeMs);
    const current = timeline[index];
    const next = timeline[index + 1];

    let shape = SHAPES[current.viseme] || SHAPES['REST'];

    // Blend into the next shape over the last BLEND_MS of this frame.
    let progress = 0;
    if (next) {
      const remaining = current.t + current.d - timeMs;
      if (remaining < BLEND_MS) {
        progress = this.easeInOut(1 - Math.max(0, remaining) / BLEND_MS);
        shape = this.mix(shape, SHAPES[next.viseme] || SHAPES['REST'], progress);
      }
    }

    // Scale the opening by actual loudness. Consonants keep a floor so the
    // mouth still articulates them; the rest follows the voice.
    const isConsonant = ['MBP', 'FV', 'TH', 'SS', 'DD', 'KG'].includes(current.viseme);
    const gain = isConsonant ? 0.55 + energy * 0.45 : 0.25 + energy * 0.75;

    const visemes: Record<string, number> = {};
    const strength = (viseme: string) => (CLOSURES.has(viseme) ? 0.9 + energy * 0.1 : gain);
    visemes[current.viseme] = (1 - progress) * strength(current.viseme);
    if (next && progress > 0) {
      visemes[next.viseme] = (visemes[next.viseme] || 0) + progress * strength(next.viseme);
    }

    const height = shape.height * gain;
    return {
      ...shape,
      height,
      width: shape.width * (0.9 + 0.1 * gain),
      jaw: height * 0.09,
      energy,
      viseme: current.viseme,
      visemes
    };
  }

  /** Binary search: timelines run to hundreds of frames per scene. */
  private frameIndexAt(timeline: VisemeFrame[], timeMs: number): number {
    let low = 0;
    let high = timeline.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (timeline[middle].t <= timeMs) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  private mix(from: MouthShape, to: MouthShape, amount: number): MouthShape {
    const lerp = (a: number, b: number) => a + (b - a) * amount;
    return {
      width: lerp(from.width, to.width),
      height: lerp(from.height, to.height),
      rounding: lerp(from.rounding, to.rounding),
      upperTeeth: lerp(from.upperTeeth, to.upperTeeth),
      lowerTeeth: lerp(from.lowerTeeth, to.lowerTeeth),
      tongue: lerp(from.tongue, to.tongue),
      press: lerp(from.press, to.press),
      cornerLift: lerp(from.cornerLift, to.cornerLift)
    };
  }

  private easeInOut(t: number): number {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }
}
