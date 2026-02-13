import { Injectable } from '@angular/core';
import { Record } from '../models/record.model';

// This declaration is needed because we are loading the library from a CDN
declare var XLSX: any;

@Injectable({
  providedIn: 'root',
})
export class ExcelExportService {
  exportToExcel(
    records: Record[],
    eventName: string,
    startTime: Date | null
  ): void {
    // Sheet 1: Raw Records
    const wsRecords = XLSX.utils.json_to_sheet(
      records.map(r => ({
        Timestamp: r.timestamp.toLocaleString(),
        Nombre: r.nombre,
        UID: r.uid || '',
        'Tipo registro': r.tipo,
      }))
    );
    // Auto-fit columns
    const recordsCols = [
        { wch: 20 }, { wch: 30 }, { wch: 20 }, { wch: 20 }
    ];
    wsRecords['!cols'] = recordsCols;


    // Sheet 2: Dashboard
    const totalRecords = records.length;
    const uniqueNames = new Set(records.map(r => r.nombre)).size;
    const uniqueUids = new Set(records.filter(r => r.uid).map(r => r.uid)).size;
    const typeCounts = records.reduce((acc, r) => {
        acc[r.tipo] = (acc[r.tipo] || 0) + 1;
        return acc;
    // Fix: Changed `Record<string, number>` to `{ [key: string]: number }` to avoid conflict with the imported `Record` interface.
    }, {} as { [key: string]: number });

    const summaryData = [
      ['Resumen del Evento'],
      [],
      ['Evento', eventName],
      ['Inicio', startTime ? startTime.toLocaleString() : 'N/A'],
      ['Fin', new Date().toLocaleString()],
      ['Total registros', totalRecords],
      ['Personas únicas (por nombre)', uniqueNames],
      ['UIDs únicos', uniqueUids],
      [],
      ['Registros por Tipo', 'Cantidad'],
      ...Object.entries(typeCounts),
    ];
    const wsDashboard = XLSX.utils.aoa_to_sheet(summaryData);
    const dashboardCols = [
        { wch: 30 }, { wch: 20 }
    ];
    wsDashboard['!cols'] = dashboardCols;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsRecords, 'Registros');
    XLSX.utils.book_append_sheet(wb, wsDashboard, 'Dashboard');

    const dateStr = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const fileName = `${dateStr}_${eventName.replace(/ /g, '_')}.xlsx`;
    XLSX.writeFile(wb, fileName);
  }
}
