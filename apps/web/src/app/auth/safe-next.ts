/** The page to return to after signing in: only a path on this site, never another origin. */
export const safeNext = (next: string | undefined): string => (next?.startsWith('/') && !next.startsWith('//') ? next : '/');
