const logListeners = new Set<LogListener>();

export interface LogListener {
  onLog(message: string): void;
}

export function addLogListener(listener: LogListener) {
  logListeners.add(listener);
  return () => {
    logListeners.delete(listener);
  };
}

export function log(message: string) {
  for (const listener of logListeners) {
    listener.onLog(message);
  }
}
