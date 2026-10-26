import { highlightsFor, type WhatsNewAudience, type WhatsNewRelease } from "./index";

const KBD = /^<kbd>([^<]*)<\/kbd>$/;

/** A highlight body: `<kbd>…</kbd>` spans become key caps; everything else stays text, never HTML. */
export function HighlightBody({ text }: { text: string }) {
  return (
    <>
      {text.split(/(<kbd>[^<]*<\/kbd>)/).map((part, i) => {
        const key = KBD.exec(part);
        return key ? (
          <kbd
            key={i}
            className="rounded-sm border border-border bg-muted px-1 font-mono text-[0.85em] text-foreground"
          >
            {key[1]}
          </kbd>
        ) : (
          part
        );
      })}
    </>
  );
}

/** Each release's highlights for `audience`, newest release first. */
export function ReleaseNotes({
  releases,
  audience,
}: {
  releases: readonly WhatsNewRelease[];
  audience: WhatsNewAudience;
}) {
  return (
    <>
      {releases.map((release) => (
        <section
          key={release.version}
          aria-label={`What's new in ${release.version}`}
          className="flex flex-col gap-2"
        >
          <h3 className="font-heading font-medium">{release.version}</h3>
          <ul className="flex flex-col gap-3">
            {highlightsFor(release, audience).map((highlight) => (
              <li key={highlight.title} className="flex flex-col gap-0.5">
                <span className="font-medium">{highlight.title}</span>
                <span className="text-muted-foreground">
                  <HighlightBody text={highlight.body} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
