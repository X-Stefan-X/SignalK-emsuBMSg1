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
 *   BV2  – Battery Voltage Detail (individual cell voltages)
 *   BC1  – Battery Charge (charge, capacity, SOC%)
 *   BT1  – Cell Module Temperature Summary (min/max/avg temp)
 *   BT2  – Cell Module Temperature Detail (individual module temps)
 *   BT3  – Cell Temperature Summary (external sensors)
 *   BT4  – Cell Temperature Detail (individual cell temps, external sensors)
 *   BB1  – Balancing Rate Summary
 *   BB2  – Balancing Rate Detail (individual cell balancing rates)
 *   CS1  – Charger Status (charger voltage/current)
 *
 * Detail sentences (BV2, BT2, BT4, BB2) arrive as multiple consecutive
 * responses — one per group of up to 8 cells. The parser accumulates them
 * in internal buffers and emits a single combined delta once all expected
 * cells are received (200ms timeout fallback).
 */
class EmusBmsParser {
  constructor(instanceName, debugFn) {
    this.instance = instanceName || 'house';
    this.debug = debugFn || null;
    this._basePath = `electrical.batteries.${this.instance}`;

    // Buffers for multi-chunk detail sentences
    // key: sentence name → { cells: {cellIndex: value}, timer, totalCells }
    this._detailBuffers = {};

    // Known total cell count (updated from BV1/BT1)
    this._knownCellCount = 0;
  }

  // -------------------------------------------------------------------------
  // Public parse entry point
  // -------------------------------------------------------------------------
  parse(line) {
    if (!line || line.length < 4) return [];

    const lastComma = line.lastIndexOf(',');
    if (lastComma < 0) return [];
    const body    = line.substring(0, lastComma + 1);
    const crcStr  = line.substring(lastComma + 1);
    const expected = calcCrc8(body);
    const received = parseInt(crcStr, 16);

    if (isNaN(received) || expected !== received) {
      if (this.debug) this.debug(`CRC mismatch: ${line} (expected ${expected.toString(16)}, got ${crcStr})`);
      return [];
    }

    const fields = body.slice(0, -1).split(',');
    const name   = fields[0];

    switch (name) {
      case 'ST1': return this._parseST1(fields);
      case 'CV1': return this._parseCV1(fields);
      case 'BV1': return this._parseBV1(fields);
      case 'BV2': return this._parseBV2(fields);
      case 'BC1': return this._parseBC1(fields);
      case 'BT1': return this._parseBT1(fields);
      case 'BT2': return this._parseBT2(fields);
      case 'BT3': return this._parseBT3(fields);
      case 'BT4': return this._parseBT4(fields);
      case 'BB1': return this._parseBB1(fields);
      case 'BB2': return this._parseBB2(fields);
      case 'CS1': return this._parseCS1(fields);
      default:
        if (this.debug) this.debug(`Unhandled sentence: ${name}`);
        return [];
    }
  }

  // -------------------------------------------------------------------------
  // ST1 – BMS Status
  // -------------------------------------------------------------------------
  _parseST1(fields) {
    if (fields.length < 9) return [];

    const chargingStage      = parseInt(fields[1], 16);
    const lastChargingError  = parseInt(fields[2], 16);
    const protectionFlags    = parseInt(fields[5], 16);
    const powerReductionFlags= parseInt(fields[6], 16);
    const warningFlags       = parseInt(fields[7], 16);

    const STAGES = [
      'Charger Disconnected', 'Pre-Heating', 'Pre-Charging',
      'Main Charging', 'Balancing', 'Charging Finished', 'Charging Error'
    ];

    return [this._makeDelta([
      { path: `${this._basePath}.chargingMode`,              value: STAGES[chargingStage] || `Unknown (${chargingStage})` },
      { path: `${this._basePath}.chargingStageCode`,         value: chargingStage        },
      { path: `${this._basePath}.lastChargingError`,         value: lastChargingError    },
      { path: `${this._basePath}.protectionFlags`,           value: protectionFlags      },
      { path: `${this._basePath}.powerReductionFlags`,       value: powerReductionFlags  },
      { path: `${this._basePath}.warningFlags`,              value: warningFlags         },
      { path: `${this._basePath}.protections.cellOverVoltage`,      value: !!(protectionFlags & (1 << 0))  },
      { path: `${this._basePath}.protections.cellUnderVoltage`,     value: !!(protectionFlags & (1 << 1))  },
      { path: `${this._basePath}.protections.dischargeOverCurrent`, value: !!(protectionFlags & (1 << 2))  },
      { path: `${this._basePath}.protections.overTemperature`,      value: !!(protectionFlags & (1 << 3))  },
      { path: `${this._basePath}.protections.leakageFault`,         value: !!(protectionFlags & (1 << 4))  },
      { path: `${this._basePath}.protections.chargeOverCurrent`,    value: !!(protectionFlags & (1 << 15)) },
    ])];
  }

