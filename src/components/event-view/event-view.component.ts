import { Component, ChangeDetectionStrategy, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { SessionService } from '../../services/session.service';
import { NfcService } from '../../services/nfc.service';
import { DataService } from '../../services/data.service';
import { ExcelExportService } from '../../services/excel-export.service';
import { RecordCardComponent } from '../record-card/record-card.component';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-event-view',
  templateUrl: './event-view.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RecordCardComponent, CommonModule],
})
export class EventViewComponent implements OnInit, OnDestroy {
  sessionService = inject(SessionService);
  nfcService = inject(NfcService);
  dataService = inject(DataService);
  excelService = inject(ExcelExportService);

  isManualEntryModalVisible = signal(false);
  isFinishModalVisible = signal(false);
  isCancelModalVisible = signal(false);
  isEditNameModalVisible = signal(false);
  private readSubscription: Subscription | undefined;

  get eventName() { return this.sessionService.eventName; }
  get records() { return this.sessionService.records; }
  get totalRecords() { return this.sessionService.totalRecords; }
  get uniqueRecords() { return this.sessionService.uniqueRecords; }
  get nfcStatus() { return this.nfcService.status; }
  get isSimulationMode() { return this.nfcService.isSimulationMode; }

  ngOnInit(): void {
    // Start checking for the local NFC connector
    this.nfcService.checkConnectorStatus();

    // Subscribe to UIDs read by the service's polling mechanism
    this.readSubscription = this.nfcService.uidRead$.subscribe(uid => {
      this.processUid(uid);
    });
  }

  ngOnDestroy(): void {
    this.nfcService.cleanup();
    this.readSubscription?.unsubscribe();
  }

  private processUid(uid: string): void {
    const nombre = this.dataService.getEmployeeNameByUid(uid);
    if (nombre) {
      this.sessionService.addRecord({
        nombre,
        uid,
        tipo: 'Tarjeta leída',
        status: 'ok',
      });
    } else {
      this.sessionService.addRecord({
        nombre: 'No identificado',
        uid,
        tipo: 'No identificado',
        status: 'error',
      });
    }
  }

  // --- Modal Control Methods ---

  // Edit Name Modal
  openEditNameModal(): void {
    this.isEditNameModalVisible.set(true);
  }

  closeEditNameModal(): void {
    this.isEditNameModalVisible.set(false);
  }

  submitEditName(newName: string): void {
    const trimmedName = newName.trim();
    if (trimmedName && trimmedName !== this.eventName()) {
      this.sessionService.eventName.set(trimmedName);
    }
    this.closeEditNameModal();
  }

  // Cancel/Return to Menu Modal
  openCancelModal(): void {
    this.isCancelModalVisible.set(true);
  }

  closeCancelModal(): void {
    this.isCancelModalVisible.set(false);
  }

  confirmCancel(): void {
    this.sessionService.endSession();
  }

  // Manual Entry Modal
  openManualEntryModal(): void {
    this.isManualEntryModalVisible.set(true);
  }

  closeManualEntryModal(): void {
    this.isManualEntryModalVisible.set(false);
  }

  submitManualEntry(name: string | null): void {
    if (name && name.trim()) {
      this.sessionService.addRecord({
        nombre: name.trim(),
        uid: null,
        tipo: 'Usuario sin tarjeta',
        status: 'manual',
      });
    }
    this.closeManualEntryModal();
  }
  
  // Finish Session Modal
  openFinishModal(): void {
    this.isFinishModalVisible.set(true);
  }

  closeFinishModal(): void {
    this.isFinishModalVisible.set(false);
  }

  confirmFinishSession(): void {
    this.excelService.exportToExcel(
      this.records(),
      this.eventName(),
      this.sessionService.startTime()
    );
    this.sessionService.endSession();
  }

  // --- Other Actions ---

  toggleSimulation(): void {
    this.nfcService.toggleSimulationMode();
  }
}
