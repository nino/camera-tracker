// Runs before every test file (wired up via `setupFiles` in vite.config.ts).
//
// Registers jest-dom's custom matchers (e.g. `toBeInTheDocument`,
// `toHaveTextContent`) on Vitest's `expect`, and augments the matcher types so
// they're available in TypeScript without any per-file imports.
import "@testing-library/jest-dom/vitest";

// jsdom has no canvas implementation and logs "Not implemented" on every
// getContext() call. Return null quietly instead; tests that need a context
// spy on getContext themselves.
HTMLCanvasElement.prototype.getContext = () => null;
