"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Reading = {
  value: number;
  time: number;
};

type SerialPortLike = {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
};

type SerialNavigator = Navigator & {
  serial?: {
    requestPort(options: {
      filters: Array<{ usbVendorId: number }>;
    }): Promise<SerialPortLike>;
  };
};

const MAX_POINTS = 3600;
const WINDOW_MS = 20_000;
const DEFAULT_CHART_MIN_LUX = 0;
const DEFAULT_CHART_MAX_LUX = 1000;
const ESPRESSIF_USB_VENDOR_ID = 0x303a;
const SENSOR_SCRIPT = `from machine import I2C, Pin
from time import sleep_ms

i2c_power = Pin(7, Pin.OUT, value=1)
sleep_ms(10)

i2c = I2C(
    0,
    sda=Pin(3),
    scl=Pin(4),
    freq=400_000,
)

devices = i2c.scan()
address = next(
    (device for device in (0x23, 0x5C) if device in devices),
    None,
)

if address is None:
    raise OSError(
        "BH1750 not found. I2C devices: {}".format(
            [hex(device) for device in devices]
        )
    )

i2c.writeto(address, b"\\x13")
sleep_ms(24)

print("BH1750 detected at", hex(address))

while True:
    data = i2c.readfrom(address, 2)
    raw_value = (data[0] << 8) | data[1]
    lux = raw_value / 1.2

    print("Light: {:.2f} lux".format(lux))
    sleep_ms(16)
`;

