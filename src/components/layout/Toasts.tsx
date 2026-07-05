import { useSyncExternalStore } from 'react';
import { dismiss, getToasts, subscribe } from '../../lib/notify';

export default function Toasts() {
  const toasts = useSyncExternalStore(subscribe, getToasts);
  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(toast => (
        <button key={toast.id} className="toast" onClick={() => dismiss(toast.id)}>
          {toast.message}
        </button>
      ))}
    </div>
  );
}
