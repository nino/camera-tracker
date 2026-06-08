import { render, screen } from "@testing-library/react";
import App from "./App";

// Example colocated test (App.tsx -> App.test.tsx). It doubles as a smoke test
// for the whole testing setup: jsdom environment, React Testing Library, and
// jest-dom matchers. jsdom exposes no WebGPU, so the probe should report it as
// unavailable — which is exactly the branch we assert here.
describe("App", () => {
   it("renders the WebGPU probe heading", () => {
      render(<App />);
      expect(
         screen.getByRole("heading", { name: /webgpu probe/i }),
      ).toBeInTheDocument();
   });

   it("reports WebGPU as unavailable when navigator.gpu is missing", async () => {
      render(<App />);
      expect(
         await screen.findByText(/webgpu unavailable/i),
      ).toBeInTheDocument();
   });
});
