export type EnvelopeOptions = {
  strength: number;
  smoothingMs: number;
  minGain?: number;
  maxGain?: number;
};

export type ProcessedAudio = {
  channels: Float32Array[];
  sampleRate: number;
  duration: number;
  peak: number;
};

function calculateRms(buffer: AudioBuffer, start: number, end: number): number {
  const safeStart = Math.max(0, Math.min(buffer.length, start));
  const safeEnd = Math.max(safeStart + 1, Math.min(buffer.length, end));
  const count = safeEnd - safeStart;
  let sum = 0;

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let sample = safeStart; sample < safeEnd; sample += 1) {
      const value = data[sample];
      sum += value * value;
    }
  }

  return Math.sqrt(sum / (count * buffer.numberOfChannels));
}

function smooth(values: Float64Array, radius: number): Float64Array {
  if (radius <= 0) return values;

  const result = new Float64Array(values.length);
  const prefix = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i += 1) {
    prefix[i + 1] = prefix[i] + values[i];
  }

  for (let i = 0; i < values.length; i += 1) {
    const left = Math.max(0, i - radius);
    const right = Math.min(values.length, i + radius + 1);
    result[i] = (prefix[right] - prefix[left]) / (right - left);
  }

  return result;
}

function mean(values: Float64Array): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < values.length; i += 1) total += values[i];
  return total / values.length;
}

function interpolate(values: Float64Array, position: number): number {
  if (values.length === 1) return values[0];
  const bounded = Math.max(0, Math.min(values.length - 1, position));
  const left = Math.floor(bounded);
  const right = Math.min(values.length - 1, left + 1);
  const mix = bounded - left;
  return values[left] * (1 - mix) + values[right] * mix;
}

/**
 * Applies the reference track's smoothed RMS contour to the source track.
 * The source waveform itself is retained; only its time-varying gain changes.
 */
export function transferEnvelope(
  source: AudioBuffer,
  reference: AudioBuffer,
  options: EnvelopeOptions,
): ProcessedAudio {
  if (source.length === 0 || reference.length === 0) {
    throw new Error("Один из аудиофайлов пустой.");
  }

  const sampleRate = source.sampleRate;
  const hopSize = Math.max(1, Math.round(sampleRate * 0.02));
  const frameCount = Math.ceil(source.length / hopSize);
  const sourceEnvelope = new Float64Array(frameCount);
  const referenceEnvelope = new Float64Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const sourceStart = frame * hopSize;
    const sourceEnd = Math.min(source.length, sourceStart + hopSize);
    const referenceStart = Math.floor((sourceStart / source.length) * reference.length);
    const referenceEnd = Math.max(
      referenceStart + 1,
      Math.floor((sourceEnd / source.length) * reference.length),
    );

    sourceEnvelope[frame] = calculateRms(source, sourceStart, sourceEnd);
    referenceEnvelope[frame] = calculateRms(reference, referenceStart, referenceEnd);
  }

  const smoothingFrames = Math.max(
    0,
    Math.round((options.smoothingMs / 1000) * sampleRate / hopSize / 2),
  );
  const sourceSmooth = smooth(sourceEnvelope, smoothingFrames);
  const referenceSmooth = smooth(referenceEnvelope, smoothingFrames);
  const sourceMean = mean(sourceSmooth);
  const referenceMean = mean(referenceSmooth);

  if (sourceMean < 1e-8) {
    throw new Error("В исходном аудио почти нет сигнала.");
  }
  if (referenceMean < 1e-8) {
    throw new Error("В аудио-образце почти нет сигнала.");
  }

  const minGain = options.minGain ?? 0.125;
  const maxGain = options.maxGain ?? 8;
  const strength = Math.max(0, Math.min(1, options.strength));
  const gainCurve = new Float64Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const sourceLevel = Math.max(sourceSmooth[frame] / sourceMean, 0.035);
    const referenceLevel = Math.max(referenceSmooth[frame] / referenceMean, 0.015);
    const wantedGain = referenceLevel / sourceLevel;
    const boundedGain = Math.max(minGain, Math.min(maxGain, wantedGain));
    gainCurve[frame] = 1 + (boundedGain - 1) * strength;
  }

  const channels: Float32Array[] = [];
  let peak = 0;

  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    const input = source.getChannelData(channel);
    const output = new Float32Array(source.length);

    for (let sample = 0; sample < source.length; sample += 1) {
      const framePosition = sample / hopSize - 0.5;
      const gain = interpolate(gainCurve, framePosition);
      const value = input[sample] * gain;
      output[sample] = value;
      peak = Math.max(peak, Math.abs(value));
    }

    channels.push(output);
  }

  if (peak > 0.98) {
    const scale = 0.98 / peak;
    for (const channel of channels) {
      for (let sample = 0; sample < channel.length; sample += 1) {
        channel[sample] *= scale;
      }
    }
    peak = 0.98;
  }

  return {
    channels,
    sampleRate,
    duration: source.duration,
    peak,
  };
}

export function getWaveformPeaks(buffer: AudioBuffer, bars = 96): number[] {
  const peaks = new Array<number>(bars).fill(0);
  const blockSize = Math.max(1, Math.floor(buffer.length / bars));

  for (let bar = 0; bar < bars; bar += 1) {
    const start = bar * blockSize;
    const end = bar === bars - 1 ? buffer.length : Math.min(buffer.length, start + blockSize);
    let peak = 0;

    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let sample = start; sample < end; sample += 1) {
        peak = Math.max(peak, Math.abs(data[sample]));
      }
    }

    peaks[bar] = peak;
  }

  const max = Math.max(...peaks, 0.0001);
  return peaks.map((value) => Math.max(0.06, value / max));
}
