/** Border regions a notice can come from (spec §7.1 `notice.destination`). */
export const DESTINATIONS = ['US', 'EU', 'UK', 'AU'] as const;
export type Destination = (typeof DESTINATIONS)[number];

export function isDestination(value: string): value is Destination {
  return (DESTINATIONS as readonly string[]).includes(value);
}
