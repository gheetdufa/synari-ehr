import { Check, RotateCcw, Sparkles, X } from 'lucide-react';
import type { NoteProposal } from '../../../api/ai';
import { Button } from '../../../ui/Button';
import { RiskFlagsAlert } from './NoteMeta';

/** Header for a pending AI draft: replace-all, discard, undo, and the draft's risk flags. */
export function ProposalBanner({
  proposal,
  formatName,
  usable,
  canUndo,
  onReplaceAll,
  onDiscard,
  onUndo,
}: {
  proposal: NoteProposal;
  formatName: string;
  usable: boolean;
  canUndo: boolean;
  onReplaceAll: () => void;
  onDiscard: () => void;
  onUndo: () => void;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-primary-200 bg-primary-50 px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-primary-700" aria-hidden="true" />
        <div className="min-w-0 flex-1 text-sm text-primary-900">
          <p className="font-semibold">AI draft ready — review it before using it</p>
          <p className="mt-0.5 text-primary-800">
            {usable
              ? 'Compare it with your note section by section. Use what’s accurate and edit anything that isn’t.'
              : `This draft was written for the ${formatName} format. Switch the note back to ${formatName} to use it, or generate a new draft.`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canUndo && (
            <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={onUndo}>
              Undo
            </Button>
          )}
          <Button size="sm" variant="secondary" icon={<X className="h-3.5 w-3.5" />} onClick={onDiscard}>
            Discard draft
          </Button>
          <Button size="sm" disabled={!usable} onClick={onReplaceAll}>
            Replace all
          </Button>
        </div>
      </div>
      <RiskFlagsAlert flags={proposal.risk_flags} title="The AI noticed possible safety concerns in this material — review" />
    </div>
  );
}

/** The AI's suggestion for one section (or the whole freeform note), with "Use this". */
export function ProposalBox({
  label,
  text,
  applied,
  usable,
  onUse,
}: {
  label: string;
  text: string;
  applied: boolean;
  usable: boolean;
  onUse: () => void;
}) {
  const empty = !text.trim();
  return (
    <div className="flex flex-col rounded-lg border border-dashed border-primary-300 bg-primary-50/60">
      <div className="flex items-center justify-between gap-2 border-b border-primary-100 px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary-800">
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> AI draft
        </span>
        {applied ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-primary-800">
            <Check className="h-3.5 w-3.5" aria-hidden="true" /> In use
          </span>
        ) : (
          <Button size="sm" variant="ghost" className="h-7 text-primary-800" disabled={!usable || empty} onClick={onUse} aria-label={`Use the AI draft for ${label}`}>
            Use this
          </Button>
        )}
      </div>
      <p className={`whitespace-pre-wrap px-3 py-2 text-sm ${empty ? 'italic text-sage-500' : 'text-sage-800'}`}>
        {empty ? 'Nothing suggested for this section.' : text}
      </p>
    </div>
  );
}
