'use strict';

const EmusBmsParser    = require('./lib/parser');
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
      pollIntervalMs: {
        type: 'integer',
        title: 'Polling-Intervall (ms)',
        description:
          'Wie oft aktiv Daten vom BMS angefordert werden. ' +
          '0 = nur auf periodische BMS-Broadcasts warten.',
        default: 2000,
        minimum: 0
      },
      instanceName: {
        type: 'string',
        title: 'Battery Instanzname',
        description: 'Verwendung im SignalK-Pfad: electrical.batteries.<instanz>.*',
        default: 'house'
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
        deviceAddress: '',
        deviceName: '',
        pollIntervalMs: 2000,
        instanceName: 'house',
        verbose: false
      },
      options
    );

    app.debug(
      `EMUS BMS G1 Plugin startet. ` +
      `Gerät: ${opts.deviceAddress || opts.deviceName || '(automatisch)'}`
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
      // Initialen Datensatz anfordern
      connection.send('ST1,?');
      connection.send('CV1,?');
      connection.send('BV1,?');
      connection.send('BC1,?');
      connection.send('BT1,?');
      connection.send('CS1,?');
      connection.send('BB1,?');
    });

    connection.on('close', () => {
      app.debug('BLE-Verbindung geschlossen');
    });

    connection.open();

    // Periodisches Polling
    if (opts.pollIntervalMs > 0) {
      const pollTimer = setInterval(() => {
        if (connection.isOpen()) {
          connection.send('ST1,?');
          connection.send('CV1,?');
          connection.send('BV1,?');
          connection.send('BC1,?');
          connection.send('BT1,?');
        }
      }, opts.pollIntervalMs);

      unsubscribes.push(() => clearInterval(pollTimer));
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
