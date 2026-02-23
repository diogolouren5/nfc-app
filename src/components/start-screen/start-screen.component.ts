
import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { SessionService } from '../../services/session.service';
import { NfcService } from '../../services/nfc.service';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-start-screen',
  templateUrl: './start-screen.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
})
export class StartScreenComponent {
  sessionService = inject(SessionService);
  nfcService = inject(NfcService);
  showBridgeInstallModal = signal(false);
  readonly defaultEventName = 'Formación 1';

  async startEvent(eventNameInput: HTMLInputElement): Promise<void> {
    const eventName = eventNameInput.value.trim();

    if (!eventName) {
      alert('Por favor, ingrese un nombre para el evento.');
      return;
    }

    const isReady = await this.nfcService.ensureReadyForSessionStart();
    if (isReady) {
      this.sessionService.startSession(eventName);
    } else {
      await this.nfcService.refreshAgentDownloadInfo();
      this.showBridgeInstallModal.set(true);
    }
  }

  async retryBridgeConnection(): Promise<void> {
    const isReady = await this.nfcService.ensureReadyForSessionStart();
    if (isReady) {
      this.showBridgeInstallModal.set(false);
    }
  }

  closeBridgeInstallModal(): void {
    this.showBridgeInstallModal.set(false);
  }
}
