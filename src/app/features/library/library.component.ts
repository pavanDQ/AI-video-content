import { Component, OnInit } from '@angular/core';
import { PublishedVideo } from '../../core/models/video.models';
import { ApiService } from '../../core/services/api.service';

/**
 * The doctor-facing view. It reads the audience-filtered endpoint, so only
 * approved videos with an attached file can ever appear here.
 */
@Component({
  selector: 'app-library',
  templateUrl: './library.component.html',
  styleUrls: ['./library.component.css']
})
export class LibraryComponent implements OnInit {
  videos: PublishedVideo[] = [];
  playing?: PublishedVideo;
  loading = false;
  error = '';
  search = '';

  constructor(private readonly api: ApiService) {}

  ngOnInit(): void {
    this.reload();
  }

  reload(): void {
    this.loading = true;
    this.error = '';
    this.api.doctorLibrary().subscribe({
      next: response => {
        this.videos = response.videos;
        this.loading = false;
      },
      error: () => {
        this.error = 'Could not load the library.';
        this.loading = false;
      }
    });
  }

  get filtered(): PublishedVideo[] {
    const term = this.search.trim().toLowerCase();
    if (!term) return this.videos;
    return this.videos.filter(video =>
      `${video.title} ${video.topic} ${video.category} ${video.summary}`.toLowerCase().includes(term)
    );
  }

  play(video: PublishedVideo): void {
    this.playing = video;
  }

  streamUrl(video: PublishedVideo): string {
    return this.api.mediaUrl(video.id);
  }

  downloadUrl(video: PublishedVideo): string {
    return this.api.mediaUrl(video.id, { download: true });
  }

  formatDuration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  formatDate(value: string): string {
    return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
}
