import { registerPlugin } from '@capacitor/core';

/**
 * Finds AirFlash nodes on the local network (iOS only; a no-op on the web).
 *
 *   Bonjour.addListener('serviceFound', ({ name, host, port, addresses }) => ...)
 *   Bonjour.addListener('serviceLost', ({ name }) => ...)
 *   Bonjour.addListener('error', ({ code, message }) => ...)   // code: LOCAL_NETWORK_DENIED | BROWSE_FAILED
 *   await Bonjour.start({ type: '_airflash._tcp' })
 *   await Bonjour.stop()
 *
 * `host` is ready for a URL (IPv6 is bracketed); it is "" when the service could not be
 * resolved yet, and `port` is 0 in that case.
 */
export const Bonjour = registerPlugin('AirflashBonjour', {
  web: () => Promise.resolve({
    start: async () => {},
    stop: async () => {},
    addListener: async () => ({ remove: async () => {} }),
    removeAllListeners: async () => {},
  }),
});
