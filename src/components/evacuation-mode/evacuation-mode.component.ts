import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, computed, output, signal } from '@angular/core';

declare const XLSX: any;

type MaybeIndex = number | null;

interface TeamColumnMap {
  headerRowIndex: number;
  employeeNumber: MaybeIndex;
  firstSurname: MaybeIndex;
  secondSurname: MaybeIndex;
  firstName: MaybeIndex;
  email: MaybeIndex;
  phone: MaybeIndex;
  area: MaybeIndex;
  subArea: MaybeIndex;
  department: MaybeIndex;
  emergencyRole: MaybeIndex;
}

interface AccessColumnMap {
  headerRowIndex: number;
  employeeNumber: MaybeIndex;
  firstName: MaybeIndex;
  surname: MaybeIndex;
  company: MaybeIndex;
  lastAccess: MaybeIndex;
}

interface TeamMemberRow {
  rowNumber: number;
  employeeNumber: string;
  firstName: string;
  firstSurname: string;
  secondSurname: string;
  fullName: string;
  email: string;
  phone: string;
  area: string;
  subArea: string;
  department: string;
  emergencyRole: string;
}

interface AccessSnapshotRow {
  rowNumber: number;
  employeeNumber: string;
  firstName: string;
  surname: string;
  fullName: string;
  company: string;
  lastAccess: string;
}

interface DuplicateGroup {
  employeeNumber: string;
  count: number;
  rowNumbers: number[];
}

interface InvalidRow {
  source: 'team' | 'access';
  rowNumber: number;
  reason: string;
}

interface MatchResultRow {
  employeeNumber: string;
  fullName: string;
  emergencyRole: string;
  email: string;
  phone: string;
  area: string;
  subArea: string;
  department: string;
  accessFound: boolean;
  accessFullName: string;
  company: string;
  lastAccess: string;
}

interface AccessMetadata {
  reportTitle: string;
  user: string;
  reportDate: string;
  resultCount: string;
  area: string;
}

interface ProcessSummary {
  totalTeam: number;
  found: number;
  missing: number;
  incidents: number;
}

interface WorkbookSheetRows {
  sheetName: string;
  rows: string[][];
}

interface EvacuationSessionMemberApi {
  employee_number: string;
  ack_status: 'pending' | 'acknowledged';
  ack_at: string | null;
  ack_source: string | null;
}

interface EvacuationSessionApi {
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
  members: EvacuationSessionMemberApi[];
}

interface AckState {
  status: 'pending' | 'acknowledged';
  ackAt: string;
  ackSource: string;
}

@Component({
  selector: 'app-evacuation-mode',
  templateUrl: './evacuation-mode.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
})
export class EvacuationModeComponent implements OnDestroy {
  backRequested = output<void>();

  teamFile = signal<File | null>(null);
  accessFile = signal<File | null>(null);
  isProcessing = signal(false);
  processingError = signal('');
  hasResults = signal(false);

  teamColumnMap = signal<TeamColumnMap | null>(null);
  accessColumnMap = signal<AccessColumnMap | null>(null);
  accessMetadata = signal<AccessMetadata | null>(null);

  foundRows = signal<MatchResultRow[]>([]);
  missingRows = signal<MatchResultRow[]>([]);
  duplicateTeamRows = signal<DuplicateGroup[]>([]);
  duplicateAccessRows = signal<DuplicateGroup[]>([]);
  invalidRows = signal<InvalidRow[]>([]);
  evacuationSessionId = signal('');
  evacuationSessionSummary = signal<EvacuationSessionApi['summary'] | null>(null);
  evacuationAckMap = signal<Record<string, AckState>>({});
  sessionActionError = signal('');
  isCreatingEvacuationSession = signal(false);
  syncingEvacuationSession = signal(false);
  ackPendingEmployee = signal('');
  showOnlyPendingAcks = signal(false);

  private sessionPollTimer: number | null = null;

  summary = signal<ProcessSummary>({
    totalTeam: 0,
    found: 0,
    missing: 0,
    incidents: 0,
  });

