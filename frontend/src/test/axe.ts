import axe from "axe-core";
/** axe-core inside jsdom. Colour contrast needs real rendering, so it is checked by the Playwright run instead; everything structural is checked here. */
export async function violations(el: Element): Promise<string[]> {
  const r = await axe.run(el, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 80)).join(" | ")}`);
}
