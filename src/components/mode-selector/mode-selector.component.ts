import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, output } from '@angular/core';

@Component({
  selector: 'app-mode-selector',
  templateUrl: './mode-selector.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
})
export class ModeSelectorComponent {
  nfcSelected = output<void>();
  evacuationSelected = output<void>();

  selectNfcMode(): void {
    this.nfcSelected.emit();
  }

  selectEvacuationMode(): void {
    this.evacuationSelected.emit();
  }
}
