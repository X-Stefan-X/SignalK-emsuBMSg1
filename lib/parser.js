'use strict';

const { calcCrc8 } = require('./connection');

/**
 * EmusBmsParser
 *
 * Parses EMUS G1 serial protocol sentences and converts them to
 * SignalK delta objects under the path:
 *   electrical.batteries.<instance>.*
 *
 * Supported sentences:
 *   ST1  – BMS Status (SOC, protection flags, charging stage)
 *   CV1  – Current and Voltage (total voltage, current)
 *   BV1  – Battery Voltage Summary (min/max/avg/total cell voltage)
 *   BC1  – Battery Charge (charge, capacity, SOC%)
 *   BT1  – Cell Module Temperature Summary (min/max/avg temp)
 *   CS1  – Charger Status (charger voltage/current)
 *   BB1  – Balancing Rate Summary
 */
class EmusBmsParser {
  constructor(instanceName, debugFn) {
    this.instance = instanceName || 'house';
    this.debug = debugFn || null;
    this._basePath = `electrical.batteries.${this.instance}`;
  }

  /**
   * Parse one sentence line. Returns array of SignalK delta objects or [].
   */
  parse(line) {
    if (!line || line.length < 4) return [];

    // Validate CRC: last two chars are CRC hex, rest is data
    const lastComma = line.lastIndexOf(',');
    if (lastComma < 0) return [];
    const body = line.substring(0, lastComma + 1); // includes trailing comma
    const crcStr = line.substring(lastComma + 1);
    const expectedCrc = calcCrc8(body);
    const receivedCrc = parseInt(crcStr, 16);

    if (isNaN(receivedCrc) || expectedCrc !== receivedCrc) {
      if (this.debug) this.debug(`CRC mismatch on: ${line} (expected ${expectedCrc.toString(16)}, got ${crcStr})`);
      return [];
    }

    // Remove the trailing comma from body, then split on commas
    const fields = body.slice(0, -1).split(',');
    const sentenceName = fields[0];

    switch (sentenceName) {
      case 'ST1': return this._parseST1(fields);
      case 'CV1': return this._parseCV1(fields);
      case 'BV1': return this._parseBV1(fields);
      case 'BC1': return this._parseBC1(fields);
      case 'BT1': return this._parseBT1(fields);
      case 'CS1': return this._parseCS1(fields);
      case 'BB1': return this._parseBB1(fields);
      default:
        if (this.debug) this.debug(`Unhandled sentence: ${sentenceName}`);
        return [];
    }
  }

  // -----------------------------------------------------------------------
  // ST1 – BMS Status Sentence
  // Fields: name, chargingStage, lastError, chargeProc, totalCharge,
  //         protectionFlags, powerReductionFlags, warnFlags, pinStatus
  // -----------------------------------------------------------------------
  _parseST1(fields) {
    if (fields.length < 9) return [];

    const chargingStage = parseInt(fields[1], 16);
    const lastChargingError = parseInt(fields[2], 16);
    const protectionFlags = parseInt(fields[5], 16);
    const powerReductionFlags = parseInt(fields[6], 16);
    const warningFlags = parseInt(fields[7], 16);

    const CHARGING_STAGES = [
      'Charger Disconnected', 'Pre-Heating', 'Pre-Charging',
      'Main Charging', 'Balancing', 'Charging Finished', 'Charging Error'
    ];

    const values = [
      {
        path: `${this._basePath}.chargingMode`,
        value: CHARGING_STAGES[chargingStage] || `Unknown (${chargingStage})`
      },
      {
        path: `${this._basePath}.chargingStageCode`,
        value: chargingStage
      },
      {
        path: `${this._basePath}.lastChargingError`,
        value: lastChargingError
      },
      {
        path: `${this._basePath}.protectionFlags`,
        value: protectionFlags
      },
      {
        path: `${this._basePath}.powerReductionFlags`,
        value: powerReductionFlags
      },
      {
        path: `${this._basePath}.warningFlags`,
        value: warningFlags
      },
      // Individual protection bits (most safety-relevant)
      {
        path: `${this._basePath}.protections.cellOverVoltage`,
        value: !!(protectionFlags & (1 << 0))
      },
      {
        path: `${this._basePath}.protections.cellUnderVoltage`,
        value: !!(protectionFlags & (1 << 1))
      },
      {
        path: `${this._basePath}.protections.dischargeOverCurrent`,
        value: !!(protectionFlags & (1 << 2))
      },
      {
        path: `${this._basePath}.protections.overTemperature`,
        value: !!(protectionFlags & (1 << 3))
      },
      {
        path: `${this._basePath}.protections.leakageFault`,
        value: !!(protectionFlags & (1 << 4))
      },
      {
        path: `${this._basePath}.protections.chargeOverCurrent`,
        value: !!(protectionFlags & (1 << 15))
      }
    ];

    return [this._makeDelta(values)];
  }

