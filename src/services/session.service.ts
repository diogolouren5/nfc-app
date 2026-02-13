
import { Injectable, signal, computed, WritableSignal } from '@angular/core';
import { Record } from '../models/record.model';

@Injectable({
  providedIn: 'root',
})
export class SessionService {
  eventName: WritableSignal<string> = signal('');
  records: WritableSignal<Record[]> = signal([]);
  startTime: WritableSignal<Date | null> = signal(null);

  isSessionActive = computed(() => this.eventName().length > 0);
  totalRecords = computed(() => this.records().length);
  uniqueRecords = computed(() => new Set(this.records().map(r => r.nombre)).size);

  startSession(name: string): void {
    this.eventName.set(name);
    this.startTime.set(new Date());
    this.records.set([]);
  }

  addRecord(record: Omit<Record, 'timestamp'>): void {
    const newRecord: Record = {
        ...record,
        timestamp: new Date(),
    };
    this.records.update(currentRecords => [newRecord, ...currentRecords]);
  }

  endSession(): void {
    // Logic to export data is handled in the component via ExcelExportService
    this.eventName.set('');
    this.records.set([]);
    this.startTime.set(null);
  }
}
