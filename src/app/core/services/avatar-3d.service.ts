import { Injectable } from '@angular/core';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MouthState } from './lip-sync.service';

/** Same placement contract as the 2D presenter, so scenes need not change. */
export interface Avatar3dFrame {
  x: number;
  y: number;
  scale: number;
  mouth: MouthState;
  timeMs: number;
  speaking: boolean;
}

/**
 * How each of our visemes is formed on this face, as [morph, amount] pairs.
 *
 * The model's stock Oculus shapes drop the lower lip and bare the lower teeth
 * and gum, which reads as a grimace. So each sound uses a gentler viseme plus
 * lip corrections that lift the upper lip and roll the lower lip over the
 * lower teeth: in real speech it is mostly the upper teeth that show. A touch
 * of smile on the spread sounds keeps the lift from reading as a sneer.
 */
const MOUTH_RECIPES: Record<string, [string, number][]> = {
  REST: [],
  MBP: [['viseme_PP', 1], ['mouthPressLeft', 0.2], ['mouthPressRight', 0.2]],
  FV: [['viseme_FF', 0.6], ['mouthRollLower', 0.6], ['mouthUpperUpLeft', 0.35], ['mouthUpperUpRight', 0.35]],
  TH: [['viseme_TH', 0.55], ['mouthUpperUpLeft', 0.3], ['mouthUpperUpRight', 0.3]],
  SS: [['viseme_SS', 0.4], ['mouthUpperUpLeft', 0.45], ['mouthUpperUpRight', 0.45], ['mouthRollLower', 0.3],
    ['mouthShrugLower', 0.2], ['mouthSmileLeft', 0.15], ['mouthSmileRight', 0.15]],
  DD: [['viseme_DD', 0.45], ['mouthUpperUpLeft', 0.3], ['mouthUpperUpRight', 0.3], ['mouthRollLower', 0.45],
    ['mouthSmileLeft', 0.1], ['mouthSmileRight', 0.1]],
  KG: [['viseme_kk', 0.5], ['mouthUpperUpLeft', 0.2], ['mouthUpperUpRight', 0.2], ['mouthRollLower', 0.35]],
  RR: [['viseme_RR', 0.55], ['mouthFunnel', 0.2]],
  AA: [['viseme_aa', 0.7]],
  E: [['viseme_E', 0.45], ['mouthUpperUpLeft', 0.45], ['mouthUpperUpRight', 0.45], ['mouthRollLower', 0.6],
    ['mouthSmileLeft', 0.15], ['mouthSmileRight', 0.15]],
  I: [['viseme_I', 0.4], ['mouthUpperUpLeft', 0.45], ['mouthUpperUpRight', 0.45], ['mouthRollLower', 0.55],
    ['mouthSmileLeft', 0.15], ['mouthSmileRight', 0.15]],
  O: [['viseme_O', 0.75], ['mouthFunnel', 0.2], ['mouthRollLower', 0.3], ['mouthUpperUpLeft', 0.2], ['mouthUpperUpRight', 0.2]],
  U: [['viseme_U', 0.8], ['mouthPucker', 0.2]]
};
/** The resting mouth: lips gently closed over the teeth. */
// Only a light lower-lip roll: pressing or closing shapes swallow the upper lip.
const REST_MOUTH: [string, number][] = [['mouthRollLower', 0.15]];
const MOUTH_MORPHS = Array.from(new Set(
  [...Object.values(MOUTH_RECIPES).flat(), ...REST_MOUTH].map(([morph]) => morph)
));

/** Scrub-top colour for the presenter's outfit. */
const SCRUBS = 0x1d5f68;

const GAZE_MORPHS = [
  'eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight',
  'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight'
];

interface Loaded {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  morphs: Map<string, { mesh: THREE.Mesh; index: number }[]>;
  head: THREE.Bone | null;
  neck: THREE.Bone | null;
  headRest: THREE.Quaternion;
  neckRest: THREE.Quaternion;
  /** World-space framing targets. */
  portrait: { target: THREE.Vector3; distance: number };
  face: { target: THREE.Vector3; distance: number };
}

/** Stable pseudo-random 0-1 per integer, so blinks land identically on re-render. */
function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Realistic 3D presenter, rendered with three.js.
 *
 * Every frame is a pure function of the scene time and the lip-sync state,
 * exactly like the 2D presenter: the face is posed, rendered to an offscreen
 * WebGL canvas and copied into the video frame. Nothing runs on its own clock,
 * so the mouth stays locked to the audio and a re-render is reproducible.
 */
