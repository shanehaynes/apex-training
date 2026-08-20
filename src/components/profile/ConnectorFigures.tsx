import type { ReactNode } from 'react';

// Annotated illustrations of the Claude and ChatGPT screens the connector
// guide walks through. These are drawings rather than captures: they carry no
// personal account data, stay crisp at any width, and can be corrected in a
// diff when either vendor moves a button. Callout numbers live in the drawing;
// the text explaining each one lives in `pins` and is rendered as real HTML
// beneath the figure, so it stays selectable, searchable, and screen-readable.

const FONT = 'Inter, system-ui, sans-serif';
const MONO = 'JetBrains Mono, monospace';

// A deliberately light palette: these figures depict *other* applications, so
// they read as pictures-of-a-window sitting on Apex's dark chrome.
const C = {
  frame: '#cfc8bf',
  chrome: '#f7f5f2',
  surface: '#ffffff',
  sidebar: '#efebe5',
  line: '#e3ded7',
  text: '#1f1d1b',
  dim: '#6f6963',
  faint: '#b3aca5',
  claude: '#c96442',
  gpt: '#0d8a6a',
  mark: '#e0803f',
};

export interface FigureSpec {
  id: string;
  title: string;
  /** Rendered under the figure, after the numbered callouts. */
  note?: string;
  pins: string[];
  Svg: () => ReactNode;
}

/* ---------- shared drawing primitives ---------- */

function Chrome({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <>
      <rect x={0.5} y={0.5} width={639} height={399} rx={10} fill={C.chrome} stroke={C.frame} />
      <path d="M0 34 H640" stroke={C.line} />
      <circle cx={22} cy={17} r={5} fill="#e0796d" />
      <circle cx={40} cy={17} r={5} fill="#e3c169" />
      <circle cx={58} cy={17} r={5} fill="#86c78a" />
      {label && (
        <text x={320} y={21} textAnchor="middle" fontSize={12} fontWeight={600} fill={C.dim} fontFamily={FONT}>
          {label}
        </text>
      )}
      {children}
    </>
  );
}

/** Dashed highlight around the control a step refers to. */
function Mark({ x, y, w, h, r = 7 }: { x: number; y: number; w: number; h: number; r?: number }) {
  return <rect x={x} y={y} width={w} height={h} rx={r} fill="none" stroke={C.mark} strokeWidth={2} strokeDasharray="5 4" />;
}

function Pin({ x, y, n }: { x: number; y: number; n: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={11} fill={C.mark} stroke={C.chrome} strokeWidth={2} />
      <text x={x} y={y + 4.5} textAnchor="middle" fontSize={12} fontWeight={700} fill="#fff" fontFamily={FONT}>
        {n}
      </text>
    </g>
  );
}

function T({ x, y, children, size = 12, fill = C.text, weight = 400, anchor, mono }: {
  x: number; y: number; children: ReactNode; size?: number; fill?: string;
  weight?: number; anchor?: 'middle' | 'end'; mono?: boolean;
}) {
  return (
    <text x={x} y={y} fontSize={size} fill={fill} fontWeight={weight} textAnchor={anchor} fontFamily={mono ? MONO : FONT}>
      {children}
    </text>
  );
}

function Field({ x, y, w, value, placeholder }: { x: number; y: number; w: number; value?: string; placeholder?: string }) {
  return (
    <>
      <rect x={x} y={y} width={w} height={30} rx={6} fill={C.surface} stroke={C.line} />
      <T x={x + 10} y={y + 19} size={11} fill={value ? C.text : C.faint} mono={!!value}>
        {value ?? placeholder}
      </T>
    </>
  );
}

function Button({ x, y, w, label, fill = C.claude, color = '#fff' }: {
  x: number; y: number; w: number; label: string; fill?: string; color?: string;
}) {
  return (
    <>
      <rect x={x} y={y} width={w} height={30} rx={8} fill={fill} />
      <T x={x + w / 2} y={y + 19} size={11.5} weight={600} fill={color} anchor="middle">{label}</T>
    </>
  );
}

function SidebarItem({ y, label, active }: { y: number; label: string; active?: boolean }) {
  return (
    <>
      {active && <rect x={14} y={y} width={140} height={28} rx={7} fill={C.surface} />}
      <T x={28} y={y + 19} size={11.5} weight={active ? 600 : 400} fill={active ? C.text : C.dim}>{label}</T>
    </>
  );
}

