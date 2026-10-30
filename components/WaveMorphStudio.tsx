"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, DragEvent } from "react";
import { getWaveformPeaks, transferEnvelope } from "@/lib/envelope";
import { encodeWav } from "@/lib/wav-encoder";

type LoadedTrack = {
  file: File;
  buffer: AudioBuffer;
  peaks: number[];
  url: string;
};

type TrackKey = "source" | "reference";

type ProcessedTrack = {
  url: string;
  fileName: string;
  duration: number;
  peak: number;
  peaks: number[];
};

const MAX_FILE_SIZE = 60 * 1024 * 1024;
const MAX_DURATION_SECONDS = 5 * 60;

function getPeaksFromChannels(channels: Float32Array[], bars = 96): number[] {
  const peaks = new Array<number>(bars).fill(0);
  const length = channels[0]?.length ?? 0;
  const blockSize = Math.max(1, Math.floor(length / bars));

  for (let bar = 0; bar < bars; bar += 1) {
    const start = bar * blockSize;
    const end = bar === bars - 1 ? length : Math.min(length, start + blockSize);
    let peak = 0;
    for (const channel of channels) {
      for (let sample = start; sample < end; sample += 1) {
        peak = Math.max(peak, Math.abs(channel[sample]));
      }
    }
    peaks[bar] = peak;
  }

  const max = Math.max(...peaks, 0.0001);
  return peaks.map((value) => Math.max(0.06, value / max));
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remaining}`;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
    : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

function WaveformBars({ peaks, tone = "mint" }: { peaks: number[]; tone?: "mint" | "violet" | "white" }) {
  return (
    <div className={`waveform waveform-${tone}`} aria-label="Визуализация аудиоволны">
      {peaks.map((peak, index) => (
        <span key={index} style={{ height: `${Math.max(5, peak * 100)}%` }} />
      ))}
    </div>
  );
}

function UploadCard({
  title,
  subtitle,
  tag,
  accent,
  track,
  busy,
  onFile,
}: {
  title: string;
  subtitle: string;
  tag: string;
  accent: "mint" | "violet";
  track: LoadedTrack | null;
  busy: boolean;
  onFile: (file: File) => void;
}) {
  const [dragging, setDragging] = useState(false);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onFile(file);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) onFile(file);
  };

  return (
    <section className={`upload-card upload-${accent}`}>
      <div className="card-heading">
        <div>
          <div className="eyebrow">{tag}</div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <span className="card-index">{accent === "mint" ? "01" : "02"}</span>
      </div>

      <label
        className={`drop-zone ${dragging ? "drop-zone-active" : ""} ${track ? "drop-zone-loaded" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <input type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac,.opus" onChange={handleChange} />
        {busy ? (
          <div className="loading-state">
            <span className="spinner" />
            <strong>Читаю аудио…</strong>
            <small>Файл обрабатывается локально</small>
          </div>
        ) : track ? (
          <div className="loaded-state">
            <div className="file-topline">
              <span className="file-icon">♫</span>
              <div className="file-info">
                <strong title={track.file.name}>{track.file.name}</strong>
                <small>{formatTime(track.buffer.duration)} · {formatSize(track.file.size)}</small>
              </div>
              <span className="replace-label">Заменить</span>
            </div>
            <WaveformBars peaks={track.peaks} tone={accent} />
            <audio controls preload="metadata" src={track.url} onClick={(event) => event.stopPropagation()} />
          </div>
        ) : (
          <div className="empty-state">
            <span className="upload-icon">↑</span>
            <strong>Перетащи файл сюда</strong>
            <span>или <em>выбери на устройстве</em></span>
            <small>WAV, MP3, M4A, FLAC, OGG · до 60 МБ / 5 мин</small>
          </div>
        )}
      </label>
    </section>
  );
}

