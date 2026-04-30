'use strict';

const EventEmitter = require('events');

// ─── Nordic UART Service (NUS) UUIDs ──────────────────────────────────────────
// Das SCM031B-Modul von EMUS basiert auf einem Nordic Semiconductor BLE-Chip.
// Es implementiert den Standard Nordic UART Service (NUS):
//   Service:     6E400001-B5A3-F393-E0A9-E50E24DCCA9E
//   TX (notify): 6E400003-B5A3-F393-E0A9-E50E24DCCA9E  ← BMS → SignalK
//   RX (write):  6E400002-B5A3-F393-E0A9-E50E24DCCA9E  ← SignalK → BMS
// ─────────────────────────────────────────────────────────────────────────────
const NUS_SERVICE_UUID = '6e400001b5a3f393e0a9e50e24dcca9e';
const NUS_TX_CHAR_UUID = '6e400003b5a3f393e0a9e50e24dcca9e'; // notify (BMS sendet)
const NUS_RX_CHAR_UUID = '6e400002b5a3f393e0a9e50e24dcca9e'; // write  (wir senden)

/**
 * EmusBleConnection
 *
 * Verbindet sich per BLE mit dem EMUS G1 SCM031B-Modul (Nordic UART Service).
 *
 * Emits:
 *   'open'      – BLE-Verbindung aufgebaut, Notifications aktiviert
 *   'sentence'  – string: eine vollständige EMUS-Sentence-Zeile
 *   'error'     – Error-Objekt
 *   'close'     – Verbindung getrennt
 */
class EmusBleConnection extends EventEmitter {
  constructor(opts, app) {
    super();
    this.opts = opts;
    this.app = app;

    this._noble = null;
    this._peripheral = null;
    this._rxCharacteristic = null;
    this._lineBuffer = '';
    this._reconnectTimer = null;
    this._scanning = false;
    this._closed = false;
  }

  open() {
    this._closed = false;

    try {
      this._noble = require('@abandonware/noble');
    } catch (e) {
      this.emit('error', new Error(
        'BLE-Bibliothek (@abandonware/noble) nicht gefunden. ' +
        'Bitte "npm install @abandonware/noble" im Plugin-Verzeichnis ausführen.'
      ));
      return;
    }

    this._noble.on('stateChange', (state) => {
      this.app.debug(`BLE state: ${state}`);
      if (state === 'poweredOn') {
        this._startScan();
      } else {
        this._stopScan();
        if (state === 'poweredOff') {
          this.emit('error', new Error('Bluetooth ist ausgeschaltet.'));
        }
      }
    });

    this._noble.on('discover', (peripheral) => this._onDiscover(peripheral));

    if (this._noble.state === 'poweredOn') {
      this._startScan();
    }
  }

  _startScan() {
    if (this._scanning || this._closed) return;
    this._scanning = true;

    const targetName = this.opts.deviceName;
    const targetMac  = this.opts.deviceAddress
      ? this.opts.deviceAddress.toLowerCase().replace(/[:-]/g, '')
      : null;

    this.app.debug(
      `BLE-Scan gestartet. Suche: ${targetName || targetMac || 'EMUS/BMS (automatisch)'}`
    );

    // Scan auf NUS-Service-UUID beschränken (effizient, filtert Fremdgeräte)
    this._noble.startScanning([NUS_SERVICE_UUID], false, (err) => {
      if (err) {
        this.app.debug('UUID-gefilterter Scan fehlgeschlagen, breiter Scan...');
        this._noble.startScanning([], false);
      }
    });
  }

  _stopScan() {
    if (!this._scanning) return;
    this._scanning = false;
    try { this._noble.stopScanning(); } catch (_) {}
  }

  _onDiscover(peripheral) {
    if (this._closed) return;

    const name    = peripheral.advertisement.localName || '';
    const address = peripheral.address.replace(/[:-]/g, '').toLowerCase();

    this.app.debug(`BLE gefunden: "${name}" [${peripheral.address}]`);

    const targetMac  = this.opts.deviceAddress
      ? this.opts.deviceAddress.toLowerCase().replace(/[:-]/g, '')
      : null;
    const targetName = (this.opts.deviceName || '').toLowerCase();

    const matchByMac  = targetMac  && address === targetMac;
    const matchByName = !targetMac && targetName &&
                        name.toLowerCase().includes(targetName);
    // Automatisches Matching: EMUS benennt das Modul typisch als "EMUS BMS" o.ä.
    const matchAuto   = !targetMac && !targetName && (
      name.toLowerCase().startsWith('emus') ||
      name.toUpperCase().startsWith('BMS') ||
      name.toLowerCase().includes('scm')
    );

    if (!matchByMac && !matchByName && !matchAuto) return;

    this.app.debug(`EMUS SCM031B identifiziert: "${name}" [${peripheral.address}]`);
    this._stopScan();
    this._connect(peripheral);
  }

