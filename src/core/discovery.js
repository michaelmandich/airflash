'use strict';

const http = require('node:http');
const { EventEmitter } = require('node:events');

const SERVICE_TYPE = 'airflash';
const POLL_EVERY_MS = 3000;
const PEER_TIMEOUT_MS = 12 * 1000;

/**
 * Finds other AirFlash nodes on the LAN over mDNS (Bonjour), then polls each
 * one for its device list so a phone attached to your PC can still send to
 * your Mac (and vice versa).
 */
class Discovery extends EventEmitter {
  constructor({ nodeId, name, port, version }) {
    super();
    this.self = { nodeId, name, port, version };
    this.peers = new Map(); // nodeId -> { nodeId, name, host, port, devices, lastOk }
    this.bonjour = null;
    this.browser = null;
    this.poller = null;
    this.stopped = false;
  }

  start() {
    let Bonjour;
    try {
      ({ Bonjour } = require('bonjour-service'));
    } catch {
      this.emit('warn', 'bonjour-service not installed; LAN discovery disabled');
      return;
    }
    this.bonjour = new Bonjour({}, (err) => this.emit('warn', `mDNS error: ${err?.message || err}`));
    this.bonjour.publish({
      name: `AirFlash ${this.self.name} ${this.self.nodeId.slice(0, 4)}`,
      type: SERVICE_TYPE,
      port: this.self.port,
      txt: { id: this.self.nodeId, name: this.self.name, v: this.self.version },
    });
    this.browser = this.bonjour.find({ type: SERVICE_TYPE }, (svc) => this._onService(svc));
    this.browser.on('down', (svc) => {
      const id = svc?.txt?.id;
      if (id && this.peers.delete(id)) this.emit('change');
    });
    this.poller = setInterval(() => this._pollAll(), POLL_EVERY_MS);
    this.poller.unref();
    // Re-query periodically; some networks drop the first announcements.
    this.requery = setInterval(() => this.browser?.update(), 30 * 1000);
    this.requery.unref();
  }

  /** Manually add a peer (for networks where multicast is blocked). */
  addManual(host, port) {
    this._probe(host, port).catch(() => {});
  }

  _onService(svc) {
    const id = svc?.txt?.id;
    if (!id || id === this.self.nodeId) return;
    const host = (svc.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || svc.host;
    if (!host) return;
    this._probe(host, svc.port).catch(() => {});
  }

  async _probe(host, port) {
    if (this.stopped) return;
    const info = await getJson(host, port, '/api/node');
    if (this.stopped || !info?.nodeId || info.nodeId === this.self.nodeId) return;
    const existing = this.peers.get(info.nodeId);
    this.peers.set(info.nodeId, {
      nodeId: info.nodeId,
      name: info.name,
      host,
      port,
      devices: existing?.devices || [],
      lastOk: Date.now(),
    });
    if (!existing) this.emit('change');
    await this._poll(this.peers.get(info.nodeId));
  }

  async _pollAll() {
    await Promise.all([...this.peers.values()].map((p) => this._poll(p)));
  }

  async _poll(peer) {
    try {
      const res = await getJson(peer.host, peer.port, '/api/devices?local=1');
      if (this.stopped || !this.peers.has(peer.nodeId)) return;
      // (Older nodes don't report nodeId; only act on a real mismatch.)
      if (res.nodeId && res.nodeId !== peer.nodeId) {
        // A different node now owns that address (e.g. the app restarted on the same port).
        this.peers.delete(peer.nodeId);
        this.emit('change');
        this._probe(peer.host, peer.port).catch(() => {});
        return;
      }
      peer.lastOk = Date.now();
      const next = JSON.stringify(res.devices || []);
      if (next !== JSON.stringify(peer.devices)) {
        peer.devices = res.devices || [];
        this.emit('change');
      }
    } catch {
      if (Date.now() - peer.lastOk > PEER_TIMEOUT_MS) {
        this.peers.delete(peer.nodeId);
        this.emit('change');
      }
    }
  }

  getPeer(nodeId) {
    return this.peers.get(nodeId) || null;
  }

  list() {
    return [...this.peers.values()];
  }

  stop() {
    this.stopped = true;
    clearInterval(this.poller);
    clearInterval(this.requery);
    try { this.browser?.stop(); } catch {}
    return new Promise((resolve) => {
      if (!this.bonjour) return resolve();
      this.bonjour.unpublishAll(() => {
        try { this.bonjour.destroy(); } catch {}
        resolve();
      });
    });
  }
}

function getJson(host, port, pathname, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    // agent:false → no pooled keep-alive sockets lingering after stop() (they'd keep the process alive).
    const req = http.get({ host, port, path: pathname, agent: false, timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

module.exports = { Discovery };
