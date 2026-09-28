import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { importKeys, type ImportJob } from '../../../api/imports';

/** Stores a job the API just returned, so every step shows it at once, and refreshes the list. */
export function useStoreImportJob(): (job: ImportJob) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (job: ImportJob) => {
      queryClient.setQueryData(importKeys.detail(job.id), job);
      void queryClient.invalidateQueries({ queryKey: importKeys.list });
    },
    [queryClient],
  );
}