  // -----------------------------------------------------------------------
  // CV1 – Current and Voltage Sentence
  // Fields: name, totalVoltage(0.01V), current(0.1A signed), ...reserved
  // -----------------------------------------------------------------------
  _parseCV1(fields) {
    if (fields.length < 3) return [];

    const totalVoltage = parseInt(fields[1], 16) * 0.01;       // V
    const currentRaw = parseSignedHex(fields[2], 4);
    const current = currentRaw * 0.1;                           // A (+charge, -discharge)

    const values = [
      { path: `${this._basePath}.voltage`, value: totalVoltage },
      { path: `${this._basePath}.current`, value: current }
    ];

    // Power in Watts
    if (!isNaN(totalVoltage) && !isNaN(current)) {
      values.push({ path: `${this._basePath}.power`, value: totalVoltage * current });
    }

    return [this._makeDelta(values)];
  }

  // -----------------------------------------------------------------------
  // BV1 – Battery Voltage Summary Sentence
  // Fields: name, numCells, minCellV, maxCellV, avgCellV, totalV, (empty)
  // Encoding: offset 200, multiplier 0.01 → result V
  // -----------------------------------------------------------------------
  _parseBV1(fields) {
    if (fields.length < 6) return [];

    const numCells  = parseInt(fields[1], 16);
    const minCellV  = (parseInt(fields[2], 16) + 200) * 0.01;  // V
    const maxCellV  = (parseInt(fields[3], 16) + 200) * 0.01;  // V
    const avgCellV  = (parseInt(fields[4], 16) + 200) * 0.01;  // V
    const totalV    = parseInt(fields[5], 16) * 0.01;           // V

    const values = [
      { path: `${this._basePath}.cells.count`,          value: numCells  },
      { path: `${this._basePath}.cells.voltageMin`,     value: minCellV  },
      { path: `${this._basePath}.cells.voltageMax`,     value: maxCellV  },
      { path: `${this._basePath}.cells.voltageAverage`, value: avgCellV  },
      { path: `${this._basePath}.voltage`,              value: totalV    }
    ];

    return [this._makeDelta(values)];
  }

  // -----------------------------------------------------------------------
  // BC1 – Battery Charge Sentence
  // Fields: name, batteryCharge(C), batteryCapacity(C), SOC(%)
  // 1 Ah = 3600 C
  // -----------------------------------------------------------------------
  _parseBC1(fields) {
    if (fields.length < 4) return [];

    const chargeC    = parseInt(fields[1], 16);   // Coulombs
    const capacityC  = parseInt(fields[2], 16);   // Coulombs
    const socPercent = parseInt(fields[3], 16);   // %

    const chargeAh   = chargeC   / 3600;
    const capacityAh = capacityC / 3600;

    const values = [
      { path: `${this._basePath}.capacity.stateOfCharge`,    value: socPercent / 100 }, // ratio 0-1
      { path: `${this._basePath}.capacity.remaining`,        value: chargeAh   },       // Ah
      { path: `${this._basePath}.capacity.nominal`,          value: capacityAh },       // Ah
      { path: `${this._basePath}.capacity.remainingCoulombs`,value: chargeC    },
      { path: `${this._basePath}.capacity.nominalCoulombs`,  value: capacityC  }
    ];

    return [this._makeDelta(values)];
  }