export default function WaveMorphStudio() {
  const [source, setSource] = useState<LoadedTrack | null>(null);
  const [reference, setReference] = useState<LoadedTrack | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [strength, setStrength] = useState(100);
  const [smoothing, setSmoothing] = useState("100");
  const [error, setError] = useState("");
  const [result, setResult] = useState<ProcessedTrack | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const objectUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      void audioContextRef.current?.close();
    };
  }, []);

  const ready = Boolean(source && reference && !sourceBusy && !referenceBusy && !processing);
  const durationNote = useMemo(() => {
    if (!source || !reference) return "Оба файла могут иметь разную длину — огибающая подстроится по времени.";
    const difference = Math.abs(source.buffer.duration - reference.buffer.duration);
    if (difference > 0.1) return "Длины различаются: огибающая референса будет масштабирована под временную шкалу исходника.";
    return "Длительность файлов совпадает — можно переносить огибающую.";
  }, [source, reference]);

  const getAudioContext = () => {
    if (!audioContextRef.current) audioContextRef.current = new AudioContext();
    return audioContextRef.current;
  };

  const loadFile = async (key: TrackKey, file: File) => {
    setError("");
    setResult(null);

    if (file.size > MAX_FILE_SIZE) {
      setError("Файл слишком большой. Максимальный размер — 60 МБ.");
      return;
    }
    if (!file.type.startsWith("audio/") && !/\.(wav|mp3|m4a|aac|ogg|flac|opus)$/i.test(file.name)) {
      setError("Похоже, это не аудиофайл.");
      return;
    }

    const setBusy = key === "source" ? setSourceBusy : setReferenceBusy;
    setBusy(true);

    try {
      const context = getAudioContext();
      const bytes = await file.arrayBuffer();
      const decoded = await context.decodeAudioData(bytes.slice(0));

      if (decoded.duration > MAX_DURATION_SECONDS) {
        throw new Error("Максимальная длительность файла — 5 минут.");
      }
      if (decoded.numberOfChannels > 2) {
        throw new Error("Файлы с более чем двумя каналами пока не поддерживаются.");
      }

      const url = URL.createObjectURL(file);
      objectUrlsRef.current.push(url);
      const track: LoadedTrack = {
        file,
        buffer: decoded,
        peaks: getWaveformPeaks(decoded),
        url,
      };

      if (key === "source") setSource(track);
      else setReference(track);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Не удалось прочитать этот файл.";
      setError(message.includes("Unable to decode") || message.includes("encoding")
        ? "Браузер не смог декодировать файл. Попробуй WAV или MP3."
        : message);
    } finally {
      setBusy(false);
    }
  };

  const process = async () => {
    if (!source || !reference) return;
    setError("");
    setProcessing(true);

    try {
      await getAudioContext().resume();
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      const processed = transferEnvelope(source.buffer, reference.buffer, {
        strength: strength / 100,
        smoothingMs: Number(smoothing),
      });
      const blob = encodeWav(processed.channels, processed.sampleRate);
      const url = URL.createObjectURL(blob);
      objectUrlsRef.current.push(url);

      setResult({
        url,
        fileName: `${source.file.name.replace(/\.[^.]+$/, "") || "wavemorph"}-morphed.wav`,
        duration: processed.duration,
        peak: processed.peak,
        peaks: getPeaksFromChannels(processed.channels),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось обработать аудио.");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <main className="page-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar">
        <a className="brand" href="#top" aria-label="WaveMorph — главная">
          <span className="brand-mark"><i /><i /><i /><i /><i /></span>
          <span>WAVE<span className="brand-light">MORPH</span></span>
        </a>
        <div className="topbar-right">
          <span className="local-pill"><span /> ОБРАБОТКА В БРАУЗЕРЕ</span>
          <span className="github-link">WAV / PCM EXPORT</span>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-kicker"><span /> AUDIO ENVELOPE TRANSFER</div>
        <h1>Перенеси <span>форму.</span><br />Сохрани звучание.</h1>
        <p className="hero-copy">
          Возьми динамику одного вокала и примени её к другому.
          <br className="desktop-break" /> Без загрузки файлов на сервер и лишних плагинов.
        </p>
        <div className="hero-wave" aria-hidden="true">
          {Array.from({ length: 92 }, (_, index) => {
            const curve = Math.abs(Math.sin(index * 0.19) * Math.cos(index * 0.047));
            const envelope = 0.22 + 0.78 * Math.pow(Math.sin((index / 91) * Math.PI), 0.7);
            return <span key={index} style={{ height: `${Math.max(4, curve * envelope * 54)}px` }} />;
          })}
        </div>
      </section>

      <section className="workspace" aria-label="Перенос аудиоогибающей">
        <div className="section-topline">
          <div>
            <span className="section-label">WORKSPACE / 01</span>
            <h2>Загрузи аудио</h2>
          </div>
          <span className="format-note">MP3 · WAV · M4A · FLAC</span>
        </div>

        <div className="upload-grid">
          <UploadCard
            title="Исходное аудио"
            subtitle="Звук, который нужно изменить"
            tag="SOURCE TRACK"
            accent="mint"
            track={source}
            busy={sourceBusy}
            onFile={(file) => void loadFile("source", file)}
          />
          <UploadCard
            title="Аудио-образец"
            subtitle="Динамика, которую нужно повторить"
            tag="REFERENCE TRACK"
            accent="violet"
            track={reference}
            busy={referenceBusy}
            onFile={(file) => void loadFile("reference", file)}
          />
        </div>

        <div className="matching-note">
          <span className="note-icon">⌁</span>
          <span>{durationNote}</span>
        </div>

        <div className="settings-card">
          <div className="settings-title">
            <div>
              <span className="section-label">PROCESSING / 02</span>
              <h2>Параметры переноса</h2>
            </div>
            <span className="settings-chip">RMS ENVELOPE</span>
          </div>
          <div className="settings-grid">
            <div className="setting-block">
              <div className="setting-label-row">
                <label htmlFor="strength">Сила переноса</label>
                <strong>{strength}%</strong>
              </div>
              <input id="strength" className="range-input" type="range" min="0" max="100" step="1" value={strength} style={{ "--range": `${strength}%` } as CSSProperties} onChange={(event) => setStrength(Number(event.target.value))} />
              <div className="range-captions"><span>Мягко</span><span>Полностью</span></div>
            </div>
            <div className="setting-block smoothing-setting">
              <label htmlFor="smoothing">Сглаживание огибающей</label>
              <select id="smoothing" value={smoothing} onChange={(event) => setSmoothing(event.target.value)}>
                <option value="40">40 мс · Детально</option>
                <option value="100">100 мс · Баланс</option>
                <option value="180">180 мс · Плавно</option>
                <option value="280">280 мс · Очень плавно</option>
              </select>
              <small>Больше сглаживание — меньше резких изменений громкости.</small>
            </div>
          </div>
        </div>

        {error && <div className="error-message" role="alert"><span>!</span>{error}</div>}

        <button className="process-button" type="button" disabled={!ready} onClick={() => void process()}>
          {processing ? <><span className="spinner spinner-dark" /> Обрабатываю аудио…</> : <>Перенести огибающую <span>→</span></>}
        </button>
        <p className="privacy-caption"><span>▣</span> Файлы остаются на твоём устройстве. На сервер ничего не отправляется.</p>

        {result && (
          <section className="result-card" aria-live="polite">
            <div className="result-heading">
              <div>
                <span className="section-label">COMPLETE / 03</span>
                <h2>Готово. Огибающая перенесена.</h2>
              </div>
              <span className="success-mark">✓</span>
            </div>
            <div className="result-wave-wrap">
              <div className="result-wave-label"><span>PROCESSED SOURCE</span><span>{formatTime(result.duration)}</span></div>
              <WaveformBars peaks={result.peaks} tone="mint" />
            </div>
            <audio className="result-audio" controls src={result.url} />
            <a className="download-button" href={result.url} download={result.fileName}>
              Скачать WAV <span>↓</span>
            </a>
            <p className="result-meta">WAV · PCM 16-bit · Пик {result.peak.toFixed(2)} FS · {result.fileName}</p>
          </section>
        )}
      </section>

      <footer className="footer">
        <span className="footer-brand">WAVEMORPH</span>
        <span>Shape the dynamics. Keep the performance.</span>
        <span>v1.0.0</span>
      </footer>
    </main>
  );
    }
