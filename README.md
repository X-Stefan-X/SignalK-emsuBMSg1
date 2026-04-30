# SignalK Plugin: EMUS G1 BMS via BLE (SCM031B)

**Plugin ID:** `signalk-emus-bms-g1`  
**Version:** 2.1.0  
**Modul:** EMUS G1 Smartphone Connectivity Module SCM031B  
**Protokoll:** Bluetooth 4.0 LE · Nordic UART Service (NUS) · EMUS Serial Protocol v2.1.4
**Sentences:** ST1, CV1, BV1, **BV2**, BC1, BT1, **BT2**, **BT3**, **BT4**, BB1, **BB2**, CS1

---

## Inhaltsverzeichnis

1. [Machbarkeitsanalyse](#machbarkeitsanalyse)
2. [Architektur-Übersicht](#architektur-übersicht)
3. [Voraussetzungen](#voraussetzungen)
4. [BLE-Einrichtung auf dem SignalK-Host](#ble-einrichtung-auf-dem-signalk-host)
5. [Installation](#installation)
6. [Update](#update)
7. [Konfiguration](#konfiguration)
8. [Unterstützte Sentences](#unterstützte-sentences)
9. [SignalK-Datenpfade](#signalk-datenpfade)
10. [CRC-Prüfung](#crc-prüfung)
11. [Dateistruktur](#dateistruktur)
12. [Bekannte Einschränkungen](#bekannte-einschränkungen)

---

## Machbarkeitsanalyse

### Das SCM031B-Modul

Das EMUS G1 Smartphone Connectivity Module **SCM031B** ist das offizielle BLE-Zubehör
für das EMUS G1 BMS. Es verbindet sich über RS232 mit dem Control Unit (Pins DISP.TX /
DISP.RX) und exponiert die Daten drahtlos über **Bluetooth 4.0 Low Energy**.

| Eigenschaft | Wert |
|---|---|
| BT-Protokoll | Bluetooth 4.0 LE |
| Reichweite | 10 m |
| Versorgungsspannung | 9–32 V DC |
| BMS-Anschluss | RS232 (DISP.TX / DISP.RX / GND / PWR) |
| Betriebstemperatur | −40°C bis +85°C |

### Warum BLE ≠ klassisches Bluetooth (SPP)

Das SCM031B verwendet **Bluetooth Low Energy (BT 4.0)**, nicht das klassische
Serial Port Profile (SPP/RFCOMM). Das bedeutet:

- ❌ Kein `/dev/rfcomm0` — das Gerät erscheint **nicht** als serieller Port
- ✅ Kommunikation läuft über GATT-Charakteristiken
- ✅ Standard: **Nordic UART Service (NUS)** — Quasi-Standard für BLE-Serial-Brücken

### Nordic UART Service (NUS)

Das SCM031B basiert auf einem Nordic Semiconductor BLE-Chip und implementiert den
weit verbreiteten Nordic UART Service, der eine bidirektionale serielle Verbindung
über BLE emuliert:

| GATT-Element | UUID | Richtung |
|---|---|---|
| **NUS Service** | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` | — |
| **TX Characteristic** (Notify) | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` | BMS → SignalK |
| **RX Characteristic** (Write) | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` | SignalK → BMS |

Das Plugin aktiviert **Notifications** auf der TX-Charakteristik und empfängt so die
EMUS-Sentences in Echtzeit. Anfragen (Polling) werden über die RX-Charakteristik
geschrieben.

### BLE MTU und Fragmentierung

BLE überträgt standardmäßig maximal 20 Bytes pro Notification. Da EMUS-Sentences
länger sein können (z.B. CV1 mit ~50 Zeichen), können Zeilen fragmentiert
ankommen. Das Plugin puffert alle Fragmente und gibt erst eine vollständige
Sentence aus, wenn CR oder LF empfangen wurde.

---

## Architektur-Übersicht

```
EMUS G1 Control Unit
  RS232 (DISP.TX/RX)
        │
        ▼
  SCM031B Modul
  (BT 4.0 LE / NUS)
        │  ~10m BLE
        ▼
  SignalK Server (RPi etc.)
  @abandonware/noble
        │
  lib/connection.js
  ├── BLE-Scan (NUS UUID-Filter)
  ├── Peripheral-Matching (MAC / Name)
  ├── GATT-Discovery
  ├── TX Notifications → lineBuffer → 'sentence' event
  ├── RX Write (chunked 20 Byte)
  └── Auto-Reconnect (8s Delay)
        │
  lib/parser.js
  ├── CRC-8 Validierung
  └── Sentences → SignalK Deltas
        │
  index.js
  ├── app.handleMessage()
  └── Polling-Timer
```

---

## Voraussetzungen

- **SignalK Server** ≥ 1.40 (Node.js ≥ 18)
- **Bluetooth 4.0 LE** Hardware auf dem Server-Host (z.B. Raspberry Pi 3/4/5 hat BT eingebaut)
- **EMUS G1 BMS** mit korrekt verdrahtetem SCM031B-Modul
- Linux: `libbluetooth-dev` für die native BLE-Bibliothek

```bash
# Linux Build-Abhängigkeiten
sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev
```

---

## BLE-Einrichtung auf dem SignalK-Host

### Linux (Raspberry Pi / Debian/Ubuntu)

**Kein Pairing erforderlich!** BLE-Geräte mit NUS müssen unter Linux nicht über
`bluetoothctl` gepaired werden. Das Plugin verbindet sich direkt beim Scan.

```bash
# Bluetooth-Status prüfen
sudo systemctl status bluetooth

# BT aktivieren (falls nötig)
sudo systemctl start bluetooth
sudo hciconfig hci0 up

# MAC-Adresse des SCM031B finden (optional, aber empfohlen für stabile Verbindung)
sudo hcitool lescan
# Ausgabe z.B.:
# AA:BB:CC:DD:EE:FF EMUS BMS
```

**Berechtigungen für node/SignalK:**
```bash
# Option A: CAP_NET_RAW setzen (empfohlen)
sudo setcap cap_net_raw+eip $(which node)

# Option B: SignalK als root ausführen (nicht empfohlen)

# Option C: noble-Umgebungsvariable (einige Systeme)
export NOBLE_HCI_DEVICE_ID=0
```

**Systemd-Service für Bluetooth-Stabilität:**
```bash
# Sicherstellen dass bluetoothd läuft
sudo systemctl enable bluetooth
```

### Windows

Windows 10/11 mit BT 4.0 Adapter unterstützt BLE nativ.
`@abandonware/noble` benötigt Visual Studio Build Tools.

---

## Installation

```bash
# Im SignalK-Plugin-Verzeichnis
cd ~/.signalk/node_modules
git clone <repository-url> signalk-emus-bms-g1
cd signalk-emus-bms-g1
npm install

# SignalK-Server neu starten
sudo systemctl restart signalk
```

---

## Update

### Plugin-Code aktualisieren

```bash
cd ~/.signalk/node_modules/signalk-emus-bms-g1

# Aktuelle Version prüfen
git log --oneline -5

# Neueste Version holen
git pull origin main

# Abhängigkeiten aktualisieren (falls package.json geändert)
npm install

# SignalK-Server neu starten
sudo systemctl restart signalk
```

### Version prüfen

```bash
# Installierte Version anzeigen
cat ~/.signalk/node_modules/signalk-emus-bms-g1/package.json | grep version

# Letzte Commits anzeigen
git -C ~/.signalk/node_modules/signalk-emus-bms-g1 log --oneline -10
```

### Rollback auf vorherige Version

```bash
cd ~/.signalk/node_modules/signalk-emus-bms-g1

# Verfügbare Versionen/Tags anzeigen
git tag

# Auf bestimmten Stand zurückgehen (z.B. v2.0.0)
git checkout v2.0.0

# Oder auf letzten stabilen Commit
git log --oneline -10
git checkout <commit-hash>

# Neustart
sudo systemctl restart signalk
```

### Nach dem Update: Tests ausführen

```bash
cd ~/.signalk/node_modules/signalk-emus-bms-g1
node test.js
```

Alle Tests sollten mit `✅ Alle Tests bestanden!` abschließen, bevor der Server
neu gestartet wird.

---

## Konfiguration

Im SignalK-Admin-Panel unter **Server → Plugin Config → EMUS BMS G1 (BLE SCM031B)**:

| Parameter | Standard | Beschreibung |
|---|---|---|
| `deviceAddress` | `''` | BLE MAC-Adresse des SCM031B (z.B. `AA:BB:CC:DD:EE:FF`). **Empfohlen** für stabile Verbindung. |
| `deviceName` | `''` | Alternativer Matching per BLE-Name (z.B. `EMUS BMS`). Nur wenn keine MAC gesetzt. |
| `instanceName` | `house` | Battery-Instanzname im SignalK-Pfad |
| `pollIntervalMs` | `2000` | **Summary-Intervall** in ms: Spannung, Strom, SoC, Temperaturen (ST1, CV1, BV1, BC1, BT1, BT3, CS1, BB1). `0` = deaktiviert. |
| `detailPollIntervalMs` | `10000` | **Einzelzell-Intervall** in ms: Zellspannungen, Zelltemperaturen, Balancing (BV2, BT2, BT4, BB2). Bei 48 Zellen löst jede Anfrage 6 BLE-Sentences aus — Wert nicht zu klein wählen. `0` = deaktiviert. |
| `verbose` | `false` | Ausführliche Debug-Ausgabe im SignalK-Log |

### Empfohlene Werte für 48 Zellen (2 × 24)

```json
{
  "deviceAddress": "AA:BB:CC:DD:EE:FF",
  "instanceName": "house",
  "pollIntervalMs": 2000,
  "detailPollIntervalMs": 10000,
  "verbose": false
}
```

**Erklärung der Standardwerte:**

| Intervall | Wert | Begründung |
|---|---|---|
| Summary | 2 s | Spannung/Strom ändern sich schnell — kurzes Intervall sinnvoll |
| Einzelzellen | 10 s | 48 Zellen = 6 BV2 + 6 BT2 + 6 BT4 + 6 BB2 = bis zu 24 BLE-Sentences pro Abruf. Längeres Intervall schont den BLE-Kanal und reicht für Monitoring völlig aus. |

**Richtwerte je nach Anwendungsfall:**

| Anwendung | `pollIntervalMs` | `detailPollIntervalMs` |
|---|---|---|
| Normalbetrieb | 2000 | 10000 |
| Aktives Laden überwachen | 1000 | 5000 |
| Stromsparend / Ankerliegen | 5000 | 30000 |
| Einzelzellen deaktivieren | 2000 | 0 |

**Automatisches Gerätematching (ohne MAC):**

Falls keine MAC angegeben wird, sucht das Plugin automatisch nach BLE-Geräten, deren
Name mit `emus`, `BMS` oder `scm` beginnt. Das ist praktisch für die Ersteinrichtung,
aber für den produktiven Betrieb sollte die MAC-Adresse konfiguriert werden.

---

## Unterstützte Sentences

### ST1 – BMS Status

Gesamtstatus: Ladephase, Fehler, Schutz- und Warnflags.

| Feld | Bedeutung |
|---|---|
| CHARGING STAGE | 0=Getrennt, 1=Vorheizen, 2=Vorladen, 3=Hauptladen, 4=Balancing, 5=Fertig, 6=Fehler |
| PROTECTION FLAGS | Bitfeld (Bit0=Überspannung, Bit1=Unterspannung, Bit2=Entladestrom, Bit3=Übertemp., Bit4=Leckage, Bit15=Ladestrom) |

---

### CV1 – Spannung & Strom

| Feld | Format | Einheit |
|---|---|---|
| TOTAL VOLTAGE | HexDec × 0.01 | V |
| CURRENT | HexDec signed × 0.1 | A (+Laden, −Entladen) |

---

### BV1 – Zellspannungs-Zusammenfassung

Offset +200, Multiplikator 0.01 → V

| Feld | Bedeutung |
|---|---|
| NUM CELLS | Anzahl Zellen |
| MIN/MAX/AVG CELL VOLTAGE | Zellspannungen |
| TOTAL VOLTAGE | Gesamtspannung |

---

### BV2 – Zellspannungs-Detail *(Einzelzellen)*

Liefert die Spannung jeder einzelnen Zelle. Das BMS antwortet mit mehreren
Sentences à max. 8 Zellen — der Parser sammelt alle Chunks und gibt erst
ein kombiniertes Delta aus, wenn alle Zellen empfangen wurden.

Kodierung: `byte + 200 × 0.01 → V`

---

### BC1 – Ladezustand

| Feld | Format | Einheit |
|---|---|---|
| BATTERY CHARGE | HexDec | Coulombs (÷ 3600 = Ah) |
| BATTERY CAPACITY | HexDec | Coulombs |
| SOC | HexDec | % (0–100) |

---

### BT1 – Zellmodul-Temperaturen (Zusammenfassung)

Signed HexDec → °C, Plugin konvertiert nach Kelvin (SignalK-Standard).

---

### BT2 – Zellmodul-Temperaturen Detail *(Einzelmodule)*

Interne Temperatursensoren auf jedem Zellmodul, Einzelwerte pro Zelle.

Kodierung: `byte − 100 → °C → + 273.15 → K`

---

### BT3 – Zelltemperaturen Zusammenfassung *(externe Sensoren)*

Zusammenfassung der optionalen externen Temperatursensoren direkt an den Zellen.

---

### BT4 – Zelltemperaturen Detail *(externe Sensoren, Einzelzellen)*

Einzelwerte der optionalen externen Temperatursensoren pro Zelle.

Kodierung: `byte − 100 → °C → + 273.15 → K`

---

### CS1 – Ladegerätstatus

Soll- und Ist-Spannung/-Strom des angeschlossenen Ladegeräts.

---

### BB1 – Balancing-Rate (Zusammenfassung)

Maximale und durchschnittliche Balancing-Rate (0–100%).

---

### BB2 – Balancing-Rate Detail *(Einzelzellen)*

Balancing-Rate jeder einzelnen Zelle.

Kodierung: `byte × 100/255 → %`

---

## SignalK-Datenpfade

Alle Pfade unter `electrical.batteries.<instance>.*` (Standard: `house`):

| Pfad | Einheit | Quelle |
|---|---|---|
| `.voltage` | V | CV1 / BV1 |
| `.current` | A | CV1 |
| `.power` | W | berechnet |
| `.capacity.stateOfCharge` | 0–1 | BC1 |
| `.capacity.remaining` | Ah | BC1 |
| `.capacity.nominal` | Ah | BC1 |
| `.chargingMode` | string | ST1 |
| `.chargingStageCode` | integer | ST1 |
| `.protectionFlags` | integer | ST1 |
| `.protections.cellOverVoltage` | bool | ST1 |
| `.protections.cellUnderVoltage` | bool | ST1 |
| `.protections.dischargeOverCurrent` | bool | ST1 |
| `.protections.overTemperature` | bool | ST1 |
| `.protections.leakageFault` | bool | ST1 |
| `.protections.chargeOverCurrent` | bool | ST1 |
| `.cells.count` | integer | BV1 |
| `.cells.voltageMin` | V | BV1 |
| `.cells.voltageMax` | V | BV1 |
| `.cells.voltageAverage` | V | BV1 |
| `.cells.moduleCount` | integer | BT1 |
| `.temperature.min` | K | BT1 |
| `.temperature.max` | K | BT1 |
| `.temperature.average` | K | BT1 |
| `.charger.connectedChargers` | integer | CS1 |
| `.charger.setVoltage` | V | CS1 |
| `.charger.setCurrent` | A | CS1 |
| `.charger.actualVoltage` | V | CS1 |
| `.charger.actualCurrent` | A | CS1 |
| `.balancing.maxRate` | % | BB1 |
| `.balancing.averageRate` | % | BB1 |

---

## CRC-Prüfung

**Algorithmus:** CRC-8, Polynom X⁸+X⁵+X⁴+1 (0x18), Initialwert 0x00  
**Eingabe:** Alle Zeichen vom ersten bis einschließlich des letzten Kommas

```javascript
// Beispiel: 'BC1,000456F0,00057E40,1EDC,' → 0x3C
function calcCrc8(str) { /* siehe lib/connection.js */ }
```

> **Hinweis:** Das ST1-CRC-Beispiel im EMUS-Dokument ist laut Changelog (v2.0.7)
> fehlerhaft. Das BC1-Beispiel (`0x3C`) dient als korrekte Referenz.

---

## Dateistruktur

```
signalk-emus-bms-g1/
├── index.js          Plugin-Einstieg (SignalK API, BLE-Lifecycle, Polling)
├── package.json      NPM-Metadaten (@abandonware/noble Dependency)
├── test.js           Unit-Tests (node test.js) — 8 Tests
├── README.md         Diese Dokumentation
└── lib/
    ├── connection.js  BLE-Verbindung (NUS, Auto-Reconnect, MTU-Fragmentierung)
    └── parser.js      EMUS Serial Protocol Parser → SignalK Deltas
```

---

## Bekannte Einschränkungen

| Einschränkung | Details |
|---|---|
| **Linux-Berechtigungen** | node benötigt `CAP_NET_RAW` für BLE-Zugriff. `sudo setcap cap_net_raw+eip $(which node)` |
| **BLE MTU** | Standard-MTU 20 Bytes/Chunk. Aktivierung BLE Data Length Extension (DLE) auf dem Host verbessert Durchsatz. |
| **Kein iOS** | EMUS App unterstützt iOS, dieses Plugin läuft nur auf dem Server-Host (Linux/macOS/Windows). |
| **BT4 optional** | BT4 liefert Daten nur wenn externe Temperatursensoren an den Zellmodulen verbaut sind. |
| **Kein Schreibzugriff** | Konfigurationsparameter (CF2) werden nicht geschrieben — das Plugin ist read-only. |
| **Raspberry Pi 3** | Integrierter BT-Chip (BCM43438) unterstützt BT 4.1 LE — funktioniert. Pi 4/5 ebenfalls. |

---

## Lizenz

MIT License — Nutzung auf eigene Gefahr. Nicht für sicherheitskritische Steuerung einsetzen.