/** Grey filler bars standing in for list content the step doesn't care about. */
function Ghost({ x, y, w, h = 8 }: { x: number; y: number; w: number; h?: number }) {
  return <rect x={x} y={y} width={w} height={h} rx={h / 2} fill={C.line} />;
}

function Toggle({ x, y, on }: { x: number; y: number; on: boolean }) {
  return (
    <>
      <rect x={x} y={y} width={34} height={20} rx={10} fill={on ? C.gpt : C.line} />
      <circle cx={on ? x + 24 : x + 10} cy={y + 10} r={7} fill="#fff" />
    </>
  );
}

/* ---------- Claude ---------- */

function ClaudeConnectorsSvg() {
  return (
    <Chrome label="Claude — Settings">
      <rect x={1} y={34} width={169} height={365} fill={C.sidebar} />
      <path d="M170 34 V400" stroke={C.line} />
      <T x={28} y={58} size={10} weight={700} fill={C.faint}>SETTINGS</T>
      <SidebarItem y={68} label="Profile" />
      <SidebarItem y={100} label="Appearance" />
      <SidebarItem y={132} label="Extensions" />
      <SidebarItem y={164} label="Connectors" active />
      <SidebarItem y={196} label="Privacy" />
      <SidebarItem y={228} label="Account" />

      <T x={200} y={78} size={19} weight={700}>Connectors</T>
      <T x={200} y={100} size={11.5} fill={C.dim}>Connect Claude to the apps and data you already use.</T>

      <Button x={200} y={124} w={186} label="+  Add custom connector" />

      <T x={200} y={182} size={10} weight={700} fill={C.faint}>YOUR CONNECTORS</T>
      <rect x={200} y={194} width={410} height={48} rx={9} fill={C.surface} stroke={C.line} />
      <circle cx={226} cy={218} r={12} fill={C.line} />
      <Ghost x={250} y={208} w={120} />
      <Ghost x={250} y={224} w={190} h={6} />
      <rect x={200} y={252} width={410} height={48} rx={9} fill={C.surface} stroke={C.line} />
      <circle cx={226} cy={276} r={12} fill={C.line} />
      <Ghost x={250} y={266} w={90} />
      <Ghost x={250} y={282} w={160} h={6} />

      <Mark x={12} y={162} w={144} h={32} />
      <Mark x={196} y={120} w={194} h={38} />
      <Pin x={20} y={160} n={1} />
      <Pin x={204} y={118} n={2} />
    </Chrome>
  );
}

export const CLAUDE_CONNECTORS: FigureSpec = {
  id: 'claude-connectors',
  title: "Claude's Settings window, Connectors tab",
  note: 'On a Team or Enterprise plan this page may be read-only — an organization Owner has to add the connector under Organization settings → Connectors first.',
  pins: [
    'Open Settings, then click Connectors in the left-hand list. In Claude Desktop, Settings is under the Claude menu (Mac) or the ☰ menu (Windows); on claude.ai, click your name in the bottom-left corner.',
    'Click Add custom connector. "Custom" simply means a connector that is not in Claude\'s built-in directory — Apex is yours, so it will always be a custom one.',
  ],
  Svg: ClaudeConnectorsSvg,
};

