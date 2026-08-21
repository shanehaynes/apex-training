// Types for port.mjs, which stays plain JS so scripts/drive.mjs can import it
// at runtime. Keep the two in step.

export const DEFAULT_PORT: 5173;

export interface PortOptions {
  /** Where APEX_PORT is read from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Checkout root whose .git decides primary (directory) vs. worktree (file). Defaults to this repo. */
  root?: string;
}

/** The 5200–5999 port a worktree directory name hashes to. */
export function derivedPort(name: string): number;

/** The dev/e2e port for this checkout: APEX_PORT, else 5173 in the primary checkout, else derived. */
export function devPort(options?: PortOptions): number;

/** `vite preview` port: one thousand below devPort, so the primary checkout keeps Vite's 4173. */
export function previewPort(options?: PortOptions): number;
