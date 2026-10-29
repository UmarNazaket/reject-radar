const TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

/** A timestamp for the admin screens, which are in English: day, month, year and time, in UTC. */
export const adminTime = (iso: string): string => `${TIME.format(new Date(iso))} UTC`;
