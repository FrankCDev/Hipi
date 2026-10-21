import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
	mergeConfig(baseConfig, viteConfig),
	defineConfig({
		test: {
			// Callback fixtures supply a bounded React adapter. Evaluate Zustand in the
			// same module graph so its real hooks use that adapter, not external React.
			server: { deps: { inline: ["zustand"] } },
		},
	}),
);
