/** Subsequence fuzzy match; higher = better, null = no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  let score = 0, ti = 0, streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx === -1) return null;
    streak = idx === ti ? streak + 1 : 1;
    score += streak * 2;                                     // consecutive chars
    if (idx === 0 || /[\s_.-]/.test(t[idx - 1])) score += 3; // word starts
    ti = idx + 1;
  }
  return score - t.length * 0.01; // light tiebreak: shorter text wins
}
