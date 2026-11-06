// How finished agy background work looks in pi's conversation: one tool card
// per `agy-background` custom message (sent by the extension, read by the
// model as text from backgroundMessageText), in the style of realtasks' task
// notification cards. A left click toggles one card, like a pi tool card.

import type { MessageRenderer, MessageRenderOptions } from "@earendil-works/pi-coding-agent";
import { Box, MouseRegion, Text, type Component } from "@earendil-works/pi-tui";
import { noticeFailed, type BackgroundNotice } from "./acp/background.js";
import { formatDuration } from "./native-tools.js";

export const AGY_BACKGROUND_MESSAGE = "agy-background";

/** Output lines a collapsed card shows per item, like pi's bash card. */
export const CARD_PREVIEW_LINES = 5;

export interface BackgroundCardDetails {
	items: BackgroundNotice[];
}

type Theme = Parameters<MessageRenderer>[2];
export type CardOptions = Pick<MessageRenderOptions, "expanded" | "keyHint">;
/** An agy-background custom message, as pi hands it to the message renderer. */
export type BackgroundCardMessage = Parameters<MessageRenderer<BackgroundCardDetails>>[0];

/** `✓ agy task Sleep and print DONE finished · exit 0 · 15s`. */
function itemHeader(notice: BackgroundNotice, theme: Theme): string {
	const mark = noticeFailed(notice) ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const title = theme.fg("toolTitle", theme.bold(`agy ${notice.kind}`));
	const label = notice.kind === "subagent" ? (notice.target ?? notice.title) : notice.title;
	const detail = [
		notice.exitCode !== undefined ? `exit ${notice.exitCode}` : undefined,
		notice.durationMs !== undefined ? formatDuration(notice.durationMs) : undefined,
	].filter(Boolean).join(" · ");
	return `${mark} ${title} ${theme.fg("accent", label)}${detail ? theme.fg("muted", ` · ${detail}`) : ""}`;
}

/** What ran, shown under the header of an expanded card. */
function itemCommand(notice: BackgroundNotice): string | undefined {
	if (notice.kind === "subagent") return notice.target && notice.title !== notice.target ? notice.title : undefined;
	if (!notice.tool) return undefined;
	if (notice.tool === "run_command" && notice.target) return `$ ${notice.target}`;
	return notice.target ? `${notice.tool} ${notice.target}` : notice.tool;
}

/** Header, command, output preview and log path of one item. */
export function backgroundItemText(notice: BackgroundNotice, opts: CardOptions, theme: Theme): string {
	const lines = [itemHeader(notice, theme)];
	const command = opts.expanded ? itemCommand(notice) : undefined;
	if (command) lines.push(theme.fg("muted", command));
	const out = notice.output ? notice.output.split("\n") : [];
	while (out.length > 0 && !out.at(-1)!.trim()) out.pop();
	if (out.length > 0) {
		const shown = opts.expanded ? out : out.slice(-CARD_PREVIEW_LINES);
		const hidden = out.length - shown.length;
		lines.push("");
		if (hidden > 0) {
			lines.push(`${theme.fg("muted", `... (${hidden} earlier lines,`)} ${opts.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`);
		}
		lines.push(...shown.map((line) => theme.fg("toolOutput", line)));
	}
	if (opts.expanded && notice.logPath) lines.push("", theme.fg("muted", `log: ${notice.logPath}`));
	return lines.join("\n");
}

/**
 * Per-message click toggles. `base` is the global expand state the click was
 * made under; once ctrl+o changes it, the click is dropped and the card
 * follows the global state again, like pi's tool cards.
 */
const cardClicks = new WeakMap<BackgroundCardMessage, { base: boolean; expanded: boolean }>();

/**
 * The message as a pi tool card: tool background, padding, one section per
 * item. A left click anywhere on the card toggles it; the toggle is keyed by
 * the message object, so it survives re-renders.
 */
export function renderBackgroundCard(message: BackgroundCardMessage, opts: MessageRenderOptions, theme: Theme): Component | undefined {
	const items = message.details?.items ?? [];
	if (items.length === 0) return undefined;
	const bg = items.some(noticeFailed) ? "toolErrorBg" : "toolSuccessBg";
	const box = new Box(opts.outputPad, 1, (text) => theme.bg(bg, text));
	const click = cardClicks.get(message);
	if (click && click.base !== opts.expanded) cardClicks.delete(message);
	let expanded = cardClicks.get(message)?.expanded ?? opts.expanded;
	const fill = () => {
		box.clear();
		const text = items.map((notice) => backgroundItemText(notice, { ...opts, expanded }, theme)).join("\n\n");
		box.addChild(new Text(text, 0, 0));
	};
	fill();
	return new MouseRegion(box, (event) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		expanded = !expanded;
		cardClicks.set(message, { base: opts.expanded, expanded });
		fill();
		return { handled: true };
	});
}