  // -------------------------------------------------------------------------
  // CV1 – Current and Voltage
  // -------------------------------------------------------------------------
  _parseCV1(fields) {
    if (fields.length < 3) return [];
    const voltage = parseInt(fields[1], 16) * 0.01;
    const current = parseSignedHex(fields[2], 4) * 0.1;
    return [this._makeDelta([
      { path: `${this._basePath}.voltage`, value: voltage },
      { path: `${this._basePath}.current`, value: current },
      { path: `${this._basePath}.power`,   value: voltage * current },
    ])];
  }

  // -------------------------------------------------------------------------
  // BV1 – Battery Voltage Summary
  // -------------------------------------------------------------------------
  _parseBV1(fields) {
    if (fields.length < 6) return [];
    const numCells = parseInt(fields[1], 16);
    if (numCells > 0) this._knownCellCount = numCells;

    return [this._makeDelta([
      { path: `${this._basePath}.cells.count`,          value: numCells                                  },
      { path: `${this._basePath}.cells.voltageMin`,     value: (parseInt(fields[2], 16) + 200) * 0.01   },
      { path: `${this._basePath}.cells.voltageMax`,     value: (parseInt(fields[3], 16) + 200) * 0.01   },
      { path: `${this._basePath}.cells.voltageAverage`, value: (parseInt(fields[4], 16) + 200) * 0.01   },
      { path: `${this._basePath}.voltage`,              value:  parseInt(fields[5], 16)          * 0.01  },
    ])];
  }

  // -------------------------------------------------------------------------
  // BV2 – Battery Voltage Detail
  // Fields: name, cellString, firstCellNo, groupSize, hexByteArray
  // Encoding: each byte + offset 200, × 0.01 → V
  // -------------------------------------------------------------------------
  _parseBV2(fields) {
    if (fields.length < 5 || !fields[4]) return [];

    const firstCell = parseInt(fields[2], 16);
    const groupSize = parseInt(fields[3], 16);
    const byteArray = fields[4];

    const voltages = parseHexByteArray(byteArray, groupSize)
      .map(b => (b + 200) * 0.01);  // V

    const delta = this._accumulateDetail('BV2', firstCell, groupSize, voltages, this._knownCellCount);
    return delta ? [delta] : [];
  }

  // -------------------------------------------------------------------------
  // BC1 – Battery Charge
  // -------------------------------------------------------------------------
  _parseBC1(fields) {
    if (fields.length < 4) return [];
    const chargeC   = parseInt(fields[1], 16);
    const capacityC = parseInt(fields[2], 16);
    const soc       = parseInt(fields[3], 16);
    return [this._makeDelta([
      { path: `${this._basePath}.capacity.stateOfCharge`,    value: soc / 100         },
      { path: `${this._basePath}.capacity.remaining`,        value: chargeC   / 3600  },
      { path: `${this._basePath}.capacity.nominal`,          value: capacityC / 3600  },
      { path: `${this._basePath}.capacity.remainingCoulombs`,value: chargeC           },
      { path: `${this._basePath}.capacity.nominalCoulombs`,  value: capacityC         },
    ])];
  }

