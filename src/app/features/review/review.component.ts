import { Component, OnInit } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { LibraryVideo, ReviewStatus } from '../../core/models/video.models';
import { ApiService } from '../../core/services/api.service';

/** Narration corrections a reviewer has made, keyed by scene index. */
type SceneEdits = Record<number, string>;

@Component({
  selector: 'app-review',
  templateUrl: './review.component.html',
  styleUrls: ['./review.component.css']
})
export class ReviewComponent implements OnInit {
  readonly statusLabels: Record<ReviewStatus, string> = {
    draft: 'Draft',
    in_review: 'Awaiting review',
    approved: 'Approved',
    changes_requested: 'Changes requested',
    rejected: 'Rejected'
  };

  videos: LibraryVideo[] = [];
  selected?: LibraryVideo;
  filter: '' | ReviewStatus = 'in_review';

  reviewerName = '';
  reviewNotes = '';
  sceneEdits: SceneEdits = {};

  loading = false;
  saving = false;
  error = '';
  message = '';

  constructor(private readonly api: ApiService) {}

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading = true;
    this.error = '';
    this.api.reviewQueue(this.filter || undefined).subscribe({
      next: response => {
        this.videos = response.videos;
        this.loading = false;
        // Keep the open video selected across a refresh where possible.
        if (this.selected) {
          this.selected = this.videos.find(video => video.id === this.selected?.id) || undefined;
        }
      },
      error: error => {
        this.error = error?.error?.error || 'Could not load the review queue.';
        this.loading = false;
      }
    });
  }

  select(video: LibraryVideo): void {
    this.selected = video;
    this.sceneEdits = {};
    this.reviewNotes = '';
    this.message = '';
    this.error = '';
  }

  /** Reviewers preview unapproved media, which the API allows explicitly. */
  previewUrl(video: LibraryVideo): string {
    return this.api.mediaUrl(video.id, { preview: true });
  }

  narrationFor(index: number, fallback: string): string {
    return this.sceneEdits[index] ?? fallback;
  }

  editNarration(index: number, value: string): void {
    this.sceneEdits[index] = value;
  }

  get hasEdits(): boolean {
    return Object.keys(this.sceneEdits).length > 0;
  }

  get editedCount(): number {
    if (!this.selected) return 0;
    return Object.entries(this.sceneEdits)
      .filter(([index, text]) => text !== this.selected?.storyboard[Number(index)]?.narration)
      .length;
  }

  async decide(decision: 'approve' | 'request_changes' | 'reject'): Promise<void> {
    if (!this.selected || this.saving) return;
    if (!this.reviewerName.trim()) {
      this.error = 'Enter your name — an approval has to be attributable.';
      return;
    }
    if (decision !== 'approve' && !this.reviewNotes.trim()) {
      this.error = 'Explain what needs to change, so the author knows what to fix.';
      return;
    }

    this.saving = true;
    this.error = '';

    // Only send narration that actually differs from what was submitted.
    const edits = Object.entries(this.sceneEdits)
      .map(([index, narration]) => ({ index: Number(index), narration }))
      .filter(edit => edit.narration !== this.selected?.storyboard[edit.index]?.narration);

    try {
      const updated = await firstValueFrom(this.api.submitReview(this.selected.id, {
        decision,
        reviewer: this.reviewerName.trim(),
        notes: this.reviewNotes.trim(),
        sceneEdits: edits
      }));

      this.message = decision === 'approve'
        ? 'Approved. It is now available in the doctor library.'
        : decision === 'reject'
          ? 'Rejected. It will not be served to doctors.'
          : `Changes requested${edits.length ? ` with ${edits.length} narration edit(s)` : ''}.`;

      this.selected = updated;
      this.sceneEdits = {};
      this.reviewNotes = '';
      this.reload();
    } catch (error) {
      this.error = (error as { error?: { error?: string } })?.error?.error || 'Could not save the review.';
    } finally {
      this.saving = false;
    }
  }

  async remove(video: LibraryVideo): Promise<void> {
    if (!confirm(`Permanently delete “${video.title}” and its video file?`)) return;
    try {
      await firstValueFrom(this.api.deleteVideo(video.id));
      if (this.selected?.id === video.id) this.selected = undefined;
      this.reload();
    } catch {
      this.error = 'Could not delete that video.';
    }
  }

  formatDate(value?: string): string {
    return value ? new Date(value).toLocaleString() : '—';
  }

  formatDuration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
}
