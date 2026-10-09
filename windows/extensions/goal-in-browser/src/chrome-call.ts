/** Wraps a callback-style chrome.* call in a promise. Rejects when chrome.runtime.lastError is set. */
export function invoke<T>(run: (done: (result: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    run((result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message ?? 'Chrome API error'));
      else resolve(result);
    });
  });
}

/** Runs a task and returns its error message, or null when it succeeded. */
export async function attempt(task: () => Promise<unknown>): Promise<string | null> {
  try {
    await task();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
