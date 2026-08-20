import { useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, X, Copy, ShieldCheck } from 'lucide-react';
import { notify } from '../../lib/notify';
import { publicOrigin } from '../../lib/origin';
import {
  APEX_CONSENT, APEX_TOKEN, CLAUDE_ADD_DIALOG, CLAUDE_CHAT, CLAUDE_CONNECTORS,
  GPT_CHAT, GPT_CREATE, GPT_DEVELOPER_MODE, type FigureSpec,
} from './ConnectorFigures';

// The in-app companion to CONNECTORS.md, written for someone who has never
// heard of MCP and does not want to. It opens from the help icon on the
// profile's AI connector section and replaces the profile body, the same way
// ExerciseDetail replaces the library list.

interface Props {
  onBack: () => void;
  onClose: () => void;
}

type Client = 'claude' | 'chatgpt' | 'code' | 'other';

const CLIENTS: { id: Client; label: string; blurb: string }[] = [
  { id: 'claude', label: 'Claude', blurb: 'The Claude app or claude.ai' },
  { id: 'chatgpt', label: 'ChatGPT', blurb: 'chatgpt.com, paid plans' },
  { id: 'code', label: 'Claude Code', blurb: 'The terminal tool' },
  { id: 'other', label: 'Something else', blurb: 'Any other MCP app' },
];

function Figure({ spec }: { spec: FigureSpec }) {
  return (
    <figure className="cg-figure">
      <div className="cg-figure__frame">
        <svg viewBox="0 0 640 400" className="cg-figure__svg" role="img" aria-labelledby={`${spec.id}-title`}>
          <title id={`${spec.id}-title`}>{spec.title}</title>
          <spec.Svg />
        </svg>
      </div>
      <figcaption className="cg-figure__caption">
        <p className="cg-figure__title">{spec.title}</p>
        <ol className="cg-figure__pins">
          {spec.pins.map((pin, i) => (
            <li key={i}>
              <span className="cg-figure__pin" aria-hidden="true">{i + 1}</span>
              <span>{pin}</span>
            </li>
          ))}
        </ol>
        {spec.note && <p className="cg-figure__note">{spec.note}</p>}
      </figcaption>
    </figure>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="cg-step">
      <h4 className="cg-step__head">
        <span className="cg-step__n" aria-hidden="true">{n}</span>
        {title}
      </h4>
      <div className="cg-step__body">{children}</div>
    </section>
  );
}

