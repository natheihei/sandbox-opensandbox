// Minimal Harness exports needed by the unit tests without loading published beta packages.
export class HarnessCapabilityUnsupportedError extends Error {
  constructor({ message }: { harnessId: string; message: string }) {
    super(message);
    this.name = 'HarnessCapabilityUnsupportedError';
  }
}
