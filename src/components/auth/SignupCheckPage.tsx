import TurnstileWidget from './TurnstileWidget';

// The human check for the iOS app's Create account (docs/specs/open-signup.md
// M3). Turnstile only runs in a web page on a hostname its widget allows, so
// the app shows this page in a WKWebView and receives the token over a
// WebKit message handler named `turnstile`. The app then posts it to
// /api/signup itself — this page sends nothing anywhere else.
//
// Messages are JSON strings: {"token": "..."} on a pass, {"expired": true}
// when a token lapses before the app uses it. Opened in a plain browser
// there is no handler, and the page says so rather than looking broken.

const SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) || undefined;

interface WebKitBridge {
  webkit?: { messageHandlers?: { turnstile?: { postMessage: (body: string) => void } } };
}

function post(message: Record<string, unknown>) {
  (window as WebKitBridge).webkit?.messageHandlers?.turnstile?.postMessage(JSON.stringify(message));
}

export default function SignupCheckPage() {
  const inApp = Boolean((window as WebKitBridge).webkit?.messageHandlers?.turnstile);
  return (
    <div className="auth-screen">
      <div className="auth-card" data-testid="signup-check">
        {SITE_KEY ? (
          <>
            <p className="auth-note">One quick check that you are a person.</p>
            <TurnstileWidget
              siteKey={SITE_KEY}
              onToken={token => post(token ? { token } : { expired: true })}
            />
            {!inApp && <p className="auth-hint">This page is for the Apex iPhone app.</p>}
          </>
        ) : (
          <p className="auth-note">Sign-up isn't open right now.</p>
        )}
      </div>
    </div>
  );
}
