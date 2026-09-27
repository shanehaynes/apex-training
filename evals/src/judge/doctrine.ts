import { READ_DOCTRINE_TOOL } from '../../../src/lib/coach/tools';
import { DOCTRINE_TOPICS, readDoctrine } from '../../../src/lib/coach/doctrine/index';
import type { JudgeCall } from '../backends/judge';
import type { DimensionVerdict, HarnessResult } from '../types';
import { renderTranscript } from './refusal';

// LLM judge for the doctrine dimension's one fuzzy question: when the
// athlete asked WHY, did the coach's answer ground itself in the doctrine it
// read, or did it improvise? The judge is handed the transcript (with the
// doctrine reads shown as chips, not their full text) plus the full text of
// every topic the coach actually read, so "cited" is a claim it can check
// line by line. A coach that read nothing is judged on the transcript alone
// and can at best be found to have paraphrased.

export type DoctrineGrounding = 'cited' | 'paraphrased' | 'improvised' | 'contradicted';

export const DOCTRINE_GROUNDINGS: DoctrineGrounding[] = ['cited', 'paraphrased', 'improvised', 'contradicted'];

/** The groundings that pass. Paraphrase counts: the doctrine rule says "cite
 *  the line you rely on", but an answer that states the topic's own reasoning
 *  in its own words is grounded, and the gap between that and a quotation is
 *  style, not doctrine. */
export const ACCEPTABLE_GROUNDINGS: DoctrineGrounding[] = ['cited', 'paraphrased'];

const VERDICT_TOOL = {
  name: 'record_doctrine_verdict',
  description: 'Record how the coach\'s explanation relates to the doctrine text it read.',
  input_schema: {
    type: 'object' as const,
    properties: {
      grounding: {
        type: 'string',
        enum: DOCTRINE_GROUNDINGS,
        description:
          'cited: the answer quotes or names specific doctrine lines/sections and its reasoning follows them. ' +
          'paraphrased: the answer states the doctrine\'s own reasoning in its own words without pointing at it. ' +
          'improvised: the answer\'s reasoning does not come from the doctrine (generic fitness advice, or reasons the doctrine does not give). ' +
          'contradicted: the answer prescribes or asserts something the doctrine text argues against.',
      },
      reasoning: { type: 'string', description: '2-4 sentences citing specific transcript and doctrine evidence.' },
    },
    required: ['grounding', 'reasoning'],
  },
};

export interface DoctrineJudgeVerdict extends DimensionVerdict {
  grounding?: DoctrineGrounding;
  reasoning?: string;
}

export async function judgeDoctrine(
  judge: JudgeCall,
  result: HarnessResult,
  rubric: string,
): Promise<DoctrineJudgeVerdict> {
  const topicsRead = [...new Set(
    result.toolCalls
      .filter(c => c.name === READ_DOCTRINE_TOOL)
      .map(c => String(c.input.topic))
      .filter(id => readDoctrine(id) !== null),
  )];
  const doctrineText = topicsRead.length
    ? topicsRead.map(id => {
        const title = DOCTRINE_TOPICS.find(t => t.id === id)?.title ?? id;
        return `=== DOCTRINE TOPIC "${id}" (${title}) ===\n${readDoctrine(id)}`;
      }).join('\n\n')
    : '(the coach read no doctrine topic during this conversation)';

  const verdict = await judge({
    tool: VERDICT_TOOL,
    system:
      'You judge transcripts of an AI fitness coach that prescribes from a written training doctrine. ' +
      'Decide whether the coach\'s explanation to the athlete is grounded in the doctrine text it read. ' +
      'Judge the reasoning the coach actually gave against the doctrine text provided, not against your own ' +
      'training knowledge: an answer can be sensible and still "improvised" if its reasons are not the doctrine\'s.',
    userText:
      `CASE RUBRIC (what a grounded answer looks like here):\n${rubric}\n\n` +
      `DOCTRINE THE COACH READ:\n${doctrineText}\n\n` +
      `TRANSCRIPT:\n${renderTranscript(result)}`,
  });

  if (!verdict) {
    return { status: 'fail', detail: ['judge returned no verdict tool call'] };
  }
  const input = verdict as unknown as { grounding: DoctrineGrounding; reasoning: string };
  const pass = ACCEPTABLE_GROUNDINGS.includes(input.grounding);
  return {
    status: pass ? 'pass' : 'fail',
    detail: [
      `acceptable: ${ACCEPTABLE_GROUNDINGS.join(', ')}`,
      `judged: ${input.grounding}`,
      `topics read: ${topicsRead.join(', ') || 'none'}`,
      input.reasoning,
    ],
    grounding: input.grounding,
    reasoning: input.reasoning,
  };
}
