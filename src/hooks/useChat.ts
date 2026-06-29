import { useState, useCallback, useRef } from 'react';
import Anthropic from '@anthropic-ai/sdk';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const client = new Anthropic({
  apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY as string,
  dangerouslyAllowBrowser: true,
});

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const abortRef = useRef<(() => void) | null>(null);

  const sendMessage = useCallback(async (content: string, systemPrompt: string) => {
    const userMessage: ChatMessage = { role: 'user', content };
    setMessages(prev => [...prev, userMessage]);
    setIsLoading(true);
    setStreamingContent('');

    const historyForApi = messages.map(m => ({ role: m.role, content: m.content }));
    historyForApi.push({ role: 'user', content });

    let accumulated = '';

    try {
      const stream = client.messages.stream({
        model: 'claude-opus-4-8',
        max_tokens: 1024,
        thinking: { type: 'adaptive' },
        system: systemPrompt,
        messages: historyForApi,
      });

      abortRef.current = () => stream.abort();

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          accumulated += event.delta.text;
          setStreamingContent(accumulated);
        }
      }

      setMessages(prev => [...prev, { role: 'assistant', content: accumulated }]);
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: 'Sorry, I ran into an error. Please try again.',
        }]);
      }
    } finally {
      setIsLoading(false);
      setStreamingContent('');
      abortRef.current = null;
    }
  }, [messages]);

  const triggerInitial = useCallback(async (systemPrompt: string) => {
    setIsLoading(true);
    setStreamingContent('');

    let accumulated = '';

    try {
      const stream = client.messages.stream({
        model: 'claude-opus-4-8',
        max_tokens: 1024,
        thinking: { type: 'adaptive' },
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: 'Give me my coaching briefing for today.',
        }],
      });

      abortRef.current = () => stream.abort();

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          accumulated += event.delta.text;
          setStreamingContent(accumulated);
        }
      }

      setMessages([{ role: 'assistant', content: accumulated }]);
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setMessages([{
          role: 'assistant',
          content: "Couldn't reach the coaching server right now. Check your API key in .env.local.",
        }]);
      }
    } finally {
      setIsLoading(false);
      setStreamingContent('');
      abortRef.current = null;
    }
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.();
  }, []);

  return { messages, isLoading, streamingContent, sendMessage, triggerInitial, abort };
}