@Injectable({ providedIn: 'root' })
export class Avatar3dService {
  private readonly loads = new Map<string, Promise<Loaded | null>>();
  private readonly ready = new Map<string, Loaded>();

  /** Start loading a model; resolves false if WebGL or the model is unavailable. */
  load(url: string): Promise<boolean> {
    let pending = this.loads.get(url);
    if (!pending) {
      pending = this.create(url).catch(error => {
        console.warn('[avatar-3d] falling back to the drawn presenter:', error);
        return null;
      });
      pending.then(loaded => { if (loaded) this.ready.set(url, loaded); });
      this.loads.set(url, pending);
    }
    return pending.then(Boolean);
  }

  isReady(url: string): boolean {
    return this.ready.has(url);
  }

  draw(ctx: CanvasRenderingContext2D, url: string, frame: Avatar3dFrame): void {
    const loaded = this.ready.get(url);
    if (!loaded) return;

    // Badge-sized presenters get a tight face shot; full presenters show
    // head and shoulders. Boxes match the 2D presenter's footprint.
    const closeUp = frame.scale < 0.6;
    const width = closeUp ? 276 * frame.scale : (400 * frame.scale) / 1.02;
    const height = closeUp ? width : (448 * frame.scale) / 1.02;
    const centerY = closeUp ? frame.y - frame.scale * 16.7 : frame.y + (36 * frame.scale) / 1.02;

    // Render at the canvas's real pixel density, not the 1280x720 design units.
    const density = Math.hypot(ctx.getTransform().a, ctx.getTransform().b) || 1;
    const pixelWidth = Math.max(1, Math.round(width * density));
    const pixelHeight = Math.max(1, Math.round(height * density));
    const canvas = loaded.renderer.domElement;
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      loaded.renderer.setSize(pixelWidth, pixelHeight, false);
    }

    this.pose(loaded, frame);
    this.frameCamera(loaded, closeUp ? loaded.face : loaded.portrait, pixelWidth / pixelHeight);
    loaded.renderer.render(loaded.scene, loaded.camera);