function ClaudeAddDialogSvg() {
  return (
    <Chrome label="Claude — Settings">
      <rect x={1} y={34} width={638} height={365} fill={C.sidebar} opacity={0.55} />
      <rect x={110} y={58} width={420} height={306} rx={12} fill={C.chrome} stroke={C.frame} />

      <T x={136} y={90} size={15} weight={700}>Add custom connector</T>
      <T x={136} y={110} size={11} fill={C.dim}>Connect Claude to a remote MCP server.</T>

      <T x={136} y={140} size={10.5} weight={600} fill={C.dim}>Name</T>
      <Field x={136} y={148} w={368} value="Apex Training" />

      <T x={136} y={196} size={10.5} weight={600} fill={C.dim}>Remote MCP server URL</T>
      <Field x={136} y={204} w={368} value="https://…/api/mcp" />

      <path d="M136 254 H504" stroke={C.line} />
      <T x={136} y={276} size={11} weight={600} fill={C.dim}>▸  Advanced settings</T>
      <T x={136} y={296} size={10.5} fill={C.faint}>OAuth Client ID</T>
      <Field x={136} y={302} w={178} placeholder="(leave empty)" />
      <T x={326} y={296} size={10.5} fill={C.faint}>OAuth Client Secret</T>
      <Field x={326} y={302} w={178} placeholder="(leave empty)" />

      <Button x={404} y={344} w={100} label="Add" />
      <T x={378} y={363} size={11.5} fill={C.dim} anchor="end">Cancel</T>

      <Mark x={132} y={200} w={376} h={38} />
      <Mark x={130} y={286} w={380} h={52} />
      <Mark x={400} y={340} w={108} h={38} />
      {/* Pinned at the top-right of each mark: the top-left corner sits on the
          field's own label and swallows the first few characters. */}
      <Pin x={506} y={200} n={1} />
      <Pin x={508} y={286} n={2} />
      <Pin x={506} y={340} n={3} />
    </Chrome>
  );
}

export const CLAUDE_ADD_DIALOG: FigureSpec = {
  id: 'claude-add-dialog',
  title: 'The "Add custom connector" dialog',
  pins: [
    'Paste your Apex server URL here — the copy button at the top of this guide puts it on your clipboard. Give it any name you like; "Apex Training" is a good one.',
    'Leave the OAuth Client ID and Client Secret boxes completely empty. This is the step people most often get wrong. Those boxes are for servers that hand out credentials by email; Apex does not. Claude finds what it needs on its own and introduces itself automatically.',
    'Click Add. Claude saves the connector and shows a Connect button next to it — click that too.',
  ],
  Svg: ClaudeAddDialogSvg,
};

function ApexConsentSvg() {
  return (
    <Chrome>
      <rect x={16} y={48} width={608} height={28} rx={14} fill={C.surface} stroke={C.line} />
      <circle cx={38} cy={62} r={5} fill="none" stroke={C.dim} strokeWidth={1.5} />
      <T x={54} y={66} size={11} mono fill={C.dim}>your-apex-site.vercel.app/connect</T>

      <rect x={150} y={110} width={340} height={250} rx={14} fill={C.surface} stroke={C.line} />
      <circle cx={320} cy={152} r={18} fill={C.claude} opacity={0.15} />
      <T x={320} y={158} size={16} anchor="middle" fill={C.claude} weight={700}>A</T>
      <T x={320} y={192} size={14} weight={700} anchor="middle">Claude wants to connect</T>
      <T x={320} y={212} size={11} fill={C.dim} anchor="middle">Signed in as you@example.com</T>

      <T x={182} y={244} size={11} fill={C.text}>✓  Read your workouts, schedule and PRs</T>
      <T x={182} y={266} size={11} fill={C.text}>✓  Read your meals and training blocks</T>
      <T x={182} y={288} size={11} fill={C.dim}>✕  Cannot change or delete anything</T>

      <Button x={182} y={314} w={130} label="Allow" />
      <rect x={328} y={314} width={130} height={30} rx={8} fill={C.surface} stroke={C.line} />
      <T x={393} y={333} size={11.5} weight={600} fill={C.dim} anchor="middle">Deny</T>

      <Mark x={12} y={44} w={616} h={36} r={18} />
      <Mark x={178} y={310} w={138} h={38} />
      <Pin x={20} y={42} n={1} />
      <Pin x={186} y={308} n={2} />
    </Chrome>
  );
}

export const APEX_CONSENT: FigureSpec = {
  id: 'apex-consent',
  title: 'The Apex permission screen, in your web browser',
  note: 'This screen is served by Apex itself, which is why it asks you to sign in with your Apex email and password — never your Claude or ChatGPT password.',
  pins: [
    'Check the web address before typing anything. It must be your own Apex site. If the address is anything else, close the tab: no legitimate connector will ever ask for your Apex password on another domain.',
    'Click Allow. The browser hands you back to Claude and the connector turns on. Nothing is shared until you click this.',
  ],
  Svg: ApexConsentSvg,
};