  // -----------------------------------------------------------------------
  // BT1 – Battery Cell Module Temperature Summary
  // Fields: name, numModules, minTemp(°C), maxTemp(°C), avgTemp(°C)
  // Encoding: HexDec signed, offset 0, multiplier 1 → °C
  // -----------------------------------------------------------------------
  _parseBT1(fields) {
    if (fields.length < 5) return [];

    const numModules = parseInt(fields[1], 16);
    const minTemp    = parseSignedHex(fields[2], 2);  // °C
    const maxTemp    = parseSignedHex(fields[3], 2);  // °C
    const avgTemp    = parseSignedHex(fields[4], 2);  // °C

    const toK = (c) => c + 273.15;  // SignalK uses Kelvin

    const values = [
      { path: `${this._basePath}.cells.moduleCount`,  value: numModules     },
      { path: `${this._basePath}.temperature.min`,    value: toK(minTemp)   },
      { path: `${this._basePath}.temperature.max`,    value: toK(maxTemp)   },
      { path: `${this._basePath}.temperature.average`,value: toK(avgTemp)   }
    ];

    return [this._makeDelta(values)];
  }

  // -----------------------------------------------------------------------
  // CS1 – Charger Status Sentence
  // Fields: name, numChargers, canChargerStatus, setVoltage(0.1V),
  //         setCurrent(0.1A), actualVoltage(0.1V), actualCurrent(0.1A), soc(%)
  // -----------------------------------------------------------------------
  _parseCS1(fields) {
    if (fields.length < 2) return [];

    const numChargers = parseInt(fields[1], 16);
    const values = [
      { path: `${this._basePath}.charger.connectedChargers`, value: numChargers }
    ];

    if (fields[3]) {
      values.push({ path: `${this._basePath}.charger.setVoltage`,    value: parseInt(fields[3], 16) * 0.1 });
    }
    if (fields[4]) {
      values.push({ path: `${this._basePath}.charger.setCurrent`,    value: parseInt(fields[4], 16) * 0.1 });
    }
    if (fields[5]) {
      values.push({ path: `${this._basePath}.charger.actualVoltage`, value: parseInt(fields[5], 16) * 0.1 });
    }
    if (fields[6]) {
      values.push({ path: `${this._basePath}.charger.actualCurrent`, value: parseInt(fields[6], 16) * 0.1 });
    }

    return [this._makeDelta(values)];
  }

  // -----------------------------------------------------------------------
  // BB1 – Balancing Rate Summary
  // Fields: name, numCells, maxBalRate, avgBalRate, ...
  // -----------------------------------------------------------------------
  _parseBB1(fields) {
    if (fields.length < 4) return [];

    const numCells   = parseInt(fields[1], 16);
    const maxBalRate = parseInt(fields[2], 16);  // 0-255 → 0-100%
    const avgBalRate = parseInt(fields[3], 16);

    const values = [
      { path: `${this._basePath}.balancing.cellCount`,  value: numCells               },
      { path: `${this._basePath}.balancing.maxRate`,    value: maxBalRate * 100 / 255 },
      { path: `${this._basePath}.balancing.averageRate`,value: avgBalRate * 100 / 255 }
    ];

    return [this._makeDelta(values)];
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  _makeDelta(values) {
    return {
      context: 'vessels.self',
      updates: [
        {
          source: { label: 'emus-bms-g1', type: 'plugin' },
          timestamp: new Date().toISOString(),
          values
        }
      ]
    };
  }
}

/**
 * Parse a signed hex integer.
 * @param {string} hex   Hex string (e.g. '8001')
 * @param {number} bytes Number of bytes (2 = 16-bit, 4 = 32-bit)
 */
function parseSignedHex(hex, bytes) {
  const val = parseInt(hex, 16);
  const maxPositive = Math.pow(2, bytes * 8 - 1);
  const maxVal = Math.pow(2, bytes * 8);
  if (val >= maxPositive) return val - maxVal;
  return val;
}

module.exports = EmusBmsParser;
