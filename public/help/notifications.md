# Notifications

Project Minder can alert you when a new manual step is added to any project's `MANUAL_STEPS.md`, even when the dashboard tab is closed.

## Setup

1. Go to **Settings → Notifications**.
2. Click **Enable browser notifications** and grant permission in the browser prompt.
3. Click **Subscribe this browser** to register for push notifications.

## Channels

| Channel | Behavior |
|---------|----------|
| **push** | Background push notification delivered by the browser, even when the tab is closed. Requires a push subscription. |
| **telegram** | Message sent to your Telegram chat. Configure bot token and chat ID in Settings → Integrations. |
| **os** | In-tab OS notification using the Web Notification API. Requires browser permission. |

Enable or disable each channel per event in the **Event toggles** section.

## Managing subscriptions

The subscriptions list shows every browser that has subscribed. Click **Revoke** to remove a specific device. Use **Send test push** to verify delivery at any time — test pushes bypass the 5-minute dedup window.

## Known limitations

- Push notifications require the browser to be open (background tab is fine). Fully closed browsers cannot receive pushes.
- On iOS Safari, Web Push is supported from iOS 16.4+ with the site added to Home Screen.