  _connect(peripheral) {
    this._peripheral = peripheral;

    peripheral.on('disconnect', () => {
      this.app.debug('BLE getrennt');
      this._rxCharacteristic = null;
      this._lineBuffer = '';
      this.emit('close');
      this._scheduleReconnect();
    });

    peripheral.connect((err) => {
      if (err) {
        this.emit('error', err);
        this._scheduleReconnect();
        return;
      }

      this.app.debug('BLE verbunden, suche NUS-Service…');

      peripheral.discoverSomeServicesAndCharacteristics(
        [NUS_SERVICE_UUID],
        [NUS_TX_CHAR_UUID, NUS_RX_CHAR_UUID],
        (err, _services, characteristics) => {
          if (err || !characteristics || characteristics.length === 0) {
            this.emit('error', new Error(
              `NUS-Service nicht gefunden auf "${name}". ` +
              'Ist das SCM031B-Modul korrekt am BMS angeschlossen?'
            ));
            peripheral.disconnect();
            return;
          }

          let txChar = null;
          let rxChar = null;

          characteristics.forEach((c) => {
            const uuid = c.uuid.replace(/-/g, '').toLowerCase();
            if (uuid === NUS_TX_CHAR_UUID) txChar = c;
            if (uuid === NUS_RX_CHAR_UUID) rxChar = c;
          });

          if (!txChar) {
            this.emit('error', new Error('NUS TX-Charakteristik nicht gefunden.'));
            peripheral.disconnect();
            return;
          }

          this._rxCharacteristic = rxChar;

          // Notifications auf TX aktivieren (BMS → uns)
          txChar.subscribe((err) => {
            if (err) {
              this.emit('error', new Error(`Notification-Subscribe fehlgeschlagen: ${err}`));
              peripheral.disconnect();
              return;
            }
            this.app.debug('NUS TX-Notifications aktiv — Verbindung bereit.');
            this.emit('open');
          });

          // Datenempfang
          txChar.on('data', (data) => this._onData(data));
        }
      );
    });
  }

  /**
   * BLE-Daten puffern und bei CR/LF als vollständige Sentence ausgeben.
   * BLE MTU ist begrenzt (Standard 20 Bytes), Zeilen können fragmentiert kommen.
   */
  _onData(data) {
    this._lineBuffer += data.toString('ascii');

    let idx;
    while ((idx = this._lineBuffer.search(/[\r\n]/)) !== -1) {
      const line = this._lineBuffer.slice(0, idx).trim();
      this._lineBuffer = this._lineBuffer.slice(idx + 1).replace(/^[\r\n]+/, '');
      if (line.length > 0) {
        this.emit('sentence', line);
      }
    }
  }

  /**
   * Sentence an das BMS senden. CRC wird automatisch berechnet.
   * Lange Nachrichten werden in 20-Byte-BLE-Chunks aufgeteilt.
   * @param {string} sentenceBody  z.B. 'ST1,?'
   */
  send(sentenceBody) {
    if (!this._rxCharacteristic) return;
    const body = sentenceBody + ',';
    const crc  = calcCrc8(body).toString(16).toUpperCase().padStart(2, '0');
    const line = `${sentenceBody},${crc}\r\n`;
    this._writeChunked(Buffer.from(line, 'ascii'));
  }

  _writeChunked(buf, offset = 0) {
    if (!this._rxCharacteristic || offset >= buf.length) return;
    const chunk = buf.slice(offset, offset + 20);
    this._rxCharacteristic.write(chunk, true, (err) => {
      if (err) {
        this.app.debug(`BLE write Fehler: ${err}`);
        return;
      }
      if (offset + 20 < buf.length) {
        // Kurze Pause zwischen Chunks (BLE-Stack entlasten)
        setTimeout(() => this._writeChunked(buf, offset + 20), 10);
      }
    });
  }

  isOpen() {
    return !!(
      this._peripheral &&
      this._peripheral.state === 'connected' &&
      this._rxCharacteristic
    );
  }

  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    const delay = 8000;
    this.app.debug(`BLE-Wiederverbindung in ${delay / 1000}s…`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closed) this._startScan();
    }, delay);
  }

  close() {
    this._closed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopScan();
    if (this._peripheral && this._peripheral.state === 'connected') {
      this._peripheral.disconnect();
    }
    if (this._noble) {
      try { this._noble.removeAllListeners(); } catch (_) {}
    }
  }
}

// ─── CRC-8 (X^8+X^5+X^4+1, Poly 0x18, Init 0x00) ────────────────────────────
// Gemäß EMUS G1 BMS Serial Protocol v2.1.4
function calcCrc8(str) {
  const CRC8POLY = 0x18;
  let crc = 0x00;
  for (let i = 0; i < str.length; i++) {
    let data = str.charCodeAt(i);
    for (let bit = 0; bit < 8; bit++) {
      const fb = (crc ^ data) & 0x01;
      if (fb) crc ^= CRC8POLY;
      crc = (crc >> 1) & 0x7f;
      if (fb) crc |= 0x80;
      data >>= 1;
    }
  }
  return crc;
}

module.exports = EmusBleConnection;
module.exports.calcCrc8 = calcCrc8;
module.exports.NUS_SERVICE_UUID = NUS_SERVICE_UUID;
module.exports.NUS_TX_CHAR_UUID = NUS_TX_CHAR_UUID;
module.exports.NUS_RX_CHAR_UUID = NUS_RX_CHAR_UUID;
