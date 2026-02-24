import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, computed, output, signal } from '@angular/core';

interface ConfirmSessionMember {
  employee_number: string;
  full_name: string;
  emergency_role: string;
  area: string;
  sub_area: string;
  department: string;
  ack_status: 'pending' | 'acknowledged';
  ack_at: string | null;
  ack_source: string | null;
}

interface ConfirmSessionApi {
  session_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  summary: {
    total: number;
    acknowledged: number;
    pending: number;
    ack_percent: number;
  };
  metadata?: Record<string, unknown>;
  members: ConfirmSessionMember[];
}

@Component({
  selector: 'app-evacuation-confirm',
  templateUrl: './evacuation-confirm.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
})
export class EvacuationConfirmComponent implements OnDestroy {
  backRequested = output<void>();

  sessionIdInput = signal('');
  employeeNumberInput = signal('');
  sessionData = signal<ConfirmSessionApi | null>(null);
  isLoadingActive = signal(false);
  isLoadingSession = signal(false);
  isConfirming = signal(false);
  errorMessage = signal('');
  infoMessage = signal('');
  lastRefreshAt = signal('');

  private pollTimer: number | null = null;

  memberRow = computed(() => {
    const session = this.sessionData();
    const employee = this.employeeNumberInput().trim();
    if (!session || !employee) return null;
    return session.members.find((m) => m.employee_number === employee) ?? null;
  });

  canConfirm = computed(() => {
    const member = this.memberRow();
    return !!this.sessionData() && !!member && member.ack_status !== 'acknowledged' && !this.isConfirming();
  });

  ngOnDestroy(): void {
    this.stopPolling();
  }

  goBack(): void {
    this.backRequested.emit();
  }

  onSessionIdInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value ?? '';
    this.sessionIdInput.set(value.trim());
    this.errorMessage.set('');
    this.infoMessage.set('');
  }

  onEmployeeNumberInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value ?? '';
    this.employeeNumberInput.set(value.trim());
    this.errorMessage.set('');
    this.infoMessage.set('');
  }

  async loadActiveSession(): Promise<void> {
    this.isLoadingActive.set(true);
    this.errorMessage.set('');
    this.infoMessage.set('');
    try {
      const session = await this.apiGet<ConfirmSessionApi>('/api/evacuation-sessions/active');
      this.sessionIdInput.set(session.session_id);
      this.applySession(session);
      this.infoMessage.set('Sesión activa cargada.');
      this.startPolling();
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'No se pudo cargar la sesión activa.');
      this.sessionData.set(null);
      this.stopPolling();
    } finally {
      this.isLoadingActive.set(false);
    }
  }

  async loadSessionById(): Promise<void> {
    const sessionId = this.sessionIdInput().trim();
    if (!sessionId) {
      this.errorMessage.set('Introduzca un ID de sesión.');
      return;
    }

    this.isLoadingSession.set(true);
    this.errorMessage.set('');
    this.infoMessage.set('');
    try {
      const session = await this.apiGet<ConfirmSessionApi>(`/api/evacuation-sessions/${encodeURIComponent(sessionId)}`);
      this.applySession(session);
      this.infoMessage.set('Sesión cargada correctamente.');
      this.startPolling();
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'No se pudo cargar la sesión.');
      this.sessionData.set(null);
      this.stopPolling();
    } finally {
      this.isLoadingSession.set(false);
    }
  }

  async confirmMember(): Promise<void> {
    const session = this.sessionData();
    const employee = this.employeeNumberInput().trim();
    if (!session) {
      this.errorMessage.set('Primero cargue una sesión de evacuación.');
      return;
    }
    if (!employee) {
      this.errorMessage.set('Introduzca su Nº de empleado.');
      return;
    }
    if (!this.memberRow()) {
      this.errorMessage.set('Su Nº de empleado no aparece en la sesión activa.');
      return;
    }

    this.isConfirming.set(true);
    this.errorMessage.set('');
    this.infoMessage.set('');
    try {
      const updated = await this.apiPost<ConfirmSessionApi>(
        `/api/evacuation-sessions/${encodeURIComponent(session.session_id)}/member-confirm`,
        { employee_number: employee }
      );
      this.applySession(updated);
      this.infoMessage.set('Confirmación registrada correctamente.');
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'No se pudo registrar la confirmación.');
    } finally {
      this.isConfirming.set(false);
    }
  }

  refreshMemberSession(): void {
    if (!this.sessionData()) return;
    this.loadSessionById().catch(() => undefined);
  }

  private applySession(session: ConfirmSessionApi): void {
    this.sessionData.set(session);
    this.lastRefreshAt.set(new Date().toLocaleTimeString());
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = window.setInterval(() => {
      if (this.sessionData()) {
        this.loadSessionById().catch(() => undefined);
      }
    }, 5000);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async apiGet<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(await this.readError(response));
    }
    return (await response.json()) as T;
  }

  private async apiPost<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(await this.readError(response));
    }
    return (await response.json()) as T;
  }

  private async readError(response: Response): Promise<string> {
    try {
      const data = (await response.json()) as { detail?: string };
      return data.detail || `HTTP ${response.status}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }
}

