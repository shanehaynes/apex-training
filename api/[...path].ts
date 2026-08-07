// Catch-all Vercel function hosting all consolidated /api/* routes (see
// _lib/app.ts for the route table). chat, review-cron, and calendar-feed
// remain standalone api/*.ts files — exact filesystem routes take precedence
// over this dynamic segment.
export { default } from './_lib/app.js';
