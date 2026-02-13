import { Component, ChangeDetectionStrategy, input } from '@angular/core';
import { Record } from '../../models/record.model';
import { DatePipe } from '@angular/common';

@Component({
  selector: 'app-record-card',
  templateUrl: './record-card.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe]
})
export class RecordCardComponent {
  record = input.required<Record>();

  get cardClasses(): string {
    const base = 'p-4 bg-card_bg rounded-lg shadow-md border-l-4 flex justify-between items-center transition-transform duration-300 hover:scale-[1.02]';
    switch (this.record().status) {
      case 'ok':
        return `${base} border-success`;
      case 'manual':
        return `${base} border-accent`;
      case 'error':
        return `${base} border-error`;
      default:
        return base;
    }
  }

  get badgeClasses(): string {
    const base = 'mt-1 inline-block px-2 py-0.5 text-xs font-semibold rounded-full text-white';
    switch (this.record().status) {
        case 'ok':
            return `${base} bg-success`;
        case 'manual':
            return `${base} bg-accent`;
        case 'error':
            return `${base} bg-error`;
        default:
            return `${base} bg-gray-400`;
    }
  }
}
