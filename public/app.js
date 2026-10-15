import { bootCanvas } from "./app/canvas_main.js";
import { isPhoneLike } from "./app/core/device.js";
import { uiModeForPage } from "./app/core/ui_mode.js";
import { bootPhone } from "./app/main.js";

if (uiModeForPage(window, isPhoneLike()) === "canvas") {
	await bootCanvas();
} else {
	await bootPhone();
}