function ClaudeChatSvg() {
  return (
    <Chrome label="Claude">
      {/* A little conversation behind the popup, so the frame reads as a chat. */}
      <rect x={330} y={58} width={180} height={30} rx={12} fill={C.sidebar} />
      <Ghost x={348} y={70} w={144} h={6} />
      <Ghost x={140} y={110} w={300} h={7} />
      <Ghost x={140} y={128} w={264} h={7} />
      <Ghost x={140} y={146} w={188} h={7} />

      <rect x={140} y={186} width={360} height={168} rx={12} fill={C.surface} stroke={C.line} />
      <T x={158} y={210} size={10} weight={700} fill={C.faint}>CONNECTORS</T>
      <rect x={150} y={222} width={340} height={36} rx={8} fill={C.chrome} />
      <circle cx={172} cy={240} r={9} fill={C.claude} opacity={0.2} />
      <T x={192} y={244} size={11.5} weight={600}>Apex Training</T>
      <Toggle x={444} y={230} on />
      <circle cx={172} cy={282} r={9} fill={C.line} />
      <Ghost x={192} y={278} w={110} />
      <Toggle x={444} y={272} on={false} />
      <circle cx={172} cy={324} r={9} fill={C.line} />
      <Ghost x={192} y={320} w={86} />
      <Toggle x={444} y={314} on={false} />

      <rect x={140} y={366} width={360} height={0} fill="none" />
      <rect x={120} y={362} width={400} height={34} rx={17} fill={C.surface} stroke={C.line} />
      <circle cx={142} cy={379} r={11} fill={C.chrome} stroke={C.line} />
      <T x={142} y={384} size={14} anchor="middle" fill={C.dim}>+</T>
      <T x={164} y={383} size={11} fill={C.faint}>How did my squat progress this block?</T>

      <Mark x={128} y={366} w={30} h={26} r={13} />
      <Mark x={146} y={218} w={348} h={44} />
      <Pin x={132} y={364} n={1} />
      <Pin x={492} y={216} n={2} />
    </Chrome>
  );
}

export const CLAUDE_CHAT: FigureSpec = {
  id: 'claude-chat',
  title: 'Turning the connector on inside a conversation',
  note: 'Claude asks permission the first time it uses each tool in a conversation. Answering "Allow for this chat" is enough — everything Apex exposes is read-only.',
  pins: [
    'In the message box, click the + button (in some versions it is labelled "Tools" or shown as a slider icon).',
    'Switch Apex Training on. This is per-conversation, so if a new chat says it cannot see your training data, this switch is almost always the reason.',
  ],
  Svg: ClaudeChatSvg,
};

/* ---------- ChatGPT ---------- */

function GptDeveloperModeSvg() {
  return (
    <Chrome label="ChatGPT — Settings">
      <rect x={1} y={34} width={169} height={365} fill={C.sidebar} />
      <path d="M170 34 V400" stroke={C.line} />
      <SidebarItem y={56} label="General" />
      <SidebarItem y={88} label="Notifications" />
      <SidebarItem y={120} label="Personalization" />
      <SidebarItem y={152} label="Apps & Connectors" active />
      <SidebarItem y={184} label="Data controls" />
      <SidebarItem y={216} label="Security" />

      <T x={200} y={70} size={17} weight={700}>Apps &amp; Connectors</T>

      <rect x={200} y={92} width={410} height={46} rx={9} fill={C.surface} stroke={C.line} />
      <Ghost x={218} y={106} w={100} />
      <Ghost x={218} y={122} w={170} h={6} />
      <T x={592} y={121} size={12} fill={C.faint} anchor="end">›</T>

      <rect x={200} y={148} width={410} height={46} rx={9} fill={C.surface} stroke={C.line} />
      <T x={218} y={168} size={11.5} weight={600}>Advanced settings</T>
      <T x={218} y={184} size={10} fill={C.dim}>Developer mode, connector permissions</T>
      <T x={592} y={177} size={12} fill={C.faint} anchor="end">›</T>

      <rect x={200} y={218} width={410} height={70} rx={9} fill={C.surface} stroke={C.line} />
      <T x={218} y={244} size={11.5} weight={600}>Developer mode</T>
      <T x={218} y={262} size={10} fill={C.dim}>Add and test custom MCP connectors.</T>
      <Toggle x={556} y={242} on />

      <T x={200} y={318} size={10.5} fill={C.faint}>Requires a paid ChatGPT plan (Plus, Pro, Business, Enterprise or Edu).</T>

      <Mark x={12} y={150} w={144} h={32} />
      <Mark x={196} y={144} w={418} h={54} />
      <Mark x={550} y={236} w={46} h={32} r={16} />
      <Pin x={20} y={148} n={1} />
      <Pin x={610} y={144} n={2} />
      <Pin x={556} y={234} n={3} />
    </Chrome>
  );
}

