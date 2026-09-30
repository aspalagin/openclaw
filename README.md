# Live proof screenshots for openclaw/openclaw#133406

Cropped from the PR author's Telegram Desktop client on 2026-09-30. The bot
messages were sent by the candidate's own Telegram outbound adapter at head
`6da8d970ea79a322da38be05a3a1bbfee406c8c4`, using synthetic fixtures only.

- `133406-live-A-rich-local-media.png`: local photo, video, and audio embedded in one rich message.
- `133406-live-B-repeated-photo.png`: the same local photo attached twice, both occurrences embedded.
- `133406-live-C1-plain-fallback.png`: Telegram rejected the rich message (`RICH_MESSAGE_DEPTH_INVALID`); the plain-text fallback names each embedded file where it appeared.
- `133406-live-C2-fallback-album.png`: both occurrences of the repeated photo resent as an album after the fallback text.
