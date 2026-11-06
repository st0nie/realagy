// How finished agy background work looks in pi's conversation: one tool-style
// card per item of an `agy-background` custom message (sent by the extension,
// read by the model as text from backgroundMessageText).

import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { noticeFailed, type BackgroundNotice } from "./acp/background.js";
import { formatDuration } from "./native-tools.js";

export const AGY_BACKGROUND_MESSAGE = "agy-background";

export interface BackgroundCardDetails {
	items: BackgroundNotice[];
}

type Theme = Parameters<MessageRenderer>[2];
type Options = Parameters<MessageRenderer>[1];

const CARD_LABEL: Record<BackgroundNotice["kind"], string> = {
	task: "agy background",
	subagent: "agy subagent",
	message: "agy message",
};

function commandText(notice: BackgroundNotice, theme: Theme): string {
	if (!notice.tool) return notice.title;
	return `${theme.bold(notice.tool)}${notice.target ? `  ${notice.target}` : ""}`;
}

/** Header, meta line, and body lines of one card, styled with `theme`. */
export function backgroundCardLines(notice: BackgroundNotice, expanded: boolean, theme: Theme, hint: string): string[] {
	const failed = noticeFailed(notice);
	const mark = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const label = CARD_LABEL[notice.kind];
	const what = notice.kind === "subagent" ? (notice.target ?? notice.title) : commandText(notice, theme);
	const meta = [
		notice.kind === "message" ? undefined : notice.title,
		notice.exitCode !== undefined ? `exit ${notice.exitCode}` : undefined,
		notice.durationMs !== undefined ? formatDuration(notice.durationMs) : undefined,
	].filter(Boolean).join(" · ");
	const lines = [`${theme.fg("toolTitle", theme.bold(label))} ${mark}  ${what}`];
	if (meta) lines.push(theme.fg("muted", meta));
	const body = expanded ? notice.output : notice.tail;
	if (body) lines.push("", ...body.split("\n").map((line) => theme.fg("toolOutput", line)));
	if (expanded && notice.logPath) lines.push("", theme.fg("dim", `log: ${notice.logPath}`));
	const more = notice.output.split("\n").length > notice.tail.split("\n").length || notice.logPath !== undefined;
	if (!expanded && more) lines.push("", hint);
	return lines;
}

export const renderBackgroundCard: MessageRenderer<BackgroundCardDetails> = (message, options: Options, theme) => {
	const items = message.details?.items ?? [];
	if (items.length === 0) return undefined;
	const hint = options.keyHint("app.tools.expand", "to expand: full output, log path");
	const column = new Box(0, 0);
	items.forEach((notice, i) => {
		if (i > 0) column.addChild(new Spacer(1));
		const card = new Box(options.outputPad, 1, (text) => theme.bg(noticeFailed(notice) ? "toolErrorBg" : "toolSuccessBg", text));
		card.addChild(new Text(backgroundCardLines(notice, options.expanded, theme, hint).join("\n"), 0, 0));
		column.addChild(card);
	});
	return column;
};
