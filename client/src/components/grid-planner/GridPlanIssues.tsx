import { plannerIssue } from '@/lib/grid-planner-view';

export function GridPlanIssues({ reasons, onReview }: { reasons: string[]; onReview?: (reason: string) => void }) {
  const issues = [...new Set(reasons.filter(Boolean))];
  if (!issues.length) return null;
  return <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
    <p className="font-medium">This plan can't run yet:</p>
    <ul className="mt-2 list-disc space-y-2 pl-4">{issues.map(reason => {
      const issue = plannerIssue(reason);
      return <li key={reason}>{issue.message}{onReview && <> <button type="button" className="underline underline-offset-2" onClick={() => onReview(reason)}>Review {issue.setting}</button></>}</li>;
    })}</ul>
  </div>;
}
