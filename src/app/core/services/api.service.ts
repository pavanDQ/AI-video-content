import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import {
  Capabilities, GenerationSettings, LibraryVideo, PublishedVideo, Scene, Storyboard, VoiceTrack
} from '../models/video.models';

/** Thin client over the Node API. */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly base = '/api';

  constructor(private readonly http: HttpClient) {}

  capabilities(): Observable<Capabilities> {
    return this.http.get<Capabilities>(`${this.base}/studio/capabilities`);
  }

  /** Ask the AI script writer (or the offline planner) for a storyboard. */
  writeScript(request: {
    category: string; topic: string; duration: number; sourceContent: string; visualStyle: string;
  }): Observable<Storyboard> {
    return this.http.post<Storyboard>(`${this.base}/studio/script`, request);
  }

  /** Render one scene's narration to audio plus lip-sync timelines. */
  synthesizeVoice(text: string, voice: string): Observable<VoiceTrack> {
    return this.http.post<VoiceTrack>(`${this.base}/studio/voice`, { text, voice });
  }

  submitForReview(payload: {
    title: string; topic: string; category: string; summary: string;
    storyboard: Scene[]; settings: Partial<GenerationSettings>;
    reviewNotes: string[]; createdBy: string;
  }): Observable<LibraryVideo> {
    return this.http.post<LibraryVideo>(`${this.base}/library`, payload);
  }

  /** Upload the recording as a raw body — it is already a single Blob. */
  uploadMedia(id: string, blob: Blob, durationMs: number): Observable<LibraryVideo> {
    return this.http.put<LibraryVideo>(`${this.base}/library/${id}/media`, blob, {
      headers: { 'content-type': blob.type || 'video/webm', 'x-duration-ms': String(Math.round(durationMs)) }
    });
  }

  reviewQueue(status?: string): Observable<{ videos: LibraryVideo[] }> {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.http.get<{ videos: LibraryVideo[] }>(`${this.base}/library${query}`);
  }

  doctorLibrary(): Observable<{ videos: PublishedVideo[] }> {
    return this.http.get<{ videos: PublishedVideo[] }>(`${this.base}/library?audience=doctor`);
  }

  submitReview(id: string, payload: {
    decision: 'approve' | 'request_changes' | 'reject';
    reviewer: string;
    notes: string;
    sceneEdits: { index: number; narration: string }[];
  }): Observable<LibraryVideo> {
    return this.http.post<LibraryVideo>(`${this.base}/library/${id}/review`, payload);
  }

  deleteVideo(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/library/${id}`);
  }

  /** Streaming URL for an approved video. */
  mediaUrl(id: string, options: { download?: boolean; preview?: boolean } = {}): string {
    const params = new URLSearchParams();
    if (options.download) params.set('download', '1');
    if (options.preview) params.set('preview', '1');
    const query = params.toString();
    return `${this.base}/library/${id}/media${query ? `?${query}` : ''}`;
  }
}
