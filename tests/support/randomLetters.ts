import { randomInt } from "node:crypto";

/**
 * Random UPPERCASE LETTERS ONLY (no digits). Test symbols must not be built from UUID hex: a hex slice can contain
 * digits glued to "CE"/"PE" (e.g. "SEL-5734CE62"), which the v2 parser's structural options-shape detector
 * deliberately classifies as an options-style directive rather than an equity.
 */
export function randomLetters(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(65 + randomInt(26));
  return s;
}
