import { createContext, useCallback, useContext, useEffect, useId, useState } from 'react';

type DirtyReporter = (formId: string, dirty: boolean) => void;

/** Lets the settings page know when any form on the current tab has unsaved changes. */
export const SettingsDirtyContext = createContext<DirtyReporter>(() => undefined);

export interface Draft<D> {
  draft: D;
  set: (patch: Partial<D>) => void;
  replace: (next: D) => void;
  dirty: boolean;
  discard: () => void;
}

/**
 * Editable copy of server data. While there are no unsaved edits, the draft follows the source
 * (for example after a save or a refetch); once edited, it keeps the user's changes.
 */
export function useDraft<D extends object>(source: D, serialize: (value: D) => string = JSON.stringify): Draft<D> {
  const sourceKey = serialize(source);
  const [base, setBase] = useState({ key: sourceKey, value: source });
  const [draft, setDraft] = useState<D>(source);
  const dirty = serialize(draft) !== base.key;

  if (sourceKey !== base.key) {
    setBase({ key: sourceKey, value: source });
    if (!dirty) setDraft(source);
  }

  const report = useContext(SettingsDirtyContext);
  const formId = useId();
  useEffect(() => {
    report(formId, dirty);
  }, [report, formId, dirty]);
  useEffect(() => () => report(formId, false), [report, formId]);

  const set = useCallback((patch: Partial<D>) => setDraft((current) => ({ ...current, ...patch })), []);
  const discard = useCallback(() => setDraft(base.value), [base.value]);

  return { draft, set, replace: setDraft, dirty, discard };
}
