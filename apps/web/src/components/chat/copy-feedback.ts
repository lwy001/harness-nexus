import { useCallback, useRef, useState } from 'react';

/** Copy button with a 1s "copied" settle (portal reference's useCopyFeedback). */
export function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const onCopy = useCallback((text: string) => {
    if (text === '') return;
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1000);
      })
      .catch(() => undefined);
  }, []);
  return { copied, onCopy };
}
