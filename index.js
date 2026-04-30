'use strict';

const EmusBmsParser     = require('./lib/parser');
const EmusBleConnection = require('./lib/connection');

module.exports = function (app) {
  let plugin = {};
  let connection = null;
  let unsubscribes = [];

  plugin.id          = 'signalk-emus-bms-g1';
  plugin.name        = 'EMUS BMS G1 (Bluetooth BLE – SCM031B)';
  plugin.description =
    'SignalK plugin für das EMUS G1 BMS via BLE Smartphone Connectivity Module SCM031B ' +
    '(Nordic UART Service / BT 4.0 LE)';

  plugin.schema = {
    type: 'object',
    properties: {
      deviceAddress: {
        type: 'string',
        title: 'BLE MAC-Adresse (empfohlen)',
        description:
          'MAC-Adresse des SCM031B-Moduls, z.B. AA:BB:CC:DD:EE:FF. ' +
          'Leer lassen für automatische Suche nach EMUS-Geräten.',
        default: ''
      },
      deviceName: {
        type: 'string',
        title: 'BLE Gerätename (alternativ)',
        description:
          'Teilstring des BLE-Namens, z.B. "EMUS BMS". ' +
          'Wird nur verwendet wenn keine MAC-Adresse angegeben.',
        default: ''
      },
      instanceName: {
        type: 'string',
        title: 'Battery Instanzname',
        description: 'Verwendung im SignalK-Pfad: electrical.batteries.<instanz>.*',
        default: 'house'
      },

      // ── Polling ────────────────────────────────────────────────────────────
      pollIntervalMs: {
        type: 'integer',
        title: 'Summary-Intervall (ms)',
        description:
          'Wie oft Zusammenfassungs-Daten abgerufen werden: ' +
          'Spannung, Strom, SoC, Temperaturen (ST1, CV1, BV1, BC1, BT1, BT3, CS1, BB1). ' +
          '0 = kein aktives Polling, nur BMS-Broadcasts.',
        default: 2000,
        minimum: 0
      },
      detailPollIntervalMs: {
        type: 'integer',
        title: 'Einzelzell-Intervall (ms)',
        description:
          'Wie oft Einzelzell-Daten abgerufen werden: ' +
          'Zellspannungen, Zelltemperaturen, Balancing (BV2, BT2, BT4, BB2). ' +
          'Bei 48 Zellen löst jede Anfrage 6 BLE-Antwort-Sentences aus — ' +
          'Wert nicht zu klein wählen. 0 = deaktiviert.',
        default: 10000,
        minimum: 0
      },

      verbose: {
        type: 'boolean',
        title: 'Verbose Logging',
        default: false
      }
    }
  };

  plugin.start = function (options) {
    const opts = Object.assign(
      {
        deviceAddress:        '',
        deviceName:           '',
        instanceName:         'house',
        pollIntervalMs:       2000,
        detailPollIntervalMs: 10000,
        verbose:              false
      },
      options
    );

    app.debug(
      `EMUS BMS G1 Plugin startet. ` +
      `Gerät: ${opts.deviceAddress || opts.deviceName || '(automatisch)'}, ` +
      `Summary: ${opts.pollIntervalMs}ms, ` +
      `Einzelzellen: ${opts.detailPollIntervalMs > 0 ? opts.detailPollIntervalMs + 'ms' : 'deaktiviert'}`
    );

    const parser = new EmusBmsParser(
      opts.instanceName,
      opts.verbose ? (msg) => app.debug(msg) : null
    );

    connection = new EmusBleConnection(opts, app);

    connection.on('sentence', (line) => {
      try {
        const deltas = parser.parse(line);
        if (deltas && deltas.length > 0) {
          deltas.forEach((delta) => app.handleMessage(plugin.id, delta));
        }
      } catch (e) {
        app.debug(`Parse-Fehler: ${e.message} — Sentence: ${line}`);
      }
    });

    connection.on('error', (err) => {
      app.error(`BLE-Fehler: ${err.message}`);
    });

    connection.on('open', () => {
      app.debug('BLE-Verbindung offen, initiale Daten anfordern…');

      // Summary-Sentences sofort beim Verbindungsaufbau
      _pollSummary();

      // Einzelzell-Sentences 1s verzögert (BMS nicht sofort überlasten)
      if (opts.detailPollIntervalMs > 0) {
        setTimeout(() => { if (connection.isOpen()) _pollDetail(); }, 1000);
      }
    });

    connection.on('close', () => {
      app.debug('BLE-Verbindung geschlossen');
    });

    connection.open();

    // ── Summary-Polling Timer ──────────────────────────────────────────────
    if (opts.pollIntervalMs > 0) {
      const summaryTimer = setInterval(() => {
        if (connection.isOpen()) _pollSummary();
      }, opts.pollIntervalMs);
      unsubscribes.push(() => clearInterval(summaryTimer));
    }

    // ── Einzelzell-Polling Timer ───────────────────────────────────────────
    if (opts.detailPollIntervalMs > 0) {
      const detailTimer = setInterval(() => {
        if (connection.isOpen()) _pollDetail();
      }, opts.detailPollIntervalMs);
      unsubscribes.push(() => clearInterval(detailTimer));
    }

    // ── Hilfsfunktionen ────────────────────────────────────────────────────
    function _pollSummary() {
      connection.send('ST1,?');
      connection.send('CV1,?');
      connection.send('BV1,?');
      connection.send('BC1,?');
      connection.send('BT1,?');
      connection.send('BT3,?');
      connection.send('CS1,?');
      connection.send('BB1,?');
    }

    function _pollDetail() {
      // 200ms Abstand zwischen den Detail-Anfragen damit das BMS
      // die 6× BV2-Chunks (48 Zellen) fertig senden kann bevor BT2 kommt
      connection.send('BV2,?');
      setTimeout(() => { if (connection.isOpen()) connection.send('BT2,?'); },  400);
      setTimeout(() => { if (connection.isOpen()) connection.send('BT4,?'); },  800);
      setTimeout(() => { if (connection.isOpen()) connection.send('BB2,?'); }, 1200);
    }
  };

  plugin.stop = function () {
    unsubscribes.forEach((fn) => fn());
    unsubscribes = [];
    if (connection) {
      connection.close();
      connection = null;
    }
    app.debug('EMUS BMS G1 Plugin gestoppt');
  };

  return plugin;
};
