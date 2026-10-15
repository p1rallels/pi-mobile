import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * A scripted model for a real `pi -p` in tests: one bash call that counts slowly, then a closing answer.
 * Load it with `pi -e tests/support/faux_pi_extension.ts --provider pi-web-faux --model faux-slow`.
 * PI_WEB_FAUX_SECONDS sets how long the bash call runs (default 8).
 */
export default function fauxPiExtension(pi: ExtensionAPI): void {
	const seconds = Math.max(1, Number.parseInt(process.env.PI_WEB_FAUX_SECONDS ?? "8", 10) || 8);
	const faux = fauxProvider({ provider: "pi-web-faux", models: [{ id: "faux-slow", name: "faux slow" }] });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: `for i in $(seq 1 ${String(seconds)}); do echo "count $i"; sleep 1; done` }), { stopReason: "toolUse" }),
		fauxAssistantMessage(`counted to ${String(seconds)}`),
	]);
	pi.registerProvider(faux.provider);
}