  // -------------------------------------------------------------------------
  // BT1 – Cell Module Temperature Summary
  // Encoding: HexDec signed °C → convert to Kelvin for SignalK
  // -------------------------------------------------------------------------
  _parseBT1(fields) {
    if (fields.length < 5) return [];
    const numModules = parseInt(fields[1], 16);
    if (numModules > 0) this._knownCellCount = numModules;
    const toK = c => c + 273.15;
    return [this._makeDelta([
      { path: `${this._basePath}.cells.moduleCount`,   value: numModules                          },
      { path: `${this._basePath}.temperature.min`,     value: toK(parseSignedHex(fields[2], 2))  },
      { path: `${this._basePath}.temperature.max`,     value: toK(parseSignedHex(fields[3], 2))  },
      { path: `${this._basePath}.temperature.average`, value: toK(parseSignedHex(fields[4], 2))  },
    ])];
  }

  // -------------------------------------------------------------------------
  // BT2 – Cell Module Temperature Detail
  // Fields: name, cellString, firstCellNo, groupSize, hexByteArray
  // Encoding: each byte − 100 → °C → + 273.15 → K
  // -------------------------------------------------------------------------
  _parseBT2(fields) {
    if (fields.length < 5 || !fields[4]) return [];

    const firstCell = parseInt(fields[2], 16);
    const groupSize = parseInt(fields[3], 16);
    const byteArray = fields[4];

    const temps = parseHexByteArray(byteArray, groupSize)
      .map(b => (b - 100) + 273.15);  // Kelvin

    const delta = this._accumulateDetail('BT2', firstCell, groupSize, temps, this._knownCellCount);
    return delta ? [delta] : [];
  }

  // -------------------------------------------------------------------------
  // BT3 – Cell Temperature Summary (external sensors)
  // Encoding: each byte − 100 → °C (unsigned hex with offset)
  // -------------------------------------------------------------------------
  _parseBT3(fields) {
    if (fields.length < 5) return [];
    const toK = c => c + 273.15;
    const minC = parseInt(fields[2], 16) - 100;
    const maxC = parseInt(fields[3], 16) - 100;
    const avgC = parseInt(fields[4], 16) - 100;
    return [this._makeDelta([
      { path: `${this._basePath}.cellTemperature.min`,     value: toK(minC) },
      { path: `${this._basePath}.cellTemperature.max`,     value: toK(maxC) },
      { path: `${this._basePath}.cellTemperature.average`, value: toK(avgC) },
    ])];
  }

  // -------------------------------------------------------------------------
  // BT4 – Cell Temperature Detail (external sensors per cell)
  // Fields: name, cellString, firstCellNo, groupSize, hexByteArray
  // Encoding: each byte − 100 → °C → + 273.15 → K
  // -------------------------------------------------------------------------
  _parseBT4(fields) {
    if (fields.length < 5 || !fields[4]) return [];

    const firstCell = parseInt(fields[2], 16);
    const groupSize = parseInt(fields[3], 16);
    const byteArray = fields[4];

    const temps = parseHexByteArray(byteArray, groupSize)
      .map(b => (b - 100) + 273.15);  // Kelvin

    const delta = this._accumulateDetail('BT4', firstCell, groupSize, temps, this._knownCellCount);
    return delta ? [delta] : [];
  }

  // -------------------------------------------------------------------------
  // BB1 – Balancing Rate Summary
  // -------------------------------------------------------------------------
  _parseBB1(fields) {
    if (fields.length < 4) return [];
    return [this._makeDelta([
      { path: `${this._basePath}.balancing.cellCount`,   value: parseInt(fields[1], 16)           },
      { path: `${this._basePath}.balancing.maxRate`,     value: parseInt(fields[2], 16) * 100/255 },
      { path: `${this._basePath}.balancing.averageRate`, value: parseInt(fields[3], 16) * 100/255 },
    ])];
  }

  // -------------------------------------------------------------------------
  // BB2 – Balancing Rate Detail
  // Fields: name, cellString, firstCellNo, groupSize, hexByteArray
  // Encoding: each byte × 100/255 → %
  // -------------------------------------------------------------------------
  _parseBB2(fields) {
    if (fields.length < 5 || !fields[4]) return [];

    const firstCell = parseInt(fields[2], 16);
    const groupSize = parseInt(fields[3], 16);
    const byteArray = fields[4];

    const rates = parseHexByteArray(byteArray, groupSize)
      .map(b => b * 100 / 255);  // %

    const delta = this._accumulateDetail('BB2', firstCell, groupSize, rates, this._knownCellCount);
    return delta ? [delta] : [];
  }

