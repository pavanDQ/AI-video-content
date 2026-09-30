import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HttpClientModule } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { AppComponent } from './app.component';
import { LibraryComponent } from './features/library/library.component';
import { ReviewComponent } from './features/review/review.component';
import { StudioComponent } from './features/studio/studio.component';

@NgModule({
  declarations: [AppComponent, StudioComponent, ReviewComponent, LibraryComponent],
  imports: [BrowserModule, FormsModule, HttpClientModule],
  bootstrap: [AppComponent]
})
export class AppModule {}
