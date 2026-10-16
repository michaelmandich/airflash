import type { PluginListenerHandle } from '@capacitor/core';

export interface BonjourService {
  /** Service instance name, e.g. "AirFlash Office PC 1a2b". */
  name: string;
  /** Host ready for a URL: dotted IPv4, hostname, or bracketed IPv6. "" if unresolved. */
  host: string;
  /** TCP port, 0 if unresolved. */
  port: number;
  /** Every IP address we resolved (usually one). */
  addresses: string[];
}

export interface BonjourError {
  /** LOCAL_NETWORK_DENIED when iOS refused local-network access, otherwise BROWSE_FAILED. */
  code: 'LOCAL_NETWORK_DENIED' | 'BROWSE_FAILED';
  message: string;
}

export interface BonjourPlugin {
  /** Starts browsing. Calling it again restarts the browser. */
  start(options?: { type?: string }): Promise<void>;
  stop(): Promise<void>;
  addListener(eventName: 'serviceFound', listenerFunc: (service: BonjourService) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'serviceLost', listenerFunc: (service: { name: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'error', listenerFunc: (error: BonjourError) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export declare const Bonjour: BonjourPlugin;
