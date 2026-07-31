# Light Sensor

A browser-based ambient light monitor for an Adafruit Feather ESP32-S3 and a
BH1750 sensor. The dashboard uses Web Serial to load a MicroPython program onto
the board, then graphs the resulting lux readings in real time.

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

The page enters the MicroPython raw REPL, runs the bundled BH1750 program, and
starts charting readings locally. No sensor data leaves the browser.

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
