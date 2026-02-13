
export interface Record {
  timestamp: Date;
  nombre: string;
  uid: string | null;
  tipo: 'Tarjeta leída' | 'Usuario sin tarjeta' | 'No identificado';
  status: 'ok' | 'manual' | 'error';
}
