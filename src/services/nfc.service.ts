import { Injectable, signal, inject } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { DataService } from './data.service';

export type ConnectorStatus = 'connector_running_reader' | 'connector_running_no_reader' | 'connector_unreachable' | 'checking';

@Injectable({
  providedIn: 'root',
})
export class NfcService {
  private dataService = inject(DataService);
  status = signal<ConnectorStatus>('checking');
  isSimulationMode = signal(false);
  stationId = signal(this.resolveStationId());
  agentDownloadUrl = signal('');

  private pollingInterval: number | null = null;
  private reconnectInterval: number | null = null;
  private simulationInterval: number | null = null;
  private readErrorCount = 0;
  private readonly MAX_READ_ERRORS = 3;
  private lastEventId = 0;

  private uidRead = new Subject<string>();
  public uidRead$: Observable<string> = this.uidRead.asObservable();

  toggleSimulationMode(): void {
    this.isSimulationMode.update(on => !on);
    if (this.isSimulationMode()) {
      this.stopPollingForReads();
      this.stopReconnecting();
      this.startSimulation();
    } else {
      this.stopSimulation();
      this.checkConnectorStatus(); // Check real status after stopping simulation
    }
  }

  async ensureReadyForSessionStart(): Promise<boolean> {
    // Allow forcing simulation for local/dev use via query param or localStorage.
    try {
      const params = new URLSearchParams(window.location.search);
      const urlFlag = params.get('simulate_bridge');
      const localFlag = localStorage.getItem('simulate_bridge');
      if (urlFlag === '1' || localFlag === '1') {
        if (!this.isSimulationMode()) this.isSimulationMode.set(true);
        return true;
      }
    } catch (e) {
      // ignore URL/localStorage issues and continue with normal checks
    }

    await this.checkConnectorStatus();
    return this.status() === 'connector_running_reader' || this.isSimulationMode();
  }

  async refreshAgentDownloadInfo(): Promise<void> {
    try {
      const response = await fetch('/api/agent/download-info');
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      if (typeof data.download_url === 'string') {
        this.agentDownloadUrl.set(data.download_url);
      }
    } catch (error) {
      console.warn('Could not load agent download info', error);
    }
  }

  async checkConnectorStatus(): Promise<void> {
    if (this.isSimulationMode()) return;

    if (this.pollingInterval) {
      return;
    }
    this.status.set('checking');
    try {
      const response = await fetch(`/api/stations/${encodeURIComponent(this.stationId())}/status`);
      if (!response.ok) {
        throw new Error(`Connector responded with status: ${response.status}`);
      }
      const data = await response.json();

      this.stopReconnecting(); // Connection successful, stop retry attempts.

      if (data.online && data.reader_connected) {
        this.status.set('connector_running_reader');
        this.startPollingForReads();
      } else if (data.online) {
        this.status.set('connector_running_no_reader');
        this.startReconnecting(); // Keep checking for a reader to be attached.
      } else {
        this.status.set('connector_unreachable');
        this.startReconnecting();
      }
    } catch (error) {
      this.diagnoseFetchError(error);
      this.status.set('connector_unreachable');
      this.startReconnecting();
    }
  }

  startPollingForReads(): void {
    if (this.isSimulationMode() || this.pollingInterval) return;
    
    this.readErrorCount = 0; // Reset error count on new polling start

    this.pollingInterval = window.setInterval(async () => {
      if (this.status() !== 'connector_running_reader') {
        this.stopPollingForReads(); 
        this.checkConnectorStatus();
        return;
      }

      try {
        const response = await fetch(`/api/stations/${encodeURIComponent(this.stationId())}/events?after_event_id=${this.lastEventId}&limit=50`);
        if (response.ok) {
          this.readErrorCount = 0; // Reset on successful read
          const data = await response.json();
          if (data && Array.isArray(data.events)) {
            for (const event of data.events) {
              if (event?.uid) {
                this.uidRead.next(event.uid);
              }
            }
          }
          if (typeof data?.last_event_id === 'number') {
            this.lastEventId = data.last_event_id;
          }
        } else {
           throw new Error(`Read endpoint responded with status: ${response.status}`);
        }
      } catch (error) {
        this.readErrorCount++;
        console.warn(`Read attempt ${this.readErrorCount}/${this.MAX_READ_ERRORS} failed.`, error);

        if (this.readErrorCount >= this.MAX_READ_ERRORS) {
            console.error(`Stopping polling after ${this.MAX_READ_ERRORS} consecutive read failures. Re-checking connector status.`);
            this.stopPollingForReads();
            this.checkConnectorStatus();
        }
      }
    }, 1000);
  }

  stopPollingForReads(): void {
    if (this.pollingInterval) {
      window.clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  private startReconnecting(): void {
    if (this.reconnectInterval) return; 
    this.reconnectInterval = window.setInterval(() => {
        console.log('Attempting to reconnect to NFC connector...');
        this.checkConnectorStatus();
    }, 3000);
  }

  private stopReconnecting(): void {
      if (this.reconnectInterval) {
          window.clearInterval(this.reconnectInterval);
          this.reconnectInterval = null;
      }
  }

  private diagnoseFetchError(error: any): void {
    console.error("NFC Service Error:", error);
    if (error instanceof TypeError && error.message === 'Failed to fetch') {
        console.group("Fetch Error Diagnosis");
        console.info("A 'Failed to fetch' error occurred. This is a generic browser error that can be caused by several issues when developing with a local service:");
        console.warn("1. Mixed Content: Your app is on HTTPS, but the connector is on HTTP. Browsers block this for security. Check the browser console for 'mixed content' warnings. You might need to serve your app via HTTP for local development or configure a proxy.");
        console.warn("2. CORS Policy: The local connector (`.exe`) might not be sending the required `Access-Control-Allow-Origin` headers to allow your app's origin to make requests.");
        console.warn("3. Network Unreachable: The connector service at http://127.0.0.1:3210 is not running or is blocked by a firewall.");
        console.groupEnd();
    }
  }
  
  private startSimulation(): void {
    if (this.simulationInterval) return;
    this.status.set('connector_running_reader');
    console.log('Starting NFC simulation...');
    this.simulationInterval = window.setInterval(() => {
      const randomUid = this.dataService.getRandomEmployeeUid();
      console.log(`Simulating read for UID: ${randomUid}`);
      this.uidRead.next(randomUid);
    }, 4000);
  }

  private stopSimulation(): void {
    if (this.simulationInterval) {
      window.clearInterval(this.simulationInterval);
      this.simulationInterval = null;
      console.log('NFC simulation stopped.');
    }
  }

  cleanup(): void {
      this.stopPollingForReads();
      this.stopReconnecting();
      this.stopSimulation();
  }

  private resolveStationId(): string {
    const stationFromUrl = new URLSearchParams(window.location.search).get('station');
    if (stationFromUrl && stationFromUrl.trim().length > 0) {
      localStorage.setItem('nfc_station_id', stationFromUrl.trim());
      return stationFromUrl.trim();
    }

    const key = 'nfc_station_id';
    const existingValue = localStorage.getItem(key);
    if (existingValue && existingValue.trim().length > 0) {
      return existingValue.trim();
    }

    const defaultValue = 'local-station';
    localStorage.setItem(key, defaultValue);
    return defaultValue;
  }
}
