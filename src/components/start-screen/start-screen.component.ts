
import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { SessionService } from '../../services/session.service';

@Component({
  selector: 'app-start-screen',
  templateUrl: './start-screen.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StartScreenComponent {
  sessionService = inject(SessionService);

  startEvent(eventNameInput: HTMLInputElement): void {
    const eventName = eventNameInput.value.trim();
    if (eventName) {
      this.sessionService.startSession(eventName);
    } else {
      alert('Por favor, ingrese un nombre para el evento.');
    }
  }
}