const sleep = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function LuxChart({
  readings,
  minLux,
  maxLux,
}: {
  readings: Reading[];
  minLux: number;
  maxLux: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(bounds.width * ratio));
      canvas.height = Math.max(1, Math.round(bounds.height * ratio));

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(ratio, ratio);

      const width = bounds.width;
      const height = bounds.height;
      const pad = { top: 24, right: 18, bottom: 34, left: 58 };
      const plotWidth = width - pad.left - pad.right;
      const plotHeight = height - pad.top - pad.bottom;
      ctx.clearRect(0, 0, width, height);

      const now = readings.at(-1)?.time ?? performance.now();
      const visible = readings.filter((reading) => reading.time >= now - WINDOW_MS);
      const min = minLux;
      const max = maxLux;

      ctx.lineWidth = 1;
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";

      for (let index = 0; index <= 4; index += 1) {
        const y = pad.top + (plotHeight * index) / 4;
        const value = max - ((max - min) * index) / 4;
        ctx.strokeStyle = "rgba(220, 235, 224, 0.10)";
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(width - pad.right, y);
        ctx.stroke();
        ctx.fillStyle = "rgba(220, 235, 224, 0.52)";
        ctx.fillText(value.toFixed(value >= 100 ? 0 : 1), pad.left - 12, y);
      }

      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (let index = 0; index <= 4; index += 1) {
        const x = pad.left + (plotWidth * index) / 4;
        const seconds = -20 + index * 5;
        ctx.fillStyle = "rgba(220, 235, 224, 0.42)";
        ctx.fillText(index === 4 ? "now" : `${seconds}s`, x, height - pad.bottom + 13);
      }

      if (visible.length < 2) return;

      const point = (reading: Reading) => ({
        x: pad.left + ((reading.time - (now - WINDOW_MS)) / WINDOW_MS) * plotWidth,
        y:
          pad.top +
          (1 - (Math.min(max, Math.max(min, reading.value)) - min) / (max - min)) *
            plotHeight,
      });

      const first = point(visible[0]);
      const last = point(visible[visible.length - 1]);

      const fill = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
      fill.addColorStop(0, "rgba(200, 255, 83, 0.30)");
      fill.addColorStop(1, "rgba(200, 255, 83, 0)");
      ctx.beginPath();
      ctx.moveTo(first.x, height - pad.bottom);
      visible.forEach((reading) => {
        const p = point(reading);
        ctx.lineTo(p.x, p.y);
      });
      ctx.lineTo(last.x, height - pad.bottom);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();

      ctx.beginPath();
      visible.forEach((reading, index) => {
        const p = point(reading);
        if (index === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.strokeStyle = "#c8ff53";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#f5ffe5";
      ctx.shadowColor = "#c8ff53";
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [readings, minLux, maxLux]);

  return (
    <canvas
      ref={canvasRef}
      className="chart-canvas"
      role="img"
      aria-label="Live graph of ambient light readings over the last 20 seconds"
    />
  );
}

export default function Home() {
  const [readings, setReadings] = useState<Reading[]>([]);
  const [connectionState, setConnectionState] = useState<
    "disconnected" | "connecting" | "starting" | "waiting" | "live" | "error"
  >("disconnected");
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState("");
  const [chartMinLux, setChartMinLux] = useState(DEFAULT_CHART_MIN_LUX);
  const [chartMaxLux, setChartMaxLux] = useState(DEFAULT_CHART_MAX_LUX);
  const [chartMinInput, setChartMinInput] = useState(
    String(DEFAULT_CHART_MIN_LUX),
  );
  const [chartMaxInput, setChartMaxInput] = useState(
    String(DEFAULT_CHART_MAX_LUX),
  );
  const [scaleError, setScaleError] = useState("");
  const [webSerialSupported, setWebSerialSupported] = useState<boolean | null>(null);
  const portRef = useRef<SerialPortLike | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const pausedRef = useRef(false);
  const manualDisconnectRef = useRef(false);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    setWebSerialSupported(Boolean((navigator as SerialNavigator).serial));
  }, []);

  const addReading = useCallback((value: number, time = performance.now()) => {
    if (!Number.isFinite(value) || pausedRef.current) return;
    setReadings((current) => [...current, { value, time }].slice(-MAX_POINTS));
  }, []);

  useEffect(
    () => () => {
      manualDisconnectRef.current = true;
      readerRef.current?.cancel().catch(() => undefined);
    },
    [],
  );

  const disconnect = useCallback(async () => {
    manualDisconnectRef.current = true;
    setConnectionState("disconnected");
    setError("");
    try {
      await readerRef.current?.cancel();
    } catch {
      // The reader may already be closed.
    }
  }, []);

  const connect = useCallback(async () => {
    setError("");
    setReadings([]);
    setPaused(false);
    manualDisconnectRef.current = false;

    const serial = (navigator as SerialNavigator).serial;
    if (!serial) {
      setError("Web Serial is unavailable. Open this site in Chrome or Edge.");
      setConnectionState("error");
      return;
    }

    setConnectionState("connecting");
    let port: SerialPortLike | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let watchdog: number | undefined;
    let compatibleReadingSeen = false;
    let failureReason = "";

    const clearWatchdog = () => {
      if (watchdog !== undefined) window.clearTimeout(watchdog);
      watchdog = undefined;
    };

    const armWatchdog = (delay: number, message: string) => {
      clearWatchdog();
      watchdog = window.setTimeout(() => {
        failureReason = message;
        reader?.cancel().catch(() => undefined);
      }, delay);
    };

    try {
      port = await serial.requestPort({
        filters: [{ usbVendorId: ESPRESSIF_USB_VENDOR_ID }],
      });
      await port.open({ baudRate: 115200 });
      portRef.current = port;
      setConnectionState("starting");

      if (!port.readable || !port.writable) {
        throw new Error("The selected port does not provide readable and writable serial data.");
      }
      reader = port.readable.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";
      let unexpectedLines = 0;

      const writer = port.writable.getWriter();
      try {
        // Stop any running program, enter MicroPython raw REPL, then execute
        // the BH1750 program directly from this page.
        await writer.write(Uint8Array.of(13, 3, 3));
        await sleep(250);
        await writer.write(Uint8Array.of(13, 1));
        await sleep(250);
        await writer.write(encoder.encode(SENSOR_SCRIPT));
        await writer.write(Uint8Array.of(4));
      } finally {
        writer.releaseLock();
      }

      setConnectionState("waiting");
      armWatchdog(
        5000,
        "The board did not start the BH1750 program within 5 seconds. Select the Feather ESP32-S3 running MicroPython and try again.",
      );

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const match = line.match(/Light:\s*([0-9]+(?:\.[0-9]+)?)\s*lux/i);
          if (match) {
            const lux = Number(match[1]);
            if (!Number.isFinite(lux)) continue;
            compatibleReadingSeen = true;
            setConnectionState("live");
            addReading(lux);
            armWatchdog(
              2500,
              "The Feather stopped sending light readings. Check its USB connection and sensor, then reconnect.",
            );
            continue;
          }

          const trimmed = line.trim();
          if (!trimmed) continue;
          unexpectedLines += 1;

          if (/traceback|oserror|bh1750 not found/i.test(trimmed)) {
            failureReason = `The Feather reported a sensor error: ${trimmed}`;
            await reader.cancel();
            break;
          }

          if (!compatibleReadingSeen && unexpectedLines >= 30) {
            failureReason =
              "The selected port is not running the compatible BH1750 script. Expected lines like “Light: 123.45 lux”.";
            await reader.cancel();
            break;
          }
        }
      }

      if (!manualDisconnectRef.current) {
        if (failureReason) throw new Error(failureReason);
        if (!compatibleReadingSeen) {
          throw new Error(
            "The selected device did not provide compatible BH1750 readings.",
          );
        }
        throw new Error("The serial connection ended unexpectedly.");
      }
    } catch (caught) {
      const rawMessage =
        caught instanceof Error ? caught.message : "Could not connect to the Feather.";
      const message =
        /failed to open|cannot open|already open|busy|in use/i.test(rawMessage)
          ? "Could not open the Feather’s serial port. Stop and disconnect Thonny first, then try again."
          : rawMessage;
      if (!manualDisconnectRef.current && !message.toLowerCase().includes("cancel")) {
        setError(message);
        setConnectionState("error");
      }
    } finally {
      clearWatchdog();
      try {
        reader?.releaseLock();
      } catch {
        // A cancelled reader may already have released its lock.
      }
      readerRef.current = null;
      try {
        await port?.close();
      } catch {
        // The port may already be unavailable.
      }
      portRef.current = null;
      if (manualDisconnectRef.current) setConnectionState("disconnected");
      manualDisconnectRef.current = false;
    }
  }, [addReading]);

  const stats = useMemo(() => {
    const values = readings.map((reading) => reading.value);
    if (!values.length) return { current: 0, min: 0, max: 0, average: 0, rate: 0 };
    const recent = readings.slice(-40);
    const duration =
      recent.length > 1 ? recent[recent.length - 1].time - recent[0].time : 0;
    return {
      current: values[values.length - 1],
      min: Math.min(...values),
      max: Math.max(...values),
      average: values.reduce((total, value) => total + value, 0) / values.length,
      rate: duration > 0 ? ((recent.length - 1) * 1000) / duration : 0,
    };
  }, [readings]);

  const isPortOpen =
    connectionState === "starting" ||
    connectionState === "waiting" ||
    connectionState === "live";
  const hasReadings = readings.length > 0;
  const status = {
    disconnected: "Not connected",
    connecting: "Choose a serial port",
    starting: "Starting sensor program…",
    waiting: "Validating device…",
    live: "BH1750 streaming",
    error: "Connection failed",
  }[connectionState];
  const emptyChartMessage = {
    disconnected: "Connect your Feather to begin",
    connecting: "Waiting for serial-port selection…",
    starting: "Loading the BH1750 program onto the Feather…",
    waiting: "Port opened. Checking for BH1750 readings…",
    live: "Waiting for the first reading…",
    error: "No compatible sensor data",
  }[connectionState];
  const formatStat = (value: number) => (hasReadings ? value.toFixed(1) : "—");
  const applyChartScale = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextMin = Number(chartMinInput);
    const nextMax = Number(chartMaxInput);

    if (!Number.isFinite(nextMin) || !Number.isFinite(nextMax)) {
      setScaleError("Enter a number for both bounds.");
      return;
    }
    if (nextMin < 0) {
      setScaleError("The lower bound cannot be negative.");
      return;
    }
    if (nextMax <= nextMin) {
      setScaleError("The upper bound must be greater than the lower bound.");
      return;
    }

    setChartMinLux(nextMin);
    setChartMaxLux(nextMax);
    setScaleError("");
  };

  return (
    <main>
      <header className="site-header">
        <a className="wordmark" href="#" aria-label="Light Stream home">
          <span className="sun-mark" aria-hidden="true" />
          LIGHT<span>/</span>STREAM
        </a>
        <div className="header-meta">
          <span>BH1750</span>
          <span>ESP32-S3</span>
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">Ambient light monitor</p>
          <h1>See the room<br />change in real time.</h1>
        </div>
        <div className="connection-panel">
          <div className="status-line">
            <span className={`status-dot ${connectionState}`} />
            <span>{status}</span>
          </div>
          <p>
            Connect your Feather and this page will load the BH1750 MicroPython
            program, start it, and graph each lux reading in this browser.
          </p>
          <div className="button-row">
            <button
              className="primary-button"
              onClick={isPortOpen ? disconnect : connect}
              disabled={connectionState === "connecting"}
            >
              {isPortOpen
                ? "Disconnect"
                : connectionState === "connecting"
                  ? "Choose port…"
                  : connectionState === "error"
                    ? "Try again"
                    : "Connect Feather"}
            </button>
          </div>
          {webSerialSupported === false && (
            <p className="browser-note">Use Chrome or Edge to connect over USB.</p>
          )}
          {webSerialSupported !== false && (
            <p className="browser-note">
              Close or disconnect Thonny before connecting—the serial port can
              only be used by one app at a time.
            </p>
          )}
          {error && (
            <div className="error-note" role="alert">
              <strong>Connection unsuccessful</strong>
              <span>{error}</span>
            </div>
          )}
        </div>
      </section>

      <section className="monitor" aria-label="Live light monitor">
        <div className="reading-block">
          <p className="metric-label">Illuminance</p>
          <div className="live-reading" aria-live="polite">
            <span>{formatStat(stats.current)}</span>
            <small>lux</small>
          </div>
          <div className="sample-rate">
            <span>{hasReadings ? stats.rate.toFixed(1) : "0.0"} samples/s</span>
            <span>{readings.length.toLocaleString()} captured</span>
          </div>
        </div>

        <div className="chart-panel">
          <div className="chart-toolbar">
            <div>
              <span className={`live-indicator ${connectionState === "live" ? "active" : ""}`} />
              Last 20 seconds
            </div>
            <div className="chart-actions">
              <button onClick={() => setPaused((current) => !current)}>
                {paused ? "Resume" : "Pause"}
              </button>
              <button onClick={() => setReadings([])}>Clear</button>
            </div>
          </div>
          <form className="scale-controls" onSubmit={applyChartScale}>
            <span>Graph range</span>
            <label>
              <span>Lower</span>
              <input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={chartMinInput}
                onChange={(event) => setChartMinInput(event.target.value)}
                aria-label="Graph lower bound in lux"
              />
            </label>
            <span aria-hidden="true">to</span>
            <label>
              <span>Upper</span>
              <input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={chartMaxInput}
                onChange={(event) => setChartMaxInput(event.target.value)}
                aria-label="Graph upper bound in lux"
              />
            </label>
            <span>lux</span>
            <button type="submit">Apply</button>
            {scaleError && (
              <span className="scale-error" role="alert">
                {scaleError}
              </span>
            )}
          </form>
          <div className="chart-stage">
            <LuxChart
              readings={readings}
              minLux={chartMinLux}
              maxLux={chartMaxLux}
            />
            {!hasReadings && (
              <div className={`empty-chart ${connectionState}`} aria-live="polite">
                <span />
                <strong>{emptyChartMessage}</strong>
                <small>
                  {connectionState === "error"
                    ? "Review the connection error above, then try again."
                    : "Expected serial format: Light: 123.45 lux"}
                </small>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="stats-grid" aria-label="Reading statistics">
        <article>
          <p>Minimum</p>
          <strong>{formatStat(stats.min)}</strong>
          <span>lux</span>
        </article>
        <article>
          <p>Average</p>
          <strong>{formatStat(stats.average)}</strong>
          <span>lux</span>
        </article>
        <article>
          <p>Maximum</p>
          <strong>{formatStat(stats.max)}</strong>
          <span>lux</span>
        </article>
        <article className="sensor-card">
          <p>Sensor mode</p>
          <strong>Low res</strong>
          <span>4 lux · 16 ms typical</span>
        </article>
      </section>

      <footer>
        <span>LIGHT/STREAM</span>
        <p>Local serial visualization for Adafruit Feather ESP32-S3 + BH1750.</p>
      </footer>
    </main>
  );
}
