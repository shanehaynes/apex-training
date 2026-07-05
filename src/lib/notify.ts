// Minimal module-level toast bus — deliberately not a React context so
// non-component code (the API client, autosave) can surface failures.
// Toasts.tsx subscribes via useSyncExternalStore.

export interface Toast {
  id: number;
  message: string;
}

const AUTO_DISMISS_MS = 5000;

let nextId = 1;
let toasts: readonly Toast[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getToasts(): readonly Toast[] {
  return toasts;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function dismiss(id: number) {
  if (!toasts.some(t => t.id === id)) return;
  toasts = toasts.filter(t => t.id !== id);
  emit();
}

export function notify(message: string) {
  const toast: Toast = { id: nextId++, message };
  toasts = [...toasts, toast];
  emit();
  setTimeout(() => dismiss(toast.id), AUTO_DISMISS_MS);
}
