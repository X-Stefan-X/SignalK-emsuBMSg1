'use strict';

const assert = require('assert');
const EmusBmsParser = require('./lib/parser');
const { calcCrc8, NUS_SERVICE_UUID, NUS_TX_CHAR_UUID, NUS_RX_CHAR_UUID } = require('./lib/connection');

const parser = new EmusBmsParser('house');

// ─── CRC8 Tests ───────────────────────────────────────────────────────────────

{
  // BC1-Beispiel aus dem EMUS-Protokolldokument: CRC = 0x3C
  const body = 'BC1,000456F0,00057E40,1EDC,';
  const crc = calcCrc8(body);
  assert.strictEqual(crc, 0x3C, `CRC8 erwartet 0x3C, erhalten 0x${crc.toString(16)}`);
  console.log('✓ CRC8 korrekt (BC1-Referenzwert 0x3C)');
}

// ─── NUS UUID Tests ───────────────────────────────────────────────────────────

{
  assert.strictEqual(NUS_SERVICE_UUID, '6e400001b5a3f393e0a9e50e24dcca9e');
  assert.strictEqual(NUS_TX_CHAR_UUID, '6e400003b5a3f393e0a9e50e24dcca9e');
  assert.strictEqual(NUS_RX_CHAR_UUID, '6e400002b5a3f393e0a9e50e24dcca9e');
  console.log('✓ Nordic UART Service UUIDs korrekt');
}

// ─── Parser Tests ─────────────────────────────────────────────────────────────

function makeLine(body) {
  const crc = calcCrc8(body + ',').toString(16).toUpperCase().padStart(2, '0');
  return `${body},${crc}`;
}

{
  // CV1: Spannung 0x15AD = 5549 → 55.49V, Strom 0x0004 → +0.4A
  const line = makeLine('CV1,000015AD,0004,01FF,01FD,01FA,03FC,09DA,66CF,0000,0000');
  const deltas = parser.parse(line);
  assert.ok(deltas.length > 0, 'CV1 soll Deltas liefern');
  const vals = deltas[0].updates[0].values;
  const voltage = vals.find(v => v.path.endsWith('.voltage'));
  assert.strictEqual(voltage.value, 55.49, `CV1 Spannung erwartet 55.49V`);
  const current = vals.find(v => v.path.endsWith('.current'));
  assert.strictEqual(current.value, 0.4, 'CV1 Strom erwartet 0.4A');
  console.log('✓ CV1 Spannung & Strom korrekt');
}

{
  // BC1: SOC 0x4B = 75%
  const line = makeLine('BC1,000456F0,00057E40,4B');
  const deltas = parser.parse(line);
  const soc = deltas[0].updates[0].values.find(v => v.path.endsWith('.stateOfCharge'));
  assert.strictEqual(soc.value, 0x4B / 100, 'BC1 SoC erwartet 0.75');
  console.log('✓ BC1 SoC korrekt (ratio 0–1)');
}

{
  // BT1: Temperaturen in Kelvin
  const line = makeLine('BT1,04,12,19,15');  // 18°C, 25°C, 21°C in hex
  const deltas = parser.parse(line);
  const tempMin = deltas[0].updates[0].values.find(v => v.path.endsWith('.temperature.min'));
  assert.strictEqual(tempMin.value, 0x12 + 273.15, 'BT1 Temperatur in Kelvin');
  console.log('✓ BT1 Temperatur → Kelvin korrekt');
}

{
  // ST1: Schutzflags
  const line = makeLine('ST1,03,00,0000,000128E3,05,0000,00,00040802');
  const deltas = parser.parse(line);
  const vals = deltas[0].updates[0].values;
  const overV  = vals.find(v => v.path.endsWith('.protections.cellOverVoltage'));
  const underV = vals.find(v => v.path.endsWith('.protections.cellUnderVoltage'));
  // Flags = 0x05 = Bit0 + Bit2 → cellOverVoltage=true, cellUnderVoltage=false
  assert.strictEqual(overV.value,  true,  'ST1 cellOverVoltage (Bit0)');
  assert.strictEqual(underV.value, false, 'ST1 cellUnderVoltage (Bit1)');
  const stage = vals.find(v => v.path.endsWith('.chargingMode'));
  assert.strictEqual(stage.value, 'Main Charging', 'ST1 Ladephase 3 = Main Charging');
  console.log('✓ ST1 Schutzflags & Ladephase korrekt');
}

{
  // BLE-Datenfragmentierung simulieren: Sentence in zwei Chunks
  // (Echtes BLE liefert ggf. nur 20 Bytes pro Notification)
  const line = makeLine('CV1,000015AD,0004,01FF,01FD,01FA,03FC,09DA,66CF,0000,0000');
  const chunk1 = line.slice(0, 20);
  const chunk2 = line.slice(20) + '\r\n';

  let lineBuffer = '';
  let received = null;

  function processChunk(data) {
    lineBuffer += data;
    let idx;
    while ((idx = lineBuffer.search(/[\r\n]/)) !== -1) {
      received = lineBuffer.slice(0, idx).trim();
      lineBuffer = lineBuffer.slice(idx + 1).replace(/^[\r\n]+/, '');
    }
  }

  processChunk(chunk1);
  assert.strictEqual(received, null, 'Keine Sentence nach erstem Fragment');
  processChunk(chunk2);
  assert.ok(received, 'Sentence nach zweitem Fragment vorhanden');
  const deltas = parser.parse(received);
  assert.ok(deltas.length > 0, 'Fragmentierte Sentence korrekt zusammengesetzt');
  console.log('✓ BLE-Fragmentierung (20-Byte-Chunks) korrekt behandelt');
}

{
  // CRC-Fehler soll abgelehnt werden
  const deltas = parser.parse('CV1,000015AD,0004,FF');
  assert.strictEqual(deltas.length, 0, 'Fehlerhafte CRC soll keine Deltas liefern');
  console.log('✓ Ungültige CRC korrekt abgewiesen');
}

console.log('\n✅ Alle Tests bestanden!');