  canAnalyze = computed(() => !!this.teamFile() && !!this.accessFile() && !this.isProcessing());
  canCreateEvacuationSession = computed(
    () => this.hasResults() && this.foundRows().length > 0 && !this.isCreatingEvacuationSession()
  );
  acknowledgedCount = computed(() => this.evacuationSessionSummary()?.acknowledged ?? 0);
  pendingAckCount = computed(() => this.evacuationSessionSummary()?.pending ?? 0);
  ackPercent = computed(() => this.evacuationSessionSummary()?.ack_percent ?? 0);
  displayedFoundRows = computed(() => {
    const onlyPending = this.showOnlyPendingAcks();
    const ackMap = this.evacuationAckMap();
    const rows = [...this.foundRows()].sort((a, b) => {
      const aAck = ackMap[a.employeeNumber]?.status === 'acknowledged' ? 1 : 0;
      const bAck = ackMap[b.employeeNumber]?.status === 'acknowledged' ? 1 : 0;
      if (aAck !== bAck) return aAck - bAck;
      return a.fullName.localeCompare(b.fullName, 'es');
    });
    return onlyPending ? rows.filter((r) => (ackMap[r.employeeNumber]?.status ?? 'pending') !== 'acknowledged') : rows;
  });

  previewTeamColumns = computed(() => {
    const map = this.teamColumnMap();
    if (!map) return [];
    return [
      this.formatMapping('Nº empleado', map.employeeNumber),
      this.formatMapping('Nombre', map.firstName),
      this.formatMapping('Apellido 1', map.firstSurname),
      this.formatMapping('Apellido 2', map.secondSurname),
      this.formatMapping('Email', map.email),
      this.formatMapping('Teléfono', map.phone),
      this.formatMapping('Area', map.area),
      this.formatMapping('Subarea', map.subArea),
      this.formatMapping('Departamento', map.department),
      this.formatMapping('Rol emergencias', map.emergencyRole),
    ];
  });

  previewAccessColumns = computed(() => {
    const map = this.accessColumnMap();
    if (!map) return [];
    return [
      this.formatMapping('Nº empleado', map.employeeNumber),
      this.formatMapping('Nombre', map.firstName),
      this.formatMapping('Apellido', map.surname),
      this.formatMapping('Empresa', map.company),
      this.formatMapping('Último acceso', map.lastAccess),
    ];
  });

  onTeamFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.teamFile.set(input.files?.[0] ?? null);
    this.resetResults();
  }

  onAccessFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.accessFile.set(input.files?.[0] ?? null);
    this.resetResults();
  }

  async analyzeFiles(): Promise<void> {
    const teamFile = this.teamFile();
    const accessFile = this.accessFile();
    if (!teamFile || !accessFile) {
      this.processingError.set('Debe cargar ambos ficheros Excel antes de analizar.');
      return;
    }

    this.isProcessing.set(true);
    this.processingError.set('');
    this.hasResults.set(false);

    try {
      const teamWorkbookSheets = await this.readWorkbookSheetsAsRows(teamFile);
      const accessWorkbookSheets = await this.readWorkbookSheetsAsRows(accessFile);

      const teamSelection = this.selectBestTeamSheet(teamWorkbookSheets);
      const accessSelection = this.selectBestAccessSheet(accessWorkbookSheets);

      const teamRows = teamSelection.rows;
      const accessRows = accessSelection.rows;
      const teamMap = teamSelection.map;
      const accessMap = accessSelection.map;
      this.teamColumnMap.set(teamMap);
      this.accessColumnMap.set(accessMap);
      this.accessMetadata.set(this.extractAccessMetadata(accessRows, accessMap.headerRowIndex));

      const missingMappings: string[] = [];
      if (teamMap.employeeNumber === null) missingMappings.push('Equipo: Nº empleado');
      if (teamMap.emergencyRole === null) missingMappings.push('Equipo: Rol Emergencias');
      if (accessMap.employeeNumber === null) missingMappings.push('Accesos: Nº empleado');
      if (accessMap.lastAccess === null) missingMappings.push('Accesos: Último acceso');

      if (missingMappings.length > 0) {
        throw new Error(`No se pudieron detectar columnas obligatorias: ${missingMappings.join(', ')}`);
      }

      const parsedTeam = this.parseTeamRows(teamRows, teamMap);
      const parsedAccess = this.parseAccessRows(accessRows, accessMap);

      const duplicateTeamRows = this.buildDuplicates(parsedTeam.validRows.map((r) => ({ employeeNumber: r.employeeNumber, rowNumber: r.rowNumber })));
      const duplicateAccessRows = this.buildDuplicates(parsedAccess.validRows.map((r) => ({ employeeNumber: r.employeeNumber, rowNumber: r.rowNumber })));

      const accessByEmployee = new Map<string, AccessSnapshotRow>();
      for (const row of parsedAccess.validRows) {
        if (!accessByEmployee.has(row.employeeNumber)) {
          accessByEmployee.set(row.employeeNumber, row);
        }
      }

      const found: MatchResultRow[] = [];
      const missing: MatchResultRow[] = [];

      for (const member of parsedTeam.validRows) {
        const access = accessByEmployee.get(member.employeeNumber);
        const result: MatchResultRow = {
          employeeNumber: member.employeeNumber,
          fullName: member.fullName,
          emergencyRole: member.emergencyRole,
          email: member.email,
          phone: member.phone,
          area: member.area,
          subArea: member.subArea,
          department: member.department,
          accessFound: !!access,
          accessFullName: access?.fullName ?? '',
          company: access?.company ?? '',
          lastAccess: access?.lastAccess ?? '',
        };

        if (access) {
          found.push(result);
        } else {
          missing.push(result);
        }
      }

      const invalidRows = [...parsedTeam.invalidRows, ...parsedAccess.invalidRows];
      const incidents = duplicateTeamRows.length + duplicateAccessRows.length + invalidRows.length;

      this.foundRows.set(found);
      this.missingRows.set(missing);
      this.duplicateTeamRows.set(duplicateTeamRows);
      this.duplicateAccessRows.set(duplicateAccessRows);
      this.invalidRows.set(invalidRows);
      this.summary.set({
        totalTeam: parsedTeam.validRows.length,
        found: found.length,
        missing: missing.length,
        incidents,
      });
      this.hasResults.set(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error desconocido al procesar los ficheros.';
      this.processingError.set(message);
    } finally {
      this.isProcessing.set(false);
    }
  }

  exportResults(): void {
    if (!this.hasResults()) return;

    const summary = this.summary();
    const metadata = this.accessMetadata();
    const duplicates = [
      ...this.duplicateTeamRows().map((d) => ({ origen: 'Equipo evacuación', ...d })),
      ...this.duplicateAccessRows().map((d) => ({ origen: 'Accesos', ...d })),
    ];

    const wb = XLSX.utils.book_new();

    const summarySheet = XLSX.utils.aoa_to_sheet([
      ['Resumen evacuación'],
      [],
      ['Fecha de exportación', new Date().toLocaleString()],
      ['Total equipo evacuación', summary.totalTeam],
      ['Encontrados en accesos', summary.found],
      ['No encontrados', summary.missing],
      ['Incidencias', summary.incidents],
      [],
      ['Metadata informe accesos'],
      ['Título informe', metadata?.reportTitle ?? ''],
      ['Usuario', metadata?.user ?? ''],
      ['Fecha informe', metadata?.reportDate ?? ''],
      ['Resultados consulta', metadata?.resultCount ?? ''],
      ['Área', metadata?.area ?? ''],
    ]);
    XLSX.utils.book_append_sheet(wb, summarySheet, 'Resumen');

    const missingSheet = XLSX.utils.json_to_sheet(this.missingRows().map((r) => ({
      'Nº empleado': r.employeeNumber,
      Nombre: r.fullName,
      'Rol emergencias': r.emergencyRole,
      Email: r.email,
      'Teléfono': r.phone,
    })));
    XLSX.utils.book_append_sheet(wb, missingSheet, 'No_encontrados');

    const foundSheet = XLSX.utils.json_to_sheet(this.foundRows().map((r) => ({
      'Nº empleado': r.employeeNumber,
      Nombre: r.fullName,
      'Rol emergencias': r.emergencyRole,
      'Nombre en accesos': r.accessFullName,
      Area: r.area,
      Subarea: r.subArea,
      Departamento: r.department,
      Email: r.email,
      'Teléfono': r.phone,
    })));
    XLSX.utils.book_append_sheet(wb, foundSheet, 'Encontrados');

    const duplicatesSheet = XLSX.utils.json_to_sheet(duplicates.map((d) => ({
      Origen: d.origen,
      'Nº empleado': d.employeeNumber,
      Veces: d.count,
      Filas: d.rowNumbers.join(', '),
    })));
    XLSX.utils.book_append_sheet(wb, duplicatesSheet, 'Duplicados');

    const invalidSheet = XLSX.utils.json_to_sheet(this.invalidRows().map((r) => ({
      Origen: r.source === 'team' ? 'Equipo evacuación' : 'Accesos',
      Fila: r.rowNumber,
      Motivo: r.reason,
    })));
    XLSX.utils.book_append_sheet(wb, invalidSheet, 'Errores_datos');

    const fileName = `evacuación_cruce_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.xlsx`;
    XLSX.writeFile(wb, fileName);
  }

  ngOnDestroy(): void {
    this.stopSessionPolling();
  }

  async createEvacuationSession(): Promise<void> {
    if (!this.hasResults() || this.foundRows().length === 0) return;

    this.isCreatingEvacuationSession.set(true);
    this.sessionActionError.set('');
    try {
      const payload = {
        metadata: {
          reportTitle: this.accessMetadata()?.reportTitle ?? '',
          reportDate: this.accessMetadata()?.reportDate ?? '',
          user: this.accessMetadata()?.user ?? '',
          area: this.accessMetadata()?.area ?? '',
        },
        members: this.foundRows().map((r) => ({
          employee_number: r.employeeNumber,
          full_name: r.fullName,
          emergency_role: r.emergencyRole,
          access_full_name: r.accessFullName,
          email: r.email,
          phone: r.phone,
          area: r.area,
          sub_area: r.subArea,
          department: r.department,
        })),
      };

      const session = await this.apiPost<EvacuationSessionApi>('/api/evacuation-sessions', payload);
      this.applyEvacuationSession(session);
      this.startSessionPolling();
    } catch (error) {
      this.sessionActionError.set(error instanceof Error ? error.message : 'No se pudo crear la sesión de evacuación.');
    } finally {
      this.isCreatingEvacuationSession.set(false);
    }
  }

  async refreshEvacuationSession(): Promise<void> {
    const sessionId = this.evacuationSessionId();
    if (!sessionId) return;
    this.syncingEvacuationSession.set(true);
    this.sessionActionError.set('');
    try {
      const session = await this.apiGet<EvacuationSessionApi>(`/api/evacuation-sessions/${encodeURIComponent(sessionId)}`);
      this.applyEvacuationSession(session);
    } catch (error) {
      this.sessionActionError.set(error instanceof Error ? error.message : 'No se pudo sincronizar la sesión.');
    } finally {
      this.syncingEvacuationSession.set(false);
    }
  }

  async acknowledgeMember(employeeNumber: string, acknowledged = true): Promise<void> {
    const sessionId = this.evacuationSessionId();
    if (!sessionId) return;
    this.ackPendingEmployee.set(employeeNumber);
    this.sessionActionError.set('');
    try {
      const session = await this.apiPost<EvacuationSessionApi>(
        `/api/evacuation-sessions/${encodeURIComponent(sessionId)}/acknowledge`,
        {
          employee_number: employeeNumber,
          acknowledged,
          ack_source: 'operator',
        }
      );
      this.applyEvacuationSession(session);
    } catch (error) {
      this.sessionActionError.set(error instanceof Error ? error.message : 'No se pudo registrar la confirmación.');
    } finally {
      this.ackPendingEmployee.set('');
    }
  }

  toggleOnlyPendingAcks(): void {
    this.showOnlyPendingAcks.set(!this.showOnlyPendingAcks());
  }

  isAcknowledged(employeeNumber: string): boolean {
    return this.evacuationAckMap()[employeeNumber]?.status === 'acknowledged';
  }

  getAckStatusLabel(employeeNumber: string): string {
    return this.isAcknowledged(employeeNumber) ? 'Confirmado' : 'Pendiente';
  }

  getAckBadgeClass(employeeNumber: string): string {
    return this.isAcknowledged(employeeNumber)
      ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
      : 'bg-amber-100 text-amber-900 border border-amber-200';
  }

  getAckRowClass(employeeNumber: string): string {
    return this.isAcknowledged(employeeNumber) ? 'bg-emerald-50/40' : 'bg-red-50/40';
  }

  getAckTimeText(employeeNumber: string): string {
    const ackAt = this.evacuationAckMap()[employeeNumber]?.ackAt;
    if (!ackAt) return '';
    const dt = new Date(ackAt);
    if (Number.isNaN(dt.getTime())) return ackAt;
    return dt.toLocaleTimeString();
  }

  goBack(): void {
    this.backRequested.emit();
  }

  private resetResults(): void {
    this.stopSessionPolling();
    this.processingError.set('');
    this.hasResults.set(false);
    this.teamColumnMap.set(null);
    this.accessColumnMap.set(null);
    this.accessMetadata.set(null);
    this.foundRows.set([]);
    this.missingRows.set([]);
    this.duplicateTeamRows.set([]);
    this.duplicateAccessRows.set([]);
    this.invalidRows.set([]);
    this.evacuationSessionId.set('');
    this.evacuationSessionSummary.set(null);
    this.evacuationAckMap.set({});
    this.sessionActionError.set('');
    this.isCreatingEvacuationSession.set(false);
    this.syncingEvacuationSession.set(false);
    this.ackPendingEmployee.set('');
    this.showOnlyPendingAcks.set(false);
    this.summary.set({ totalTeam: 0, found: 0, missing: 0, incidents: 0 });
  }

  private applyEvacuationSession(session: EvacuationSessionApi): void {
    this.evacuationSessionId.set(session.session_id);
    this.evacuationSessionSummary.set(session.summary);

    const ackMap: Record<string, AckState> = {};
    for (const member of session.members) {
      ackMap[member.employee_number] = {
        status: member.ack_status,
        ackAt: member.ack_at ?? '',
        ackSource: member.ack_source ?? '',
      };
    }
    this.evacuationAckMap.set(ackMap);
  }

  private startSessionPolling(): void {
    this.stopSessionPolling();
    this.sessionPollTimer = window.setInterval(() => {
      if (this.evacuationSessionId()) {
        this.refreshEvacuationSession().catch(() => undefined);
      }
    }, 3000);
  }

  private stopSessionPolling(): void {
    if (this.sessionPollTimer !== null) {
      window.clearInterval(this.sessionPollTimer);
      this.sessionPollTimer = null;
    }
  }

  private async apiGet<T>(url: string): Promise<T> {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      const detail = await this.readApiError(response);
      throw new Error(detail || `HTTP ${response.status}`);
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
      const detail = await this.readApiError(response);
      throw new Error(detail || `HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private async readApiError(response: Response): Promise<string> {
    try {
      const data = (await response.json()) as { detail?: string };
      return data.detail ?? '';
    } catch {
      return '';
    }
  }

  private async readWorkbookSheetsAsRows(file: File): Promise<WorkbookSheetRows[]> {
    const arrayBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    if (!workbook.SheetNames?.length) {
      throw new Error(`El fichero "${file.name}" no contiene hojas.`);
    }

    const result: WorkbookSheetRows[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: '',
        blankrows: false,
      }) as unknown[][];

      result.push({
        sheetName,
        rows: rows.map((row) => row.map((cell) => this.cellToText(cell))),
      });
    }

    return result;
  }

  private selectBestTeamSheet(sheets: WorkbookSheetRows[]): { rows: string[][]; map: TeamColumnMap } {
    // Plantilla real: la hoja correcta suele llamarse "NOMINATIVO".
    // La detección de columnas se hace por nombre (fila de cabecera), no por posición.
    const nominativeSheet = sheets.find((s) => this.normalizeSheetName(s.sheetName).includes('NOMINATIVO'));
    if (nominativeSheet) {
      const nominatedMap = this.detectTeamColumns(nominativeSheet.rows);
      if (nominatedMap.employeeNumber !== null && nominatedMap.emergencyRole !== null) {
        return { rows: nominativeSheet.rows, map: nominatedMap };
      }
    }

    let best: { rows: string[][]; map: TeamColumnMap; score: number } | null = null;

    for (const sheet of sheets) {
      const map = this.detectTeamColumns(sheet.rows);
      const score =
        (map.employeeNumber !== null ? 3 : 0) +
        (map.emergencyRole !== null ? 3 : 0) +
        (map.firstName !== null ? 1 : 0) +
        (map.firstSurname !== null ? 1 : 0) +
        (map.secondSurname !== null ? 1 : 0);

      if (!best || score > best.score) {
        best = { rows: sheet.rows, map, score };
      }
    }

    if (!best) {
      throw new Error('No se pudo leer ninguna hoja del Excel del equipo de evacuación.');
    }

    return { rows: best.rows, map: best.map };
  }

  private selectBestAccessSheet(sheets: WorkbookSheetRows[]): { rows: string[][]; map: AccessColumnMap } {
    // Plantilla real del snapshot: hoja con encabezado "Informe de Evacuación" y cabecera tabular con "Último acceso".
    for (const sheet of sheets) {
      const topRows = (sheet.rows.slice(0, 10) ?? []).map((r) => r.filter(Boolean).join(' ')).join(' | ');
      const topText = this.stripAccents(topRows).toUpperCase();
      if (topText.includes('INFORME DE EVACUACION')) {
        const detected = this.detectAccessColumns(sheet.rows);
        // No forzamos posiciones: si falta una columna, preferimos error explícito.
        return { rows: sheet.rows, map: detected };
      }
    }

    let best: { rows: string[][]; map: AccessColumnMap; score: number } | null = null;

    for (const sheet of sheets) {
      const map = this.detectAccessColumns(sheet.rows);
      const score =
        (map.employeeNumber !== null ? 3 : 0) +
        (map.lastAccess !== null ? 3 : 0) +
        (map.firstName !== null ? 1 : 0) +
        (map.surname !== null ? 1 : 0) +
        (map.company !== null ? 1 : 0);

      if (!best || score > best.score) {
        best = { rows: sheet.rows, map, score };
      }
    }

    if (!best) {
      throw new Error('No se pudo leer ninguna hoja del Excel de accesos.');
    }

    return { rows: best.rows, map: best.map };
  }

  private detectTeamColumns(rows: string[][]): TeamColumnMap {
    const defaultMap: TeamColumnMap = {
      headerRowIndex: 0,
      employeeNumber: null,
      firstSurname: null,
      secondSurname: null,
      firstName: null,
      email: null,
      phone: null,
      area: null,
      subArea: null,
      department: null,
      emergencyRole: null,
    };

    for (let i = 0; i < Math.min(rows.length, 12); i++) {
      const row = rows[i] ?? [];
      const normalized = row.map((v) => this.normalizeHeader(v));
      const employee = this.findHeaderIndexByAnyTokenSet(normalized, [
        ['EMPLEADO'],
      ]);
      const firstName = this.findHeaderIndex(normalized, ['NOMBRE']);
      const role = this.findHeaderIndexByAnyTokenSet(normalized, [
        ['ROL', 'EMERGENCIAS'],
        ['ROL', 'EMERGENCIA'],
      ]);
      const firstSurname = this.findHeaderIndex(normalized, ['APELLIDO 1', 'PRIMER APELLIDO']);
      const secondSurname = this.findHeaderIndex(normalized, ['APELLIDO 2', 'SEGUNDO APELLIDO']);
      const email = this.findHeaderIndex(normalized, ['EMAIL', 'CORREO', 'MAIL']);
      const phone = this.findHeaderIndex(normalized, ['TELEFONO', 'MOVIL', 'TEL']);
      const area = this.findHeaderIndex(normalized, ['AREA', 'AREA RESPONSABLE']);
      const subArea = this.findHeaderIndex(normalized, ['SUB AREA', 'SUBAREA', 'SUB-AREA']);
      const department = this.findHeaderIndex(normalized, ['DEPARTAMENTO']);

      // Cabecera del maestro: exigimos al menos los campos clave de identidad + rol.
      const looksLikeTeamTable =
        employee !== null &&
        firstSurname !== null &&
        secondSurname !== null &&
        firstName !== null &&
        role !== null;

      if (looksLikeTeamTable) {
        return {
          headerRowIndex: i,
          employeeNumber: employee,
          firstSurname,
          secondSurname,
          firstName,
          email,
          phone,
          area,
          subArea,
          department,
          emergencyRole: role,
        };
      }

      // Sin fallback por posición: el maestro debe resolverse por títulos de columna.
    }

    return defaultMap;
  }

  private detectAccessColumns(rows: string[][]): AccessColumnMap {
    const defaultMap: AccessColumnMap = {
      headerRowIndex: 0,
      employeeNumber: null,
      firstName: null,
      surname: null,
      company: null,
      lastAccess: null,
    };

    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const row = rows[i] ?? [];
      const normalized = row.map((v) => this.normalizeHeader(v));
      const employee = this.findHeaderIndexByAnyTokenSet(normalized, [
        ['EMPLEADO', 'TARJETAHABIENTE'],
        ['EMPLEADO'],
      ]);
      const firstName = this.findHeaderIndexByAnyTokenSet(normalized, [
        ['NOMBRE', 'PILA'],
        ['NOMBRE'],
      ]);
      const surname = this.findHeaderIndexByAnyTokenSet(normalized, [['APELLIDO']]);
      const company = this.findHeaderIndexByAnyTokenSet(normalized, [
        ['EMPRESA', 'TARJETAHABIENTE'],
        ['EMPRESA'],
      ]);
      const lastAccess = this.findHeaderIndexByAnyTokenSet(normalized, [['ULTIMO', 'ACCESO']]);

      if (employee !== null && lastAccess !== null) {
        return {
          headerRowIndex: i,
          employeeNumber: employee,
          firstName,
          surname,
          company,
          lastAccess,
        };
      }

      // Cabecera tipo snapshot: validamos por tokens, pero sin inventar posiciones.
      const hasKnownAccessShape =
        employee !== null &&
        firstName !== null &&
        surname !== null &&
        lastAccess !== null;
      if (hasKnownAccessShape) {
        return {
          headerRowIndex: i,
          employeeNumber: employee,
          firstName,
          surname,
          company,
          lastAccess,
        };
      }
    }

    return defaultMap;
  }

  private extractAccessMetadata(rows: string[][], headerRowIndex: number): AccessMetadata {
    const meta: AccessMetadata = {
      reportTitle: '',
      user: '',
      reportDate: '',
      resultCount: '',
      area: '',
    };

    for (let i = 0; i < Math.min(headerRowIndex, rows.length); i++) {
      const text = rows[i].filter(Boolean).join(' ').trim();
      const upper = this.stripAccents(text).toUpperCase();
      if (!meta.reportTitle && upper.includes('INFORME') && upper.includes('EVACUACION')) meta.reportTitle = text;
      if (!meta.user && upper.startsWith('USUARIO:')) meta.user = text;
      if (!meta.reportDate && upper.startsWith('FECHA:')) meta.reportDate = text;
      if (!meta.resultCount && upper.includes('NUMERO DE RESULTADOS')) meta.resultCount = text;
      if (!meta.area && upper.startsWith('AREAS')) meta.area = text;
    }

    return meta;
  }

  private parseTeamRows(rows: string[][], map: TeamColumnMap): { validRows: TeamMemberRow[]; invalidRows: InvalidRow[] } {
    const validRows: TeamMemberRow[] = [];
    const invalidRows: InvalidRow[] = [];
    const tableColumns = this.uniqueIndexes([
      map.employeeNumber,
      map.firstSurname,
      map.secondSurname,
      map.firstName,
      map.email,
      map.phone,
      map.area,
      map.subArea,
      map.department,
      map.emergencyRole,
    ]);

    for (let i = map.headerRowIndex + 1; i < rows.length; i++) {
      const row = rows[i] ?? [];
      if (this.isTableTerminatorRow(row, tableColumns)) break;
      if (this.isRowEmpty(row)) continue;

      const emergencyRoleRaw = this.getCell(row, map.emergencyRole);
      if (!this.isEmergencyTeamMember(emergencyRoleRaw)) {
        continue;
      }

      const employee = this.normalizeEmployeeNumber(this.getCell(row, map.employeeNumber));
      if (!employee) {
        invalidRows.push({ source: 'team', rowNumber: i + 1, reason: 'Nº empleado vacío o inválido' });
        continue;
      }

      const firstName = this.getCell(row, map.firstName);
      const firstSurname = this.getCell(row, map.firstSurname);
      const secondSurname = this.getCell(row, map.secondSurname);

      validRows.push({
        rowNumber: i + 1,
        employeeNumber: employee,
        firstName,
        firstSurname,
        secondSurname,
        fullName: [firstName, firstSurname, secondSurname].filter(Boolean).join(' ').trim(),
        email: this.getCell(row, map.email),
        phone: this.getCell(row, map.phone),
        area: this.getCell(row, map.area),
        subArea: this.getCell(row, map.subArea),
        department: this.getCell(row, map.department),
        emergencyRole: emergencyRoleRaw,
      });
    }

    return { validRows, invalidRows };
  }

  private parseAccessRows(rows: string[][], map: AccessColumnMap): { validRows: AccessSnapshotRow[]; invalidRows: InvalidRow[] } {
    const validRows: AccessSnapshotRow[] = [];
    const invalidRows: InvalidRow[] = [];
    const tableColumns = this.uniqueIndexes([
      map.employeeNumber,
      map.firstName,
      map.surname,
      map.company,
      map.lastAccess,
    ]);

    for (let i = map.headerRowIndex + 1; i < rows.length; i++) {
      const row = rows[i] ?? [];
      if (this.isTableTerminatorRow(row, tableColumns)) break;
      if (this.isRowEmpty(row)) continue;

      const employee = this.normalizeEmployeeNumber(this.getCell(row, map.employeeNumber));
      if (!employee) {
        continue;
      }

      const firstName = this.getCell(row, map.firstName);
      const surname = this.getCell(row, map.surname);

      validRows.push({
        rowNumber: i + 1,
        employeeNumber: employee,
        firstName,
        surname,
        fullName: [firstName, surname].filter(Boolean).join(' ').trim(),
        company: this.getCell(row, map.company),
        lastAccess: this.getCell(row, map.lastAccess),
      });
    }

    return { validRows, invalidRows };
  }

  private isEmergencyTeamMember(roleValue: string): boolean {
    const normalized = this.cellToText(roleValue).replace(',', '.');
    return normalized === '1' || normalized === '1.0';
  }

  private buildDuplicates(rows: Array<{ employeeNumber: string; rowNumber: number }>): DuplicateGroup[] {
    const grouped = new Map<string, number[]>();
    for (const row of rows) {
      const existing = grouped.get(row.employeeNumber) ?? [];
      existing.push(row.rowNumber);
      grouped.set(row.employeeNumber, existing);
    }

    return Array.from(grouped.entries())
      .filter(([, rowNumbers]) => rowNumbers.length > 1)
      .map(([employeeNumber, rowNumbers]) => ({
        employeeNumber,
        count: rowNumbers.length,
        rowNumbers,
      }))
      .sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber));
  }

  private getCell(row: string[], index: MaybeIndex): string {
    if (index === null || index < 0) return '';
    return this.cellToText(row[index] ?? '');
  }

  private cellToText(value: unknown): string {
    return String(value ?? '').trim();
  }

  private isRowEmpty(row: string[]): boolean {
    return row.every((cell) => this.cellToText(cell) === '');
  }

  private uniqueIndexes(indexes: MaybeIndex[]): number[] {
    return Array.from(new Set(indexes.filter((i): i is number => i !== null && i >= 0)));
  }

  private isTableTerminatorRow(row: string[], relevantIndexes: number[]): boolean {
    if (relevantIndexes.length === 0) {
      return this.isRowEmpty(row);
    }
    return relevantIndexes.every((idx) => this.getCell(row, idx) === '');
  }

  private normalizeEmployeeNumber(value: string): string {
    const trimmed = this.cellToText(value);
    if (!trimmed) return '';

    // If Excel formatted a numeric id as "1234.0", recover the integer text.
    if (/^\d+\.0+$/.test(trimmed)) {
      return trimmed.replace(/\.0+$/, '');
    }

    return trimmed;
  }

  private normalizeHeader(value: string): string {
    return this.stripAccents(this.cellToText(value))
      .replace(/[\u00BA\u00B0\u00AA]/g, ' ')
      .toUpperCase()
      // Quita cualquier símbolo raro (incluye NBSP, comillas especiales, etc.)
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeSheetName(value: string): string {
    return this.stripAccents(this.cellToText(value)).toUpperCase();
  }

  private stripAccents(value: string): string {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  private findHeaderIndex(normalizedHeaders: string[], candidates: string[]): MaybeIndex {
    for (let i = 0; i < normalizedHeaders.length; i++) {
      const header = normalizedHeaders[i];
      if (!header) continue;

      for (const candidate of candidates) {
        if (header === candidate || header.includes(candidate)) {
          return i;
        }
      }
    }
    return null;
  }

  private findHeaderIndexByAnyTokenSet(normalizedHeaders: string[], tokenSets: string[][]): MaybeIndex {
    for (let i = 0; i < normalizedHeaders.length; i++) {
      const header = normalizedHeaders[i];
      if (!header) continue;
      for (const tokens of tokenSets) {
        if (tokens.every((token) => header.includes(token))) {
          return i;
        }
      }
    }
    return null;
  }

  private formatMapping(label: string, index: MaybeIndex): { label: string; value: string } {
    return {
      label,
      value: index === null ? 'No detectada' : `Columna ${this.columnLetter(index)} (${index + 1})`,
    };
  }

  private columnLetter(index: number): string {
    let n = index + 1;
    let out = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  }
}






