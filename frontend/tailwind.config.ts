import type { Config } from "tailwindcss";

// Tailwind 3.4. The design tokens are CSS variables (src/styles/desk.css); Tailwind only exposes them as utilities.
// Preflight is OFF: desk.css owns the base styles (it is the approved mockup stylesheet, already axe-verified).
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)", s1: "var(--s1)", s2: "var(--s2)", s3: "var(--s3)", line: "var(--line)", line2: "var(--line2)",
        tx: "var(--tx)", tx2: "var(--tx2)", tx3: "var(--tx3)", accent: "var(--accent)",
        gain: "var(--gain)", loss: "var(--loss)", dec: "var(--dec)", ord: "var(--ord)", pos: "var(--pos)", warn: "var(--warn)", alert: "var(--alert)",
      },
      fontFamily: { display: "var(--f-display)", ui: "var(--f-ui)", mono: "var(--f-mono)" },
      screens: { md: "721px", lg: "1101px" },
    },
  },
  plugins: [],
};
export default config;