export const GPT_DEVELOPER_MODE: FigureSpec = {
  id: 'gpt-developer-mode',
  title: 'Switching on ChatGPT\'s developer mode',
  note: 'On Business and Enterprise workspaces an administrator can disable developer mode for everyone. If the switch is missing or greyed out, that is why — ask whoever manages your workspace.',
  pins: [
    'Open Settings → Apps & Connectors.',
    'Open Advanced settings at the bottom of that page.',
    'Turn Developer mode on. Without it, ChatGPT has no way to add a connector that is not in its official directory. It only affects your own account.',
  ],
  Svg: GptDeveloperModeSvg,
};

function GptCreateSvg() {
  return (
    <Chrome label="ChatGPT — Settings">
      <rect x={1} y={34} width={638} height={365} fill={C.sidebar} opacity={0.55} />
      <rect x={110} y={52} width={420} height={318} rx={12} fill={C.chrome} stroke={C.frame} />

      <T x={136} y={84} size={15} weight={700}>New connector</T>

      <T x={136} y={112} size={10.5} weight={600} fill={C.dim}>Name</T>
      <Field x={136} y={120} w={368} value="Apex Training" />

      <T x={136} y={170} size={10.5} weight={600} fill={C.dim}>MCP Server URL</T>
      <Field x={136} y={178} w={368} value="https://…/api/mcp" />

      <T x={136} y={228} size={10.5} weight={600} fill={C.dim}>Authentication</T>
      <rect x={136} y={236} width={178} height={30} rx={6} fill={C.surface} stroke={C.line} />
      <T x={148} y={255} size={11}>OAuth</T>
      <T x={300} y={255} size={11} fill={C.dim} anchor="end">▾</T>

      <rect x={136} y={286} width={14} height={14} rx={3} fill={C.gpt} />
      <path d="M139.5 293 l3 3 l5.5 -6" stroke="#fff" strokeWidth={1.8} fill="none" />
      <T x={158} y={298} size={10.5} fill={C.dim}>I trust this application.</T>

      <Button x={404} y={324} w={100} label="Create" fill={C.gpt} />

      <Mark x={132} y={174} w={376} h={38} />
      <Mark x={132} y={232} w={186} h={38} />
      <Mark x={400} y={320} w={108} h={38} />
      <Pin x={506} y={176} n={1} />
      <Pin x={316} y={234} n={2} />
      <Pin x={506} y={322} n={3} />
    </Chrome>
  );
}

export const GPT_CREATE: FigureSpec = {
  id: 'gpt-create',
  title: 'Creating the Apex connector in ChatGPT',
  pins: [
    'Paste your Apex server URL and give the connector a name.',
    'Set Authentication to OAuth, and leave any client ID or client secret boxes empty — ChatGPT introduces itself to Apex automatically, exactly as Claude does. Tick the "I trust this application" box; you are trusting your own Apex site.',
    'Click Create. ChatGPT sends you to the Apex permission screen shown above — sign in and click Allow.',
  ],
  Svg: GptCreateSvg,
};

