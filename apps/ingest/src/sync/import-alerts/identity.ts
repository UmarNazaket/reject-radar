/**
 * The text form behind Import Alert listing identity: Unicode NFKD, accents (combining marks) stripped, upper case,
 * every run of characters that are not letters or digits turned into one space, trimmed.
 *
 * FROZEN. `listing_key` and the re-key identity are built from this function, never from `@rejectradar/matching`
 * (whose normalisers will keep improving). Any change to it changes stored keys and fires mass false
 * `import_alert_listed` / `import_alert_delisted` pairs, so it must never change without a migration that re-keys every
 * stored listing (and its notice) in the same release.
 */
export function canonical(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
