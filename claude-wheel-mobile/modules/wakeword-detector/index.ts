import { NativeModules } from 'react-native';

const { WakeWordDetector } = NativeModules;

/** Compute a 2048-dim embedding for a 16kHz mono WAV file at `path` (local filesystem path). */
export function embedFile(path: string): Promise<number[]> {
  return WakeWordDetector.embedFile(path);
}

/** Compute the embedding for the WAV at `path` and return its max similarity score
 * (0..1) against a set of enrolled reference embeddings. */
export function scoreFile(path: string, references: number[][]): Promise<number> {
  return WakeWordDetector.scoreFile(path, references);
}
