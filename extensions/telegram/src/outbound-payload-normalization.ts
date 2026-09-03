import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { resolveTelegramInlineButtons, type TelegramInlineButtons } from "./button-types.js";
import { resolveTelegramInteractiveTextFallback } from "./interactive-fallback.js";

export function normalizeTelegramMetadataOnlyPayload(payload: ReplyPayload): ReplyPayload | null {
  const telegramData = payload.channelData?.telegram as
    | {
        buttons?: TelegramInlineButtons;
        quoteText?: string;
        reaction?: { emoji?: unknown; replyToId?: unknown; replyToCurrent?: unknown };
      }
    | undefined;
  const text = resolveTelegramInteractiveTextFallback({
    text: payload.text,
    interactive: payload.interactive,
    presentation: payload.presentation,
  });
  if (
    text?.trim() ||
    resolveSendableOutboundReplyParts(payload).mediaUrls.length > 0 ||
    payload.location ||
    payload.audioAsVoice === true ||
    payload.videoAsNote === true ||
    payload.presentation ||
    payload.interactive
  ) {
    return payload;
  }
  const buttons = resolveTelegramInlineButtons({
    buttons: telegramData?.buttons,
    presentation: payload.presentation,
    interactive: payload.interactive,
  });
  const hasQuoteText =
    typeof telegramData?.quoteText === "string" && Boolean(telegramData.quoteText.trim());
  const hasReaction =
    typeof telegramData?.reaction?.emoji === "string" &&
    Boolean(telegramData.reaction.emoji.trim());
  if (hasReaction && !buttons?.length && !hasQuoteText) {
    return payload;
  }
  const fallbackText = payload.fallbackText?.text.trim();
  if (!buttons?.length && !hasQuoteText) {
    return null;
  }
  return fallbackText ? { ...payload, text: fallbackText } : null;
}

function mergeTelegramFallbackPayloads(source: ReplyPayload, adopter: ReplyPayload): ReplyPayload {
  const sourceTelegram = source.channelData?.telegram as
    | { buttons?: TelegramInlineButtons; quoteText?: string }
    | undefined;
  const adopterTelegram = adopter.channelData?.telegram as
    | { buttons?: TelegramInlineButtons; quoteText?: string }
    | undefined;
  const buttons = [...(sourceTelegram?.buttons ?? []), ...(adopterTelegram?.buttons ?? [])];
  const quoteText = sourceTelegram?.quoteText?.trim()
    ? sourceTelegram.quoteText
    : adopterTelegram?.quoteText;
  const telegram =
    sourceTelegram || adopterTelegram
      ? {
          ...adopterTelegram,
          ...sourceTelegram,
          ...(buttons.length > 0 ? { buttons } : {}),
          ...(quoteText ? { quoteText } : {}),
        }
      : undefined;
  return {
    ...adopter,
    ...source,
    fallbackText: adopter.fallbackText,
    channelData: {
      ...adopter.channelData,
      ...source.channelData,
      ...(telegram ? { telegram } : {}),
    },
  };
}

export function normalizeTelegramFallbackPayloadBatch(
  entries: readonly { index: number; payload: ReplyPayload }[],
): ReadonlyArray<ReplyPayload | null> {
  const normalized: Array<ReplyPayload | null> = entries.map((entry) => entry.payload);
  const positions = new Map(entries.map((entry, position) => [entry.index, position]));
  for (const [position, entry] of entries.entries()) {
    const fallback = entry.payload.fallbackText;
    if (
      fallback?.replacesPayloadIndex === undefined ||
      entry.payload.text?.trim() !== fallback.text.trim() ||
      entry.payload.interactive ||
      entry.payload.presentation ||
      resolveSendableOutboundReplyParts(entry.payload).mediaUrls.length > 0 ||
      entry.payload.location ||
      entry.payload.audioAsVoice === true ||
      entry.payload.videoAsNote === true
    ) {
      continue;
    }
    const channelData = entry.payload.channelData;
    const channelDataKeys = channelData ? Object.keys(channelData) : [];
    const telegramData = channelData?.telegram as
      | {
          buttons?: TelegramInlineButtons;
          quoteText?: string;
          reaction?: unknown;
        }
      | undefined;
    if (
      channelDataKeys.length !== 1 ||
      channelDataKeys[0] !== "telegram" ||
      !telegramData?.buttons?.length ||
      telegramData.quoteText?.trim() ||
      telegramData.reaction
    ) {
      continue;
    }
    const sourcePosition = positions.get(fallback.replacesPayloadIndex);
    if (sourcePosition === undefined) {
      continue;
    }
    const source = normalized[sourcePosition];
    if (!source || source.text?.trim() !== fallback.text.trim()) {
      continue;
    }
    normalized[sourcePosition] = mergeTelegramFallbackPayloads(source, entry.payload);
    normalized[position] = null;
  }
  return normalized;
}
