"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Reading = {
  value: number;
  time: number;
};

type SerialPortLike = {
  readable: ReadableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
};

type SerialNavigator = Navigator & {
  serial?: {
    requestPort(): Promise<SerialPortLike>;
  };
};

const MAX_POINTS = 3600;
const WINDOW_MS = 20_000;

function LuxChart({ readings }: { readings: Reading[] }) {
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
      const values = visible.map((reading) => reading.value);
      const rawMin = values.length ? Math.min(...values) : 0;
      const rawMax = values.length ? Math.max(...values) : 100;
      const spread = Math.max(rawMax - rawMin, 8);
      const min = Math.max(0, rawMin - spread * 0.15);
      const max = rawMax + spread * 0.2;

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
        y: pad.top + (1 - (reading.value - min) / (max - min)) * plotHeight,
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
  }, [readings]);

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
  const [connected, setConnected] = useState(false);
  const [demoMode, setDemoMode] = useState(true);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState("");
  const portRef = useRef<SerialPortLike | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const pausedRef = useRef(false);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const addReading = useCallback((value: number, time = performance.now()) => {
    if (!Number.isFinite(value) || pausedRef.current) return;
    setReadings((current) => [...current, { value, time }].slice(-MAX_POINTS));
  }, []);

  useEffect(() => {
    if (!demoMode || connected) return;
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      const elapsed = (performance.now() - startedAt) / 1000;
      const daylight = 312 + Math.sin(elapsed * 0.55) * 68;
      const movement = Math.sin(elapsed * 2.2) * 14 + Math.sin(elapsed * 0.13) * 36;
      addReading(Math.max(0, daylight + movement + (Math.random() - 0.5) * 8));
    }, 100);
    return () => window.clearInterval(timer);
  }, [addReading, connected, demoMode]);

  useEffect(
    () => () => {
      readerRef.current?.cancel().catch(() => undefined);
      portRef.current?.close().catch(() => undefined);
    },
    [],
  );

  const disconnect = useCallback(async () => {
    try {
      await readerRef.current?.cancel();
    } catch {
      // The reader may already be closed.
    }
    readerRef.current = null;
    try {
      await portRef.current?.close();
    } catch {
      // The port may already be closed.
    }
    portRef.current = null;
    setConnected(false);
  }, []);

  const connect = useCallback(async () => {
    setError("");
    const serial = (navigator as SerialNavigator).serial;
    if (!serial) {
      setError("Web Serial is unavailable. Open this site in Chrome or Edge.");
      return;
    }

    try {
      const port = await serial.requestPort();
      await port.open({ baudRate: 115200 });
      portRef.current = port;
      setDemoMode(false);
      setConnected(true);
      setReadings([]);

      if (!port.readable) throw new Error("The serial port is not readable.");
      const reader = port.readable.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const match = line.match(/Light:\s*([0-9]+(?:\.[0-9]+)?)\s*lux/i);
          if (match) addReading(Number(match[1]));
        }
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Could not connect to the Feather.";
      if (!message.toLowerCase().includes("cancel")) setError(message);
      await disconnect();
    } finally {
      readerRef.current?.releaseLock();
      readerRef.current = null;
    }
  }, [addReading, disconnect]);

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

  const supportWebSerial =
    typeof navigator !== "undefined" && Boolean((navigator as SerialNavigator).serial);

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
            <span className={`status-dot ${connected ? "connected" : demoMode ? "demo" : ""}`} />
            <span>{connected ? "Feather connected" : demoMode ? "Demo signal" : "Not connected"}</span>
          </div>
          <p>
            Connect your Feather to stream its BH1750 readings directly into this
            browser. Your data stays on this device.
          </p>
          <div className="button-row">
            <button className="primary-button" onClick={connected ? disconnect : connect}>
              {connected ? "Disconnect" : "Connect Feather"}
            </button>
            {!connected && (
              <button
                className="text-button"
                onClick={() => {
                  setDemoMode((current) => !current);
                  setReadings([]);
                }}
              >
                {demoMode ? "Stop demo" : "Try demo"}
              </button>
            )}
          </div>
          {!supportWebSerial && (
            <p className="browser-note">Use Chrome or Edge to connect over USB.</p>
          )}
          {error && <p className="error-note">{error}</p>}
        </div>
      </section>

      <section className="monitor" aria-label="Live light monitor">
        <div className="reading-block">
          <p className="metric-label">Illuminance</p>
          <div className="live-reading" aria-live="polite">
            <span>{stats.current.toFixed(1)}</span>
            <small>lux</small>
          </div>
          <div className="sample-rate">
            <span>{stats.rate.toFixed(1)} samples/s</span>
            <span>{readings.length.toLocaleString()} captured</span>
          </div>
        </div>

        <div className="chart-panel">
          <div className="chart-toolbar">
            <div>
              <span className="live-indicator" />
              Last 20 seconds
            </div>
            <div className="chart-actions">
              <button onClick={() => setPaused((current) => !current)}>
                {paused ? "Resume" : "Pause"}
              </button>
              <button onClick={() => setReadings([])}>Clear</button>
            </div>
          </div>
          <LuxChart readings={readings} />
        </div>
      </section>

      <section className="stats-grid" aria-label="Reading statistics">
        <article>
          <p>Minimum</p>
          <strong>{stats.min.toFixed(1)}</strong>
          <span>lux</span>
        </article>
        <article>
          <p>Average</p>
          <strong>{stats.average.toFixed(1)}</strong>
          <span>lux</span>
        </article>
        <article>
          <p>Maximum</p>
          <strong>{stats.max.toFixed(1)}</strong>
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
