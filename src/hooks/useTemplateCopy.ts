import { useState } from 'react';
import { postJson } from '../lib/api';
import { notify } from '../lib/notify';
import { useAuth } from '../context/auth';
import { useSchedule } from '../context/schedule';

/**
 * The starter-template copy flow, shared by the onboarding welcome flow and
 * the getting-started checklist.
 */
export function useTemplateCopy() {
  const { refreshProfile } = useAuth();
  const { refreshEvents } = useSchedule();
  const [isCopying, setIsCopying] = useState(false);

  const copyTemplate = async () => {
    setIsCopying(true);
    try {
      const result = await postJson<{ events?: number; alreadyCopied?: boolean }>(
        '/api/template-copy', {}, 'Copying starter workouts',
      );
      await Promise.all([refreshEvents(), refreshProfile()]);
      notify(result.alreadyCopied ? 'Already copied' : `Added ${result.events ?? 0} recurring workouts`);
    } catch {
      /* postJson already toasted */
    } finally {
      setIsCopying(false);
    }
  };

  return { copyTemplate, isCopying };
}
