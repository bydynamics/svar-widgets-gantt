/**
 * Vite config for building SVAR Gantt as a single IIFE bundle
 * for use inside a BC ControlAddin.
 *
 * Usage: cd svelte && npx vite build --config vite.bc.config.js
 * Output: svelte/dist-bc/svar-gantt-bc.js + svar-gantt-bc.css
 */
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import conditionalCompile from "vite-plugin-conditional-compile";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default {
	plugins: [
		conditionalCompile(),
		svelte({
			compilerOptions: {
				// Do NOT inject CSS into JS — emit separate CSS file
				css: "external",
			},
		}),
	],
	build: {
		lib: {
			entry: resolve(__dirname, "src/bc-entry.js"),
			name: "BdySvarGantt",
			formats: ["iife"],
			fileName: () => "svar-gantt-bc.js",
		},
		outDir: resolve(__dirname, "dist-bc"),
		cssCodeSplit: false,
		minify: "esbuild",
		rollupOptions: {
			output: {
				// Ensure CSS is extracted as a separate file
				assetFileNames: "svar-gantt-bc.[ext]",
			},
		},
	},
	resolve: {
		dedupe: ["svelte"],
	},
};
