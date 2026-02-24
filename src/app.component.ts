
import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { SessionService } from './services/session.service';
import { StartScreenComponent } from './components/start-screen/start-screen.component';
import { EventViewComponent } from './components/event-view/event-view.component';
import { ModeSelectorComponent } from './components/mode-selector/mode-selector.component';
import { EvacuationModeComponent } from './components/evacuation-mode/evacuation-mode.component';
import { EvacuationConfirmComponent } from './components/evacuation-confirm/evacuation-confirm.component';

type AppMode = 'mode_selector' | 'nfc' | 'evacuation' | 'evacuation_confirm';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StartScreenComponent, EventViewComponent, ModeSelectorComponent, EvacuationModeComponent, EvacuationConfirmComponent]
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

  openEvacuationConfirmMode(): void {
    this.mode.set('evacuation_confirm');
  }

  returnToModeSelector(): void {
    this.mode.set('mode_selector');
  }
}
