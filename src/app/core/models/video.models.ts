/** Shared types for the studio, the renderer and the review workflow. */

export type VisualType =
  | 'avatar'
  | 'whiteboard'
  | 'diagram'
  | 'comparison'
  | 'medical-animation'
  | 'anatomy'
  | 'image';

export type OrganKind = 'cell' | 'lungs' | 'heart' | 'brain' | 'kidney' | 'liver' | 'stomach' | 'bloodvessel';

export interface VisualData {
  heading?: string;
  points?: string[];
  steps?: string[];
  labels?: string[];
  leftTitle?: string;
  leftItems?: string[];
  rightTitle?: string;
  rightItems?: string[];
  organ?: OrganKind;
  /** Image scenes: the original URL of a figure from the source content. */
  imageUrl?: string;
  caption?: string;
}

export interface Scene {
  title: string;
  narration: string;
  visualType: VisualType;
  seconds: number;
  highlight?: string;
  visualData: VisualData;
  editedByReviewer?: boolean;
}

export interface Storyboard {
  title: string;
  summary: string;
  reviewNotes: string[];
  scenes: Scene[];
  source?: 'claude' | 'local-planner';
  model?: string;
  warning?: string;
}

/** One frame of the lip-sync timeline: a mouth shape with a start and length. */
export interface VisemeFrame {
  /** Start time within the scene's audio, in milliseconds. */
  t: number;
  /** Duration in milliseconds. */
  d: number;
  viseme: string;
}

export interface WordFrame {
  text: string;
  t: number;
  d: number;
}

/** A rendered narration track plus everything needed to animate against it. */
export interface VoiceTrack {
  engine: string;
  engineLabel: string;
  voice: string;
  mimeType: string;
  durationMs: number;
  audioBase64: string;
  visemes: VisemeFrame[];
  words: WordFrame[];
  script: string;
}

export interface Capabilities {
  aiScriptWriter: boolean;
  scriptWriterModel: string | null;
  voiceEngines: { id: string; label: string; available: boolean }[];
  systemVoices: { name: string; locale: string }[];
}

export interface GenerationSettings {
  category: string;
  topic: string;
  duration: number;
  sourceContent: string;
  visualStyle: string;
  voice: string;
  avatar: string;
  lipSync: boolean;
  subtitles: boolean;
  medicalAnimations: boolean;
  resolution: '720p' | '1080p';
}

export type ReviewStatus = 'draft' | 'in_review' | 'approved' | 'changes_requested' | 'rejected';

export interface ReviewRecord {
  id: string;
  decision: 'approve' | 'request_changes' | 'reject';
  status: ReviewStatus;
  reviewer: string;
  notes: string;
  at: string;
}

export interface LibraryVideo {
  id: string;
  title: string;
  topic: string;
  category: string;
  summary: string;
  status: ReviewStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvedBy?: string;
  needsRerender?: boolean;
  storyboard: Scene[];
  settings: Partial<GenerationSettings>;
  aiReviewNotes: string[];
  reviews: ReviewRecord[];
  media: { filename: string; mimeType: string; bytes: number; durationMs: number; uploadedAt: string } | null;
  history: { at: string; action: string; by?: string; notes?: string }[];
}

export interface PublishedVideo {
  id: string;
  title: string;
  topic: string;
  category: string;
  summary: string;
  approvedAt: string;
  approvedBy: string;
  durationMs: number;
  hasMedia: boolean;
  sceneCount: number;
}
