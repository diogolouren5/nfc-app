import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class DataService {
  private employees = new Map<string, string>([
    ['EAB5EF7B', 'Elena Morata Fernández'],
    ['E5F6A7B8', 'Carlos Rodriguez'],
    ['C9D0E1F2', 'Elena Martinez'],
    ['A3B4C5D6', 'Javier Lopez'],
    ['E7F8A9B0', 'Laura Sanchez'],
    ['C1D2E3F4', 'Pedro Gomez'],
  ]);

  getEmployeeNameByUid(uid: string): string | undefined {
    const normalizedUid = uid.trim().toUpperCase();
    return this.employees.get(normalizedUid);
  }

  getRandomEmployeeUid(): string {
    const uids = Array.from(this.employees.keys());
    return uids[Math.floor(Math.random() * uids.length)];
  }
}
