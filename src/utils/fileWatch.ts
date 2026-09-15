type SelfWriteListener = (filePath: string) => void;

const selfWriteListeners = new Set<SelfWriteListener>();

/**
 * Records that the app itself wrote a file, so an in-app save is never
 * reported as an external modification.
 */
export function recordSelfWrite(filePath: string): void {
  selfWriteListeners.forEach((listener) => listener(filePath));
}

export function subscribeSelfWrite(listener: SelfWriteListener): () => void {
  selfWriteListeners.add(listener);
  return () => {
    selfWriteListeners.delete(listener);
  };
}
