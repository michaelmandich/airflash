'use strict';

const os = require('node:os');

// Adapters that are almost never the network your phone is on.
const VIRTUAL_IFACE = /(vethernet|wsl|hyper-v|virtualbox|vmware|vbox|docker|loopback|npcap|zerotier|tailscale|utun|bridge|awdl|llw)/i;

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * LAN IPv4 addresses, best guess first. Real Wi-Fi/Ethernet adapters with
 * private addresses rank above virtual adapters (WSL, Hyper-V, VPNs...).
 */
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      let score = 0;
      if (isPrivateV4(a.address)) score += 10;
      if (a.address.startsWith('192.168.')) score += 2;
      if (/(wi-?fi|wlan|wireless|ethernet|^en\d|^eth\d)/i.test(name)) score += 5;
      if (VIRTUAL_IFACE.test(name)) score -= 20;
      out.push({ address: a.address, iface: name, score });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

module.exports = { lanAddresses, isPrivateV4 };
