// Runs before every test file (wired up via `setupFiles` in vite.config.ts).
//
// Registers jest-dom's custom matchers (e.g. `toBeInTheDocument`,
// `toHaveTextContent`) on Vitest's `expect`, and augments the matcher types so
// they're available in TypeScript without any per-file imports.
import "@testing-library/jest-dom/vitest";
