import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, output, signal } from '@angular/core';

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

@Component({
  selector: 'app-evacuation-mode',
  templateUrl: './evacuation-mode.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
})
export class EvacuationModeComponent {
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

  summary = signal<ProcessSummary>({
    totalTeam: 0,
    found: 0,
    missing: 0,
    incidents: 0,
  });

  canAnalyze = computed(() => !!this.teamFile() && !!this.accessFile() && !this.isProcessing());

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
      Teléfono: r.phone,
    })));
    XLSX.utils.book_append_sheet(wb, missingSheet, 'No_encontrados');

    const foundSheet = XLSX.utils.json_to_sheet(this.foundRows().map((r) => ({
      'Nº empleado': r.employeeNumber,
      Nombre: r.fullName,
      'Rol emergencias': r.emergencyRole,
      'Nombre en accesos': r.accessFullName,
      Empresa: r.company,
      'Último acceso': r.lastAccess,
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

    const fileName = `evacuacion_cruce_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.xlsx`;
    XLSX.writeFile(wb, fileName);
  }

  goBack(): void {
    this.backRequested.emit();
  }

  private resetResults(): void {
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
    this.summary.set({ totalTeam: 0, found: 0, missing: 0, incidents: 0 });
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
    const nominativeSheet = sheets.find((s) => this.normalizeSheetName(s.sheetName).includes('NOMINATIVO'));
    if (nominativeSheet) {
      const row1 = nominativeSheet.rows[0] ?? [];
      const normalizedRow1 = row1.map((v) => this.normalizeHeader(v));
      const looksLikeNominative =
        (normalizedRow1[0] ?? '').includes('EMPLEADO') &&
        (normalizedRow1[1] ?? '').includes('APELLIDO 1') &&
        (normalizedRow1[2] ?? '').includes('APELLIDO 2') &&
        (normalizedRow1[3] ?? '').includes('NOMBRE');

      if (looksLikeNominative) {
        return {
          rows: nominativeSheet.rows,
          map: {
            headerRowIndex: 0,
            employeeNumber: 0,   // A
            firstSurname: 1,     // B
            secondSurname: 2,    // C
            firstName: 3,        // D
            email: 4,            // E
            phone: 5,            // F
            emergencyRole: 31,   // AF
          },
        };
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
        // Fallback muy estable para la plantilla observada: B..I y cabecera en fila 7 (index 6)
        if (detected.employeeNumber === null || detected.lastAccess === null) {
          return {
            rows: sheet.rows,
            map: {
              headerRowIndex: 6,
              employeeNumber: 1, // B
              firstName: 2,      // C
              surname: 3,        // D
              company: 4,        // E
              lastAccess: 8,     // I
            },
          };
        }
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
      emergencyRole: null,
    };

    for (let i = 0; i < Math.min(rows.length, 12); i++) {
      const row = rows[i] ?? [];
      const normalized = row.map((v) => this.normalizeHeader(v));
      const employee = this.findHeaderIndex(normalized, ['N EMPLEADO', 'NO EMPLEADO', 'NUMERO EMPLEADO']);
      const firstName = this.findHeaderIndex(normalized, ['NOMBRE']);
      const role = this.findHeaderIndex(normalized, ['ROL EMERGENCIAS', 'ROL EMERGENCIA']);

      if (employee !== null && (firstName !== null || role !== null)) {
        return {
          headerRowIndex: i,
          employeeNumber: employee,
          firstSurname: this.findHeaderIndex(normalized, ['APELLIDO 1', 'PRIMER APELLIDO']),
          secondSurname: this.findHeaderIndex(normalized, ['APELLIDO 2', 'SEGUNDO APELLIDO']),
          firstName,
          email: this.findHeaderIndex(normalized, ['EMAIL', 'CORREO', 'MAIL']),
          phone: this.findHeaderIndex(normalized, ['TELEFONO', 'MOVIL', 'TEL']),
          emergencyRole: role,
        };
      }

      // Fallback para la plantilla real: cabecera en fila 1 con columnas A-F y AF.
      const hasKnownTeamShape =
        normalized[0]?.includes('EMPLEADO') &&
        normalized[1]?.includes('APELLIDO 1') &&
        normalized[3]?.includes('NOMBRE');
      if (hasKnownTeamShape) {
        const roleIndex = role ?? 31; // AF
        return {
          headerRowIndex: i,
          employeeNumber: 0,   // A
          firstSurname: 1,     // B
          secondSurname: 2,    // C
          firstName: 3,        // D
          email: 4,            // E
          phone: 5,            // F
          emergencyRole: roleIndex,
        };
      }
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
      const employee = this.findHeaderIndex(normalized, [
        'N EMPLEADO TARJETAHABIENTE',
        'NO EMPLEADO TARJETAHABIENTE',
        'NUMERO EMPLEADO TARJETAHABIENTE',
        'N EMPLEADO',
      ]);
      const lastAccess = this.findHeaderIndex(normalized, ['ULTIMO ACCESO']);

      if (employee !== null && lastAccess !== null) {
        return {
          headerRowIndex: i,
          employeeNumber: employee,
          firstName: this.findHeaderIndex(normalized, ['NOMBRE DE PILA', 'NOMBRE']),
          surname: this.findHeaderIndex(normalized, ['APELLIDO']),
          company: this.findHeaderIndex(normalized, ['EMPRESA TARJETAHABIENTE', 'EMPRESA']),
          lastAccess,
        };
      }

      // Fallback para la plantilla real del snapshot: cabecera típica en fila ~7, columnas B..I.
      const hasKnownAccessShape =
        normalized.some((h) => h.includes('ULTIMO ACCESO')) &&
        normalized.some((h) => h.includes('APELLIDO')) &&
        normalized.some((h) => h.includes('NOMBRE DE PILA') || h === 'NOMBRE');
      if (hasKnownAccessShape) {
        return {
          headerRowIndex: i,
          employeeNumber: employee ?? 1, // B
          firstName: this.findHeaderIndex(normalized, ['NOMBRE DE PILA', 'NOMBRE']) ?? 2, // C
          surname: this.findHeaderIndex(normalized, ['APELLIDO']) ?? 3, // D
          company: this.findHeaderIndex(normalized, ['EMPRESA TARJETAHABIENTE', 'EMPRESA']) ?? 4, // E
          lastAccess: lastAccess ?? 8, // I
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

    for (let i = map.headerRowIndex + 1; i < rows.length; i++) {
      const row = rows[i] ?? [];
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
        emergencyRole: emergencyRoleRaw,
      });
    }

    return { validRows, invalidRows };
  }

  private parseAccessRows(rows: string[][], map: AccessColumnMap): { validRows: AccessSnapshotRow[]; invalidRows: InvalidRow[] } {
    const validRows: AccessSnapshotRow[] = [];
    const invalidRows: InvalidRow[] = [];

    for (let i = map.headerRowIndex + 1; i < rows.length; i++) {
      const row = rows[i] ?? [];
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
      .replace(/[º°ª]/g, ' ')
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



