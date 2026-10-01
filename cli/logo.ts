// The Beams wordmark in Unicode line glyphs, after ~/Downloads/beams-light.svg (thin single-stroke
// rounded letters, "POWERED BY Teleport" beneath). Box-drawing glyphs only; every letter is exactly
// 5 columns wide and 3 rows high, starts on a ╭ row and ends on the cell centre of the last row
// (╰╯ corners, or half-height legs ╵), so width, height and baseline are identical.
export const BEAMS_MARK: string[] = [
  "╭───╮  ╭────  ╭───╮  ╭╮ ╭╮  ╭────",
  "├───┤  ├───   ├───┤  │╰─╯│  ╰───╮",
  "╰───╯  ╰────  ╵   ╵  ╵   ╵  ────╯",
];
export const BEAMS_TAGLINE = "powered by Teleport";
