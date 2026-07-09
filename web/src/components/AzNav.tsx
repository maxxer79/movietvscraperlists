const LETTERS = [
  "#",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
];

export function titleLetter(title: string): string {
  const trimmed = title.trim();
  const ch = trimmed.charAt(0).toUpperCase();
  if (ch >= "A" && ch <= "Z") return ch;
  return "#";
}

export function AzNav({
  available,
  onJump,
}: {
  available: Set<string>;
  onJump: (letter: string) => void;
}) {
  return (
    <nav className="az-nav" aria-label="Jump to letter">
      {LETTERS.map((letter) => {
        const enabled = available.has(letter);
        return (
          <button
            key={letter}
            type="button"
            className={`az-nav-btn ${enabled ? "" : "az-nav-btn-disabled"}`}
            disabled={!enabled}
            onClick={() => onJump(letter)}
            title={enabled ? `Jump to ${letter}` : `No titles for ${letter}`}
          >
            {letter}
          </button>
        );
      })}
    </nav>
  );
}