    // Copy straight after rendering, while the drawing buffer is still valid.
    ctx.drawImage(canvas, frame.x - width / 2, centerY - height / 2, width, height);
  }

  // ------------------------------------------------------------- posing ---

  private pose(loaded: Loaded, frame: Avatar3dFrame): void {
    const seconds = frame.timeMs / 1000;
    const energy = frame.speaking ? frame.mouth.energy : 0;

    // Mouth: blended visemes from the lip-sync timeline, via the recipes.
    for (const name of MOUTH_MORPHS) this.setMorph(loaded, name, 0);
    for (const [viseme, weight] of Object.entries(frame.mouth.visemes)) {
      for (const [morph, amount] of MOUTH_RECIPES[viseme] || []) {
        this.addMorph(loaded, morph, Math.min(1, weight) * amount);
      }
    }
    // The model's neutral face has parted lips; close them softly at rest
    // (idle, and the brief rests between words), fading out as speech builds.
    const active = Object.entries(frame.mouth.visemes)
      .filter(([viseme]) => viseme !== 'REST')
      .reduce((sum, [, weight]) => sum + weight, 0);
    const resting = Math.max(0, 1 - active / 0.35);
    for (const [morph, amount] of REST_MOUTH) this.addMorph(loaded, morph, amount * resting);
    // A touch of jaw on loud syllables adds weight the visemes alone lack.
    this.setMorph(loaded, 'jawOpen', Math.min(0.25, energy * 0.18));

    // Blinks every ~2.5-5.5 s, 160 ms each, placed by a stable hash.
    const blinkSlot = Math.floor(seconds / 4);
    const blinkAt = blinkSlot * 4 + 0.6 + hash(blinkSlot) * 2.6;
    const blinkPhase = (seconds - blinkAt) / 0.16;
    const blink = blinkPhase > 0 && blinkPhase < 1 ? Math.sin(blinkPhase * Math.PI) : 0;
    this.setMorph(loaded, 'eyeBlinkLeft', blink);
    this.setMorph(loaded, 'eyeBlinkRight', blink);

    // Gaze: mostly at camera, with small saccades every 1.5-3 s.
    const gazeSlot = Math.floor(seconds / 2.2);
    const gazeX = (hash(gazeSlot + 17) - 0.5) * 0.35;
    const gazeY = (hash(gazeSlot + 71) - 0.5) * 0.25;
    for (const name of GAZE_MORPHS) this.setMorph(loaded, name, 0);
    this.setMorph(loaded, gazeY > 0 ? 'eyeLookUpLeft' : 'eyeLookDownLeft', Math.abs(gazeY));
    this.setMorph(loaded, gazeY > 0 ? 'eyeLookUpRight' : 'eyeLookDownRight', Math.abs(gazeY));
    this.setMorph(loaded, gazeX > 0 ? 'eyeLookOutLeft' : 'eyeLookInLeft', Math.abs(gazeX));
    this.setMorph(loaded, gazeX > 0 ? 'eyeLookInRight' : 'eyeLookOutRight', Math.abs(gazeX));

    // Expression: a hint of warmth (more parts the lips), brows lift on emphasis.
    this.addMorph(loaded, 'mouthSmileLeft', 0.04);
    this.addMorph(loaded, 'mouthSmileRight', 0.04);
    this.setMorph(loaded, 'browInnerUp', 0.05 + energy * 0.25);

    // Head: two out-of-phase sways plus a nod on stressed syllables.
    if (loaded.head && loaded.neck) {
      const nod = Math.sin(seconds * 0.9) * 0.018 + energy * 0.045;
      const turn = Math.sin(seconds * 0.45) * 0.05 + Math.sin(seconds * 1.3) * 0.012;
      const tilt = Math.sin(seconds * 0.7) * 0.02;
      const offset = new THREE.Quaternion().setFromEuler(new THREE.Euler(nod, turn, tilt));
      loaded.head.quaternion.copy(loaded.headRest).multiply(offset);
      const neckOffset = new THREE.Quaternion().setFromEuler(new THREE.Euler(nod * 0.4, turn * 0.4, 0));
      loaded.neck.quaternion.copy(loaded.neckRest).multiply(neckOffset);
    }
    loaded.scene.updateMatrixWorld(true);
  }

  private setMorph(loaded: Loaded, name: string, value: number): void {
    for (const { mesh, index } of loaded.morphs.get(name) || []) {
      if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = value;
    }
  }

  private addMorph(loaded: Loaded, name: string, value: number): void {
    for (const { mesh, index } of loaded.morphs.get(name) || []) {
      if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] += value;
    }
  }

  private frameCamera(loaded: Loaded, framing: { target: THREE.Vector3; distance: number }, aspect: number): void {
    const camera = loaded.camera;
    camera.aspect = aspect;
    camera.position.set(framing.target.x, framing.target.y + 0.015, framing.target.z + framing.distance);
    camera.lookAt(framing.target);
    camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------- set-up ---

  private async create(url: string): Promise<Loaded | null> {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    const gltf = await new GLTFLoader().loadAsync(url);
    const model = gltf.scene;

    const scene = new THREE.Scene();
    // Soft studio reflections for skin and fabric.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const key = new THREE.DirectionalLight(0xfff1e0, 1.6);
    key.position.set(-1.2, 2.2, 2.4);
    const fill = new THREE.DirectionalLight(0xdbe8ff, 0.55);
    fill.position.set(1.6, 1.2, 1.8);
    const rim = new THREE.DirectionalLight(0xffffff, 0.9);
    rim.position.set(0.4, 2.4, -2.2);
    scene.add(new THREE.HemisphereLight(0xf2f6ff, 0x3a3026, 0.35), key, fill, rim, model);

    const morphs = new Map<string, { mesh: THREE.Mesh; index: number }[]>();
    const bones = new Map<string, THREE.Bone>();
    model.traverse(object => {
      if ((object as THREE.Bone).isBone) bones.set(object.name, object as THREE.Bone);
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false; // skinned bounds are unreliable once posed
      for (const [name, index] of Object.entries(mesh.morphTargetDictionary || {})) {
        const list = morphs.get(name) || [];
        list.push({ mesh, index });
        morphs.set(name, list);
      }
    });
    if (!morphs.has('viseme_aa')) throw new Error('Model has no viseme morph targets.');
    this.dressForClinic(model);

    this.lowerArms(model, bones);
    model.updateMatrixWorld(true);

    const head = bones.get('Head') || null;
    const neck = bones.get('Neck') || null;
    const headPosition = new THREE.Vector3();
    (head || model).getWorldPosition(headPosition);

    const camera = new THREE.PerspectiveCamera(20, 1, 0.05, 20);
    return {
      scene, camera, renderer, morphs, head, neck,
      headRest: head ? head.quaternion.clone() : new THREE.Quaternion(),
      neckRest: neck ? neck.quaternion.clone() : new THREE.Quaternion(),
      portrait: { target: headPosition.clone().add(new THREE.Vector3(0, -0.04, 0)), distance: 1.85 },
      face: { target: headPosition.clone().add(new THREE.Vector3(0, 0.07, 0)), distance: 0.95 }
    };
  }

  /**
   * Adapt the stock model to a clinical setting: the logo T-shirt becomes a
   * plain scrub top (its normal map keeps the fabric folds), and the source
   * texture's over-saturated red irises become a natural brown, and the teeth
 * and tongue are toned down to sit naturally inside the mouth.
   */
  private dressForClinic(model: THREE.Object3D): void {
    model.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (/casualsuit/i.test(material.name)) {
        material.map = null;
        material.color.set(SCRUBS);
        material.needsUpdate = true;
      } else if (/high-poly/i.test(material.name) && material.map) {
        material.map = this.naturalIris(material.map);
        material.needsUpdate = true;
      } else if (/teeth|tongue/i.test(material.name)) {
        // Inside the mouth there is little light: without this the teeth
        // catch the full studio reflection and glow flat white.
        material.color.setRGB(0.86, 0.82, 0.77);
        material.envMapIntensity = 0.25;
        material.roughness = Math.max(material.roughness, 0.55);
        material.needsUpdate = true;
      }
    });
  }

  private naturalIris(source: THREE.Texture): THREE.Texture {
    const image = source.image as CanvasImageSource & { width: number; height: number };
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return source;
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = pixels.data;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      // Only strongly red, saturated pixels: the iris, not the white sclera.
      if (r - Math.min(g, b) < 45 || r < g * 1.3) continue;
      const light = 0.3 * r + 0.59 * g + 0.11 * b;
      data[i] = Math.min(255, light * 1.25);
      data[i + 1] = Math.min(255, light * 0.92);
      data[i + 2] = Math.min(255, light * 0.62);
    }
    ctx.putImageData(pixels, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY = source.flipY;
    texture.colorSpace = source.colorSpace;
    texture.wrapS = source.wrapS;
    texture.wrapT = source.wrapT;
    return texture;
  }

  /**
   * Bring T/A-posed arms down to the sides. Done in world space, so it does
   * not depend on how the rig's bones are oriented locally.
   */
  private lowerArms(model: THREE.Object3D, bones: Map<string, THREE.Bone>): void {
    for (const side of ['Left', 'Right']) {
      const arm = bones.get(`${side}Arm`);
      const forearm = bones.get(`${side}ForeArm`);
      const hand = bones.get(`${side}Hand`);
      if (!arm || !forearm || !arm.parent) continue;
      const outward = side === 'Left' ? 1 : -1;

      this.aimBone(model, arm, forearm, new THREE.Vector3(0.18 * outward, -1, 0.04));
      if (hand) this.aimBone(model, forearm, hand, new THREE.Vector3(0.1 * outward, -1, 0.22));
    }
  }

  /** Rotate `bone` so that the direction to `child` points along `direction` (world). */
  private aimBone(model: THREE.Object3D, bone: THREE.Bone, child: THREE.Object3D, direction: THREE.Vector3): void {
    model.updateMatrixWorld(true);
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    bone.getWorldPosition(from);
    child.getWorldPosition(to);
    const current = to.sub(from).normalize();
    const turn = new THREE.Quaternion().setFromUnitVectors(current, direction.clone().normalize());

    const boneWorld = new THREE.Quaternion();
    bone.getWorldQuaternion(boneWorld);
    const parentWorld = new THREE.Quaternion();
    (bone.parent as THREE.Object3D).getWorldQuaternion(parentWorld);
    // local = parentWorld^-1 * (turn * boneWorld)
    bone.quaternion.copy(parentWorld.invert().multiply(turn.multiply(boneWorld)));
  }
}