export default function ConnectorGuide({ onBack, onClose }: Props) {
  const [client, setClient] = useState<Client>('claude');
  const endpointUrl = `${publicOrigin()}/api/mcp`;

  const copy = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify(message);
    } catch {
      notify('Copy failed');
    }
  };

  return (
    <div className="profile-view">
      <header className="library-header">
        <div className="library-header__titles">
          <button className="library-back" onClick={onBack} aria-label="Back to profile">
            <ArrowLeft size={16} strokeWidth={1.5} />
          </button>
          <h1 className="library-header__title">Connecting an AI assistant</h1>
        </div>
        <div className="library-header__actions">
          <button className="library-close" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
      </header>

      <div className="profile-body cg-body">
        <section className="cg-intro">
          <p>
            This connects your Apex training log to an AI assistant, so you can
            ask about your own training in plain English — <em>“How did my squat
            progress this block?”</em>, <em>“What&apos;s on my calendar this
            week?”</em>, <em>“Any PRs last month?”</em> — and get answers from
            your real numbers instead of guesses.
          </p>
          <p>
            Setting it up means giving the assistant one web address and signing
            in once to prove the account is yours. It takes about two minutes.
            There is nothing to install and no code to write.
          </p>
          <div className="cg-callout cg-callout--safe">
            <ShieldCheck size={16} strokeWidth={1.6} />
            <div>
              <strong>The assistant can only read.</strong> It can look at your
              workouts, schedule, meals and records. It cannot add, change or
              delete anything — not a workout, not a meal, not a single set. You
              can cut off its access at any moment from the AI connector section
              you just came from.
            </div>
          </div>
        </section>

        <section className="cg-section">
          <h3 className="profile-section__title">Step one, whichever app you use</h3>
          <p className="cg-p">
            Every app needs the same thing first: your Apex address. Copy it
            now and paste it when the app asks for a <em>server URL</em>.
          </p>
          <div className="profile-feed">
            <input className="auth-input profile-feed__url" value={endpointUrl} readOnly aria-label="Your Apex server address" />
            <button className="btn-today" onClick={() => copy(endpointUrl, 'Address copied')} title="Copy your Apex address">
              <Copy size={14} strokeWidth={1.5} />
            </button>
          </div>
          <p className="cg-p cg-p--muted">
            Treat this address as public — it is useless to anyone who cannot
            sign in as you. The sign-in step is what grants access, not the
            address.
          </p>
        </section>

        <section className="cg-section">
          <h3 className="profile-section__title">Which app are you setting up?</h3>
          <div className="cg-tabs" role="tablist" aria-label="Choose your app">
            {CLIENTS.map(c => (
              <button
                key={c.id}
                role="tab"
                aria-selected={client === c.id}
                className={`cg-tab${client === c.id ? ' cg-tab--active' : ''}`}
                onClick={() => setClient(c.id)}
              >
                <span className="cg-tab__label">{c.label}</span>
                <span className="cg-tab__blurb">{c.blurb}</span>
              </button>
            ))}
          </div>
          <p className="cg-p cg-p--muted">
            The pictures below are drawings of Claude and ChatGPT, not
            photographs. Both apps change often, so a button may sit an inch from
            where it appears here — the wording is what to look for.
          </p>
        </section>

        {client === 'claude' && (
          <div className="cg-steps">
            <Step n={1} title="Open Claude's connector settings">
              <p className="cg-p">
                In the Claude desktop app, open <strong>Settings</strong> — under
                the <strong>Claude</strong> menu at the top of the screen on a
                Mac, or the <strong>☰</strong> menu on Windows. On the website,
                click your name in the bottom-left corner and choose{' '}
                <strong>Settings</strong>. Then pick <strong>Connectors</strong>.
              </p>
              <Figure spec={CLAUDE_CONNECTORS} />
            </Step>

            <Step n={2} title="Add the Apex address">
              <p className="cg-p">
                Click <strong>Add custom connector</strong>, paste the address
                you copied above, and — this is the important part —{' '}
                <strong>leave the OAuth boxes empty</strong>.
              </p>
              <Figure spec={CLAUDE_ADD_DIALOG} />
              <div className="cg-callout">
                <div>
                  <strong>Why are those boxes empty?</strong> Some services make
                  you register by hand and email you a pair of secret codes.
                  Apex does not. When Claude first knocks on the door, Apex hands
                  it a set of credentials automatically. Typing anything into
                  those boxes will break the connection.
                </div>
              </div>
            </Step>

            <Step n={3} title="Sign in to Apex and allow it">
              <p className="cg-p">
                Claude opens your web browser at an Apex page asking whether to
                allow the connection. Sign in with your normal Apex email and
                password if you are not already signed in, then click{' '}
                <strong>Allow</strong>. You are handed back to Claude, and that
                is the whole setup.
              </p>
              <Figure spec={APEX_CONSENT} />
            </Step>

            <Step n={4} title="Switch it on in a conversation">
              <p className="cg-p">
                Claude does not use a connector until you turn it on for that
                chat. Open a new conversation, click the <strong>+</strong>{' '}
                button in the message box, and switch on{' '}
                <strong>Apex Training</strong>.
              </p>
              <Figure spec={CLAUDE_CHAT} />
              <p className="cg-p">
                Now ask it something. A good first question is{' '}
                <em>“Using Apex, what did I train last week?”</em> — naming Apex
                nudges it to actually look rather than answer from memory. The
                first time it reaches for your data it will ask your permission;
                say yes.
              </p>
            </Step>
          </div>
        )}

        {client === 'chatgpt' && (
          <div className="cg-steps">
            <div className="cg-callout">
              <div>
                <strong>Before you start:</strong> custom connectors in ChatGPT
                need a paid plan — Plus, Pro, Business, Enterprise or Edu. On the
                free plan the options below will not appear, and there is no way
                around that from the Apex side.
              </div>
            </div>

            <Step n={1} title="Turn on developer mode">
              <p className="cg-p">
                Open <strong>Settings → Apps &amp; Connectors → Advanced
                settings</strong> and switch on <strong>Developer mode</strong>.
                The name sounds alarming; all it does is let you add a connector
                that is not in ChatGPT&apos;s official list. It changes nothing
                else about your account.
              </p>
              <Figure spec={GPT_DEVELOPER_MODE} />
            </Step>

            <Step n={2} title="Create the Apex connector">
              <p className="cg-p">
                Back on <strong>Settings → Apps &amp; Connectors</strong>, click{' '}
                <strong>Create</strong>. Give it a name, paste your Apex address,
                choose <strong>OAuth</strong> for authentication, and leave any
                client ID or secret boxes empty — same reason as in Claude:
                ChatGPT and Apex sort that out between themselves.
              </p>
              <Figure spec={GPT_CREATE} />
            </Step>

            <Step n={3} title="Sign in to Apex and allow it">
              <p className="cg-p">
                ChatGPT sends you to an Apex page asking whether to allow the
                connection. Check the web address really is your Apex site, sign
                in, and click <strong>Allow</strong>.
              </p>
              <Figure spec={APEX_CONSENT} />
            </Step>

            <Step n={4} title="Switch it on in a conversation">
              <p className="cg-p">
                In a chat, open the <strong>+</strong> or{' '}
                <strong>Tools</strong> menu in the message box and enable{' '}
                <strong>Apex Training</strong>, then ask your question.
              </p>
              <Figure spec={GPT_CHAT} />
              <div className="cg-callout">
                <div>
                  <strong>Deep research is different.</strong> ChatGPT&apos;s
                  deep-research mode only accepts connectors built in one
                  specific shape, which Apex is not. Apex works in normal chat;
                  it will not show up as a deep-research source.
                </div>
              </div>
            </Step>
          </div>
        )}

        {client === 'code' && (
          <div className="cg-steps">
            <p className="cg-p">
              Claude Code can do the same browser sign-in as the Claude app, but
              it also accepts an <em>access token</em> — a long password you
              create here and paste into a command. Tokens are handy on a
              machine where opening a browser is awkward.
            </p>

            <Step n={1} title="Create a token in Apex">
              <p className="cg-p">
                Go back one screen to <strong>AI connector</strong>, type a name
                for the token, and click <strong>Create token</strong>. Copy the
                result straight away — Apex keeps only a scrambled copy and can
                never show it to you again.
              </p>
              <Figure spec={APEX_TOKEN} />
            </Step>

            <Step n={2} title="Add Apex to Claude Code">
              <p className="cg-p">
                Run this in a terminal, replacing <code>apx_…</code> with the
                token you just copied:
              </p>
              <pre className="cg-code">{`claude mcp add --transport http apex \\
  ${endpointUrl} \\
  --header "Authorization: Bearer apx_..."`}</pre>
              <button className="btn-today cg-copy" onClick={() => copy(`claude mcp add --transport http apex ${endpointUrl} --header "Authorization: Bearer apx_..."`, 'Command copied')}>
                <Copy size={13} strokeWidth={1.5} /> Copy command
              </button>
              <p className="cg-p">
                Prefer the browser sign-in? Leave the header off —{' '}
                <code>claude mcp add --transport http apex {endpointUrl}</code> —
                then type <code>/mcp</code> inside Claude Code and follow the
                prompts.
              </p>
            </Step>

            <Step n={3} title="Check it worked">
              <p className="cg-p">
                Type <code>/mcp</code> in Claude Code. Apex should be listed as
                connected. Then ask it something like{' '}
                <em>“what&apos;s my best bench press?”</em>
              </p>
            </Step>
          </div>
        )}

        {client === 'other' && (
          <div className="cg-steps">
            <p className="cg-p">
              Any app that speaks MCP over the web will work. There are two
              shapes it might take:
            </p>
            <Step n={1} title="If the app can sign you in">
              <p className="cg-p">
                Give it the Apex address and nothing else. It will discover how
                to authenticate on its own and send you to the Apex permission
                page.
              </p>
            </Step>
            <Step n={2} title="If the app only accepts a token">
              <p className="cg-p">
                Create a token on the previous screen and have the app send it as
                a header:
              </p>
              <pre className="cg-code">{'Authorization: Bearer apx_...'}</pre>
            </Step>
            <Step n={3} title="If the app cannot do either">
              <p className="cg-p">
                Older apps that only run local programs can be bridged. With
                Node.js installed:
              </p>
              <pre className="cg-code">{`npx mcp-remote ${endpointUrl} \\
  --header "Authorization: Bearer apx_..."`}</pre>
            </Step>
          </div>
        )}

        <section className="cg-section">
          <h3 className="profile-section__title">What you can ask it</h3>
          <p className="cg-p">
            You never have to name a tool or learn any syntax — ask the question
            you would ask a coach. Behind the scenes the assistant picks from
            these:
          </p>
          <ul className="cg-asks">
            <li><em>“What&apos;s planned this week?”</em><span>Your schedule, and what you have already ticked off</span></li>
            <li><em>“How did Tuesday&apos;s session go?”</em><span>The full workout with every set you logged</span></li>
            <li><em>“Is my bench pressing progressing?”</em><span>One exercise over time, best ever and recent trend</span></li>
            <li><em>“Any records lately?”</em><span>PRs, all-time or within a stretch of time, and what they beat</span></li>
            <li><em>“Summarise July.”</em><span>Sessions, tonnage, distance, elevation, streaks</span></li>
            <li><em>“Am I on target this block?”</em><span>Training blocks and how attainment is tracking</span></li>
            <li><em>“How was my protein this week?”</em><span>Meals with daily totals</span></li>
          </ul>
          <p className="cg-p cg-p--muted">
            Every number — estimated one-rep maxes, tonnage, streaks — is worked
            out by Apex itself using the same code the app screens use. The
            assistant repeats those figures rather than doing its own arithmetic,
            so what it tells you matches what you see here.
          </p>
        </section>

        <section className="cg-section">
          <h3 className="profile-section__title">Turning it off again</h3>
          <p className="cg-p">
            Everything is reversible from the <strong>AI connector</strong>{' '}
            section on the previous screen:
          </p>
          <ul className="cg-list">
            <li>
              <strong>Connected apps</strong> — each app that signed in is listed
              with an <strong>✕</strong> beside it. Clicking it cuts that app off
              immediately and completely.
            </li>
            <li>
              <strong>Access tokens</strong> — listed by the name you gave them,
              with the last four characters so you can tell them apart. Revoking
              one stops it working at once.
            </li>
            <li>
              Inside Claude, the connector&apos;s own settings also let you block
              individual abilities, and Claude asks before using each one for the
              first time in a conversation.
            </li>
          </ul>
        </section>

        <section className="cg-section">
          <h3 className="profile-section__title">If something isn&apos;t working</h3>
          <ul className="cg-faq">
            <li>
              <p><strong>The assistant says it can&apos;t see any training data.</strong></p>
              <p>
                Nine times out of ten the connector is simply switched off for
                that conversation. Open the <strong>+</strong> menu in the
                message box and check the toggle. Starting a fresh chat and
                turning it on there also works.
              </p>
            </li>
            <li>
              <p><strong>It answers with numbers that look invented.</strong></p>
              <p>
                Ask it to check Apex again, by name. Assistants will happily
                answer from what they remember earlier in the conversation rather
                than looking things up a second time.
              </p>
            </li>
            <li>
              <p><strong>Adding the connector fails, or sign-in never starts.</strong></p>
              <p>
                Check the address you pasted ends in <code>/api/mcp</code> with
                no trailing slash and no spaces, and that you left the OAuth
                boxes empty. If it still fails, the site itself may not be
                reachable — open your Apex address in a browser tab and make sure
                the app loads.
              </p>
            </li>
            <li>
              <p><strong>It worked yesterday and stopped today.</strong></p>
              <p>
                Check the <strong>AI connector</strong> section: if the app is no
                longer in <strong>Connected apps</strong>, someone disconnected
                it — just set it up again. If you were using a token, it may have
                been revoked.
              </p>
            </li>
            <li>
              <p><strong>It complains about being rate limited.</strong></p>
              <p>
                There is a ceiling of 300 requests an hour on your account, which
                normal conversation never approaches. Wait a few minutes.
              </p>
            </li>
          </ul>
        </section>

        <section className="cg-section">
          <h3 className="profile-section__title">The words these apps use</h3>
          <dl className="cg-glossary">
            <dt>Connector</dt>
            <dd>The link between an assistant and an outside service. Apex is one connector among however many you add.</dd>
            <dt>MCP server</dt>
            <dd>The technical name for the thing at the end of your Apex address. When an app asks for an “MCP server URL”, it wants that address.</dd>
            <dt>OAuth</dt>
            <dd>The sign-in dance that lets you approve an app without ever giving it your password. It is what the Allow screen is doing.</dd>
            <dt>Access token</dt>
            <dd>A long password-like string that stands in for signing in, for tools that cannot open a browser. Anyone holding it can read your training data, so treat it like a password.</dd>
            <dt>Read-only</dt>
            <dd>The connection can look but not touch. Everything Apex offers through it is read-only.</dd>
          </dl>
        </section>

        <section className="cg-section">
          <button className="auth-submit cg-done" onClick={onBack}>Back to AI connector</button>
        </section>
      </div>
    </div>
  );
}
