import { stopWorker } from './worker-process';

/** Гасим воркер: иначе он переживёт прогон и продолжит закрывать чужие торги. */
export default function globalTeardown(): void {
  stopWorker();
}
