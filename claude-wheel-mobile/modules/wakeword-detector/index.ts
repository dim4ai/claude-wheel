import { requireNativeModule, EventEmitter } from 'expo-modules-core';

type WakeWordEvents = { onScore: (event: { score: number }) => void };

const WakeWordDetector = requireNativeModule('WakeWordDetector');
const emitter = new EventEmitter<WakeWordEvents>(WakeWordDetector);

/** Compute a 2048-dim embedding for a 16kHz mono WAV file at `path` (local filesystem path). */
export function embedFile(path: string): Promise<number[]> {
  return WakeWordDetector.embedFile(path);
}

/** Compute the embedding for the WAV at `path` and return its max similarity score
 * (0..1) against a set of enrolled reference embeddings. */
export function scoreFile(path: string, references: number[][]): Promise<number> {
  return WakeWordDetector.scoreFile(path, references);
}

/** Records `durationMs` of mic audio and returns its embedding (for enrollment). */
export function recordSample(durationMs: number): Promise<number[]> {
  return WakeWordDetector.recordSample(durationMs);
}

/** Starts continuous mic listening; emits an 'onScore' event every `hopMs` with the
 * raw similarity (0..1) of the trailing 1.5s window against `references`. */
export function startListening(references: number[][], hopMs: number): Promise<void> {
  return WakeWordDetector.startListening(references, hopMs);
}

export function stopListening(): Promise<void> {
  return WakeWordDetector.stopListening();
}

/** Starts buffering the command's raw audio from the already-running listening loop
 * (no second mic session). Call while `startListening` is active. */
export function startRecordingCommand(): Promise<void> {
  return WakeWordDetector.startRecordingCommand();
}

/** Stops buffering and returns a `file://` URI to the written 16kHz mono WAV. */
export function stopRecordingCommand(): Promise<string> {
  return WakeWordDetector.stopRecordingCommand();
}

export function addScoreListener(callback: (event: { score: number }) => void) {
  return emitter.addListener('onScore', callback);
}
