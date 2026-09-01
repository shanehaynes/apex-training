// Types for envGuard.mjs, which stays plain JS to match port.mjs.
// Keep the two in step.

/** Client vars without which the app cannot reach Supabase at all. */
export const REQUIRED_PROD_VARS: string[];

/** Vars whose absence degrades production without breaking it. */
export const EXPECTED_PROD_VARS: string[];

export interface ProdEnvOptions {
  /** Vite's command — only 'build' is a deployment. Defaults to 'build'. */
  command?: string;
  /** Where the variables are read from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** Which required vars are missing, and which expected ones only warn. Empty off Vercel production. */
export function checkProdEnv(options?: ProdEnvOptions): { missing: string[]; warnings: string[] };

/** Throws on a production build that would ship without Supabase. */
export function assertProdEnv(options?: ProdEnvOptions): void;
