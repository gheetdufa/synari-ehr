import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';
import { Textarea } from '../../../ui/Form';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows'> & {
  value: string;
  /** Height when empty, in rows. */
  minRows?: number;
  /** Height cap in pixels before the field scrolls (grows without limit by default). */
  maxHeight?: number;
};

/** A textarea that grows with its text so long notes never hide inside a scroll box. */
export const AutoGrowTextarea = forwardRef<HTMLTextAreaElement, Props>(function AutoGrowTextarea(
  { value, minRows = 3, maxHeight, className = '', ...rest },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement);

  const resize = useCallback(() => {
    const element = inner.current;
    if (!element) return;
    element.style.height = 'auto';
    const border = element.offsetHeight - element.clientHeight;
    const wanted = element.scrollHeight + border;
    element.style.height = `${maxHeight ? Math.min(wanted, maxHeight) : wanted}px`;
    element.style.overflowY = maxHeight && wanted > maxHeight ? 'auto' : 'hidden';
  }, [maxHeight]);

  useLayoutEffect(resize, [value, resize]);

  useEffect(() => {
    const element = inner.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      resize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [resize]);

  return <Textarea ref={inner} rows={minRows} value={value} className={`resize-none ${className}`} {...rest} />;
});
