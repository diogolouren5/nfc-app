
import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { SessionService } from './services/session.service';
import { StartScreenComponent } from './components/start-screen/start-screen.component';
import { EventViewComponent } from './components/event-view/event-view.component';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StartScreenComponent, EventViewComponent]
})
export class AppComponent {
  sessionService = inject(SessionService);
  isSessionActive = this.sessionService.isSessionActive;
}
