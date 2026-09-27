// The coach's training doctrine, as a compiled curriculum: one topic per
// module, each an original synthesis the coach can cite and act on. The
// text is read by the model under time pressure, so every topic keeps the
// same shape — a two-sentence framing, short-headed body sections, then
// "How the coach applies this" (imperatives) and "Signals that contradict
// this" (what in the athlete's data should make the coach question the
// prescription). Citations land on those last two sections, so each bullet
// there is a complete, self-standing sentence.
//
// The text must never contain '<' or '>' — the prompt wraps user data in
// tagged blocks and strips angle brackets from user text, and the doctrine
// must never look like a tag.

export type DoctrineTopicId =
  | 'principles'
  | 'aerobic-base'
  | 'periodization'
  | 'strength'
  | 'climbing'
  | 'recovery'
  | 'mobility'
  | 'athlete-ideal';

export interface DoctrineTopic {
  id: DoctrineTopicId;
  title: string;
  /** One sentence for the index. */
  summary: string;
  text: string;
}