  // -------------------------------------------------------------------------
  // CS1 – Charger Status
  // -------------------------------------------------------------------------
  _parseCS1(fields) {
    if (fields.length < 2) return [];
    const values = [
      { path: `${this._basePath}.charger.connectedChargers`, value: parseInt(fields[1], 16) }
    ];
    if (fields[3]) values.push({ path: `${this._basePath}.charger.setVoltage`,    value: parseInt(fields[3], 16) * 0.1 });
    if (fields[4]) values.push({ path: `${this._basePath}.charger.setCurrent`,    value: parseInt(fields[4], 16) * 0.1 });
    if (fields[5]) values.push({ path: `${this._basePath}.charger.actualVoltage`, value: parseInt(fields[5], 16) * 0.1 });
    if (fields[6]) values.push({ path: `${this._basePath}.charger.actualCurrent`, value: parseInt(fields[6], 16) * 0.1 });
    return [this._makeDelta(values)];
  }

  // =========================================================================
  // Multi-chunk detail sentence accumulator
  // =========================================================================

  /**
   * Accumulate one group of a detail sentence.
   * Returns a complete SignalK delta when all cells received, else null.
   */
  _accumulateDetail(sentenceName, firstCell, groupSize, vals, totalCells) {
    if (!this._detailBuffers[sentenceName]) {
      this._detailBuffers[sentenceName] = { cells: {}, timer: null, totalCells: 0 };
    }
    const buf = this._detailBuffers[sentenceName];

    // Store decoded values by absolute cell index
    vals.forEach((v, i) => { buf.cells[firstCell + i] = v; });
    if (totalCells > 0) buf.totalCells = totalCells;

    // Reset 200ms flush timeout
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      if (this.debug) this.debug(`${sentenceName}: timeout flush (${Object.keys(buf.cells).length} cells)`);
      delete this._detailBuffers[sentenceName];
    }, 200);

    // Emit delta immediately when all cells have arrived
    const received = Object.keys(buf.cells).length;
    if (buf.totalCells > 0 && received >= buf.totalCells) {
      return this._flushDetail(sentenceName);
    }
    return null;
  }

  _flushDetail(sentenceName) {
    const buf = this._detailBuffers[sentenceName];
    if (!buf) return null;

    if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }

    const sortedKeys = Object.keys(buf.cells).map(Number).sort((a, b) => a - b);
    const values = sortedKeys.map(idx => {
      let pathSuffix;
      switch (sentenceName) {
        case 'BV2': pathSuffix = 'voltage';             break;
        case 'BT2': pathSuffix = 'moduleTemperature';  break;
        case 'BT4': pathSuffix = 'temperature';        break;
        case 'BB2': pathSuffix = 'balancingRate';      break;
        default:    pathSuffix = 'value';
      }
      return {
        path:  `${this._basePath}.cells.${idx}.${pathSuffix}`,
        value: buf.cells[idx]
      };
    });

    delete this._detailBuffers[sentenceName];
    return values.length > 0 ? this._makeDelta(values) : null;
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  _makeDelta(values) {
    return {
      context: 'vessels.self',
      updates: [{
        source:    { label: 'emus-bms-g1', type: 'plugin' },
        timestamp: new Date().toISOString(),
        values
      }]
    };
  }
}

// ─── HexDecByteArray decoder ──────────────────────────────────────────────────
// The hex string encodes N bytes as 2N hex characters.
// e.g. "8B8587" → [0x8B, 0x85, 0x87]
function parseHexByteArray(hexStr, expectedCount) {
  const result = [];
  for (let i = 0; i < hexStr.length - 1 && result.length < expectedCount; i += 2) {
    result.push(parseInt(hexStr.slice(i, i + 2), 16));
  }
  return result;
}

// ─── Signed hex integer ───────────────────────────────────────────────────────
function parseSignedHex(hex, bytes) {
  const val = parseInt(hex, 16);
  const threshold = Math.pow(2, bytes * 8 - 1);
  const max       = Math.pow(2, bytes * 8);
  return val >= threshold ? val - max : val;
}

module.exports = EmusBmsParser;
