# Hole Scan

A browser-based hole-position monitor for an Adafruit Feather ESP32-S3 and a
BH1750 sensor. It graphs live readings, records device timestamps during a
LightBurn line scan, and consolidates repeated row intersections into absolute
hole centers.

## Hardware

- Adafruit Feather ESP32-S3 running MicroPython
- BH1750 ambient light sensor
- USB data cable

Connect the BH1750 through the Feather's STEMMA QT connector, or wire it to the
board's I2C pins:

| BH1750 | Feather ESP32-S3 |
| --- | --- |
| VIN | 3.3V |
| GND | GND |
| SDA | GPIO 3 |
| SCL | GPIO 4 |

The sensor may use either its default `0x23` address or the alternate `0x5c`
address.

## Use the dashboard

1. Flash MicroPython onto the Feather ESP32-S3.
2. Connect the Feather to the computer over USB.
3. Close Thonny or any other application using the board's serial port.
4. Open the dashboard in Chrome or Edge and select **Connect Feather**.
5. Download and open the supplied LightBurn file, then center the copper-clad
   board inside its 110 × 75 mm bounds.
6. Enter the pattern's absolute LightBurn X/Y origin, arm capture, and run Tool
   Layers Only + Contour framing at 10 mm/s.

The page enters the MicroPython raw REPL, runs the bundled BH1750 program, and
starts charting readings locally. No sensor data leaves the browser.

Raw readings and calculated centers can be exported as CSV; centers can also be
exported as JSON. The supplied file contains only a Tool layer and cannot fire
the UV marking laser. Test a same-height copper coupon before creating any UV
fallback layer.

For a standalone board-side program, copy [`device/main.py`](device/main.py) to
the Feather as `main.py`.

## Development

Requires Node.js 22.13 or newer.

```sh
npm install
npm run dev
```

Useful checks:

```sh
npm run lint
npm test
```

`npm test` builds the vinext application and verifies the rendered page.
