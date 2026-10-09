import type { PrimaryView } from '../shared/api.ts';
export function usageSummary(primary?: PrimaryView): string {
  const values: string[] = [];
  const context = primary?.contextUsage;
  if (context?.percent !== null && context?.percent !== undefined) values.push(`${Number(context.percent.toFixed(1))}% context`);
  else if (context?.tokens !== null && context?.tokens !== undefined) values.push(`${context.tokens.toLocaleString('en-US')} context tokens`);
  if (primary?.usage) values.push(`${primary.usage.tokens.total.toLocaleString('en-US')} tokens`);
  return values.join(' · ');
}
