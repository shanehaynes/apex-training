import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';

// Cloudflare Turnstile, explicit-render mode, loaded only when the create
// tab mounts so a sign-in never pulls a third-party script. Tokens are
// single-use: the parent calls reset() after every submit, and an expired or
// errored widget hands back null so the button disables again.

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface Turnstile {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
}

declare global {
  interface Window { turnstile?: Turnstile }
}

let loading: Promise<Turnstile> | null = null;

function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing')));
    script.onerror = () => { loading = null; reject(new Error('turnstile failed to load')); };
    document.head.appendChild(script);
  });
  return loading;
}

export interface TurnstileHandle { reset: () => void }

interface Props {
  siteKey: string;
  onToken: (token: string | null) => void;
}

const TurnstileWidget = forwardRef<TurnstileHandle, Props>(function TurnstileWidget({ siteKey, onToken }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  useLayoutEffect(() => { onTokenRef.current = onToken; }, [onToken]);

  useImperativeHandle(ref, () => ({
    reset: () => {
      onTokenRef.current(null);
      if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
    },
  }), []);

  useEffect(() => {
    let cancelled = false;
    loadTurnstile().then(ts => {
      if (cancelled || !el.current) return;
      widgetId.current = ts.render(el.current, {
        sitekey: siteKey,
        callback: (token: string) => onTokenRef.current(token),
        'expired-callback': () => onTokenRef.current(null),
        'error-callback': () => onTokenRef.current(null),
      });
    }).catch(() => onTokenRef.current(null));
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey]);

  return <div ref={el} data-testid="turnstile" />;
});

export default TurnstileWidget;