function GptChatSvg() {
  return (
    <Chrome label="ChatGPT">
      <rect x={330} y={56} width={180} height={30} rx={12} fill={C.sidebar} />
      <Ghost x={348} y={68} w={144} h={6} />
      <Ghost x={150} y={108} w={290} h={7} />
      <Ghost x={150} y={126} w={250} h={7} />

      <rect x={150} y={170} width={340} height={162} rx={12} fill={C.surface} stroke={C.line} />
      <T x={168} y={194} size={10} weight={700} fill={C.faint}>APPS &amp; CONNECTORS</T>
      <rect x={160} y={206} width={320} height={36} rx={8} fill={C.chrome} />
      <circle cx={182} cy={224} r={9} fill={C.gpt} opacity={0.25} />
      <T x={202} y={228} size={11.5} weight={600}>Apex Training</T>
      <Toggle x={436} y={214} on />
      <circle cx={182} cy={266} r={9} fill={C.line} />
      <Ghost x={202} y={262} w={104} />
      <Toggle x={436} y={256} on={false} />
      <circle cx={182} cy={306} r={9} fill={C.line} />
      <Ghost x={202} y={302} w={84} />
      <Toggle x={436} y={296} on={false} />

      <rect x={130} y={344} width={380} height={34} rx={17} fill={C.surface} stroke={C.line} />
      <circle cx={152} cy={361} r={11} fill={C.chrome} stroke={C.line} />
      <T x={152} y={366} size={14} anchor="middle" fill={C.dim}>+</T>
      <T x={174} y={365} size={11} fill={C.faint}>Any PRs last month?</T>

      <Mark x={138} y={348} w={30} h={26} r={13} />
      <Mark x={156} y={202} w={328} h={44} />
      <Pin x={142} y={346} n={1} />
      <Pin x={482} y={200} n={2} />
    </Chrome>
  );
}

export const GPT_CHAT: FigureSpec = {
  id: 'gpt-chat',
  title: 'Turning the connector on inside a ChatGPT conversation',
  pins: [
    'In the message box, click + (or the Tools button, depending on your version).',
    'Switch Apex Training on for this conversation, then ask your question.',
  ],
  Svg: GptChatSvg,
};

/* ---------- Apex itself ---------- */

function ApexTokenSvg() {
  return (
    <Chrome label="Apex Training — Profile">
      <rect x={1} y={34} width={638} height={365} fill="#0d0c0b" />
      <T x={40} y={78} size={10} weight={700} fill="#8a7f7c">AI CONNECTOR</T>
      <T x={40} y={102} size={11.5} fill="#a09590">Query your training data from Claude or ChatGPT.</T>

      <rect x={40} y={120} width={430} height={30} rx={6} fill="#161412" stroke="#2e2a25" />
      <T x={52} y={139} size={10.5} mono fill="#f1f5f9">https://your-apex-site.vercel.app/api/mcp</T>
      <rect x={480} y={120} width={34} height={30} rx={6} fill="#201e1b" stroke="#2e2a25" />
      <rect x={489} y={129} width={11} height={11} rx={2} fill="none" stroke="#a09590" strokeWidth={1.3} />
      <rect x={493} y={133} width={11} height={11} rx={2} fill="none" stroke="#a09590" strokeWidth={1.3} />

      <rect x={40} y={214} width={430} height={30} rx={6} fill="#161412" stroke="#2e2a25" />
      <T x={52} y={233} size={10.5} fill="#8a7f7c">Token name (e.g. Claude Desktop)</T>
      <rect x={480} y={214} width={104} height={30} rx={6} fill="#e8e2d9" />
      <T x={532} y={233} size={11} weight={600} fill="#161412" anchor="middle">Create token</T>

      <rect x={40} y={278} width={544} height={30} rx={6} fill="#161412" stroke="#2e2a25" />
      <T x={52} y={297} size={10.5} mono fill="#f1f5f9">apx_7f3c1e9b…</T>
      <T x={40} y={330} size={10.5} fill="#a09590">Copy this token now — it won&apos;t be shown again.</T>

      <Mark x={36} y={210} w={552} h={38} />
      <Mark x={36} y={274} w={552} h={38} />
      <Pin x={44} y={208} n={1} />
      <Pin x={44} y={272} n={2} />
    </Chrome>
  );
}

export const APEX_TOKEN: FigureSpec = {
  id: 'apex-token',
  title: 'Creating an access token in Apex (Profile → AI connector)',
  note: 'Only tools that cannot do the browser sign-in need a token. If you are using Claude Desktop, claude.ai or ChatGPT, skip this entirely.',
  pins: [
    'Type a name that tells you where the token will live — "Claude Code on my laptop" — and click Create token.',
    'Copy the token immediately. Apex stores only a scrambled version of it, so it can never be shown again; if you lose it, revoke it and make another.',
  ],
  Svg: ApexTokenSvg,
};
