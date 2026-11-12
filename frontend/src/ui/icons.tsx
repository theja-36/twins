/** Minimal stroke icons (24x24), decorative: always aria-hidden, the label beside them carries the meaning. */
const PATHS: Record<string, React.ReactNode> = {
  desk: <><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></>,
  decide: <><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.7 2.7L16 9.5" /></>,
  understand: <><circle cx="12" cy="12" r="9" /><path d="M15.5 8.5l-2 5-5 2 2-5z" /></>,
  control: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
  review: <><path d="M4 19V5M4 19h16" /><path d="M8 15l3-4 3 2 4-6" /></>,
  operate: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" /></>,
  bell: <><path d="M6 17h12l-1.5-2V11a4.5 4.5 0 10-9 0v4z" /><path d="M10 20h4" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
};
export function Icon({ name }: { name: string }) { return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{PATHS[name]}</svg>; }
