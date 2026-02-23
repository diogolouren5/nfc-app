
import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { SessionService } from './services/session.service';
import { StartScreenComponent } from './components/start-screen/start-screen.component';
import { EventViewComponent } from './components/event-view/event-view.component';
import { ModeSelectorComponent } from './components/mode-selector/mode-selector.component';
import { EvacuationModeComponent } from './components/evacuation-mode/evacuation-mode.component';

type AppMode = 'mode_selector' | 'nfc' | 'evacuation';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StartScreenComponent, EventViewComponent, ModeSelectorComponent, EvacuationModeComponent]
})
export class AppComponent {
  sessionService = inject(SessionService);
  isSessionActive = this.sessionService.isSessionActive;
  mode = signal<AppMode>('mode_selector');

  openNfcMode(): void {
    this.mode.set('nfc');
  }

  openEvacuationMode(): void {
    this.mode.set('evacuation');
  }

  returnToModeSelector(): void {
    this.mode.set('mode_selector');
  }
}
