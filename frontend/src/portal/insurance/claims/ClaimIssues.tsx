import { AlertTriangle, ArrowRight, CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ClaimDetail } from '../../../api/claims';
import { useSession } from '../../../auth/StaffAuth';
import { Card, CardHeader } from '../../../ui/Card';
import { issueFix, type IssueFix } from '../issueFixes';

function FixLink({ fix }: { fix: IssueFix }) {
  const classes = 'inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline';
  const content = (
    <>
      {fix.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
    </>
  );
  if (fix.to) {
    return (
      <Link to={fix.to} className={classes}>
        {content}
      </Link>
    );
  }
  return (
    <a href={`#${fix.anchor}`} className={classes}>
      {content}
    </a>
  );
}

/** What would get a draft or rejected claim rejected, each with where to fix it. */
export function ClaimIssues({ claim }: { claim: ClaimDetail }) {
  const { staff, practice } = useSession();
  const context = { claim, editable: true, selfId: staff.id, billingProvider: practice.billing_provider };

  if (claim.issues.length === 0) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
        <p>
          <span className="font-semibold">Ready to submit.</span> No problems found. Payers can still deny a claim for
          reasons only they know, like eligibility or coverage limits.
        </p>
      </div>
    );
  }

  const count = claim.issues.length;
  return (
    <Card>
      <CardHeader
        title={`${count} ${count === 1 ? 'problem' : 'problems'} to fix before submitting`}
        description="The clearinghouse or payer would reject the claim for these."
      />
      <ul className="divide-y divide-sage-100" aria-label="Claim problems">
        {claim.issues.map((issue, index) => {
          const fix = issueFix(issue, context);
          return (
            <li key={`${issue.field}-${issue.code}-${index}`} className="flex items-start gap-3 px-5 py-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-sage-900">{issue.message}</p>
                {fix && (
                  <div className="mt-0.5">
                    <FixLink fix={fix} />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
