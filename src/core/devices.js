'use strict';

const { EventEmitter } = require('node:events');
const { publicIdFromSecret, clampString } = require('./util');

const KINDS = new Set(['phone', 'tablet', 'laptop', 'desktop', 'other']);
const FORGET_AFTER_MS = 12 * 60 * 60 * 1000; // forget devices unseen for 12h
const HEARTBEAT_MS = 20 * 1000;

/**
 * Devices are browser/app clients attached to this node. A device proves who
 * it is with a private secret (kept in its localStorage); everyone else only
 * ever sees the public id derived from it.
 *
 * Devices stay in the registry after they disconnect, so you can send to a
 * phone whose browser is closed and it will pick the drop up when reopened.
 */
class DeviceRegistry extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map(); // publicId -> device
    this.heartbeat = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** Create or refresh a device from its secret + self-reported info. */
  touch(secret, info = {}, { isLocal = false } = {}) {
    if (!secret || String(secret).length < 16) return null;
    const id = publicIdFromSecret(secret);
    let d = this.devices.get(id);
    const isNew = !d;
    if (!d) {
      d = { id, name: 'Unnamed device', kind: 'other', host: false, lastSeen: 0, streams: new Set() };
      this.devices.set(id, d);
    }
    let changed = isNew;
    if (info.name) {
      const name = clampString(info.name, 40).trim();
      if (name && name !== d.name) { d.name = name; changed = true; }
    }
    if (info.kind && KINDS.has(info.kind) && info.kind !== d.kind) { d.kind = info.kind; changed = true; }
    if (isLocal && !d.host) { d.host = true; changed = true; }
    d.lastSeen = Date.now();
    if (changed) this.emit('change');
    return d;
  }

  get(id) {
    return this.devices.get(id) || null;
  }

  /** Attach a Server-Sent Events response to a device. */
  attachStream(device, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const wasOnline = device.streams.size > 0;
    device.streams.add(res);
    if (!wasOnline) this.emit('change');
    res.on('close', () => {
      device.streams.delete(res);
      device.lastSeen = Date.now();
      if (device.streams.size === 0) this.emit('change');
    });
  }

  /** Send an event to every open stream of one device. */
  send(deviceId, event, data) {
    const d = this.devices.get(deviceId);
    if (!d) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of d.streams) res.write(frame);
  }

  /** Send an event to every connected device. */
  broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const d of this.devices.values()) for (const res of d.streams) res.write(frame);
  }

  /** Public view of all known devices. */
  list() {
    const out = [];
    for (const d of this.devices.values()) {
      out.push({
        id: d.id,
        name: d.name,
        kind: d.kind,
        host: d.host,
        online: d.streams.size > 0,
        // Only meaningful while away; kept null when online so the list is stable to diff.
        lastSeen: d.streams.size > 0 ? null : d.lastSeen,
      });
    }
    return out;
  }

  _heartbeat() {
    const now = Date.now();
    let changed = false;
    for (const [id, d] of this.devices) {
      for (const res of d.streams) res.write(': ping\n\n');
      if (d.streams.size === 0 && now - d.lastSeen > FORGET_AFTER_MS) {
        this.devices.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }

  close() {
    clearInterval(this.heartbeat);
    for (const d of this.devices.values()) for (const res of d.streams) res.end();
  }
}

module.exports = { DeviceRegistry };
