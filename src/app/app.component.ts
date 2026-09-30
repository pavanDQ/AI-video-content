import { Component } from '@angular/core';

type Tab = 'studio' | 'review' | 'library';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent {
  tab: Tab = 'studio';

  readonly tabs: { id: Tab; label: string; hint: string }[] = [
    { id: 'studio', label: 'Studio', hint: 'Generate an AI video' },
    { id: 'review', label: 'Review queue', hint: 'Clinical sign-off' },
    { id: 'library', label: 'Doctor library', hint: 'Approved videos' }
  ];

  select(tab: Tab): void {
    this.tab = tab;
  }
}
