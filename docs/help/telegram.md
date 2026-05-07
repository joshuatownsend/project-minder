# Telegram Integration

Project Minder can send notification messages to a Telegram chat via a bot you control.

## Setup

1. Open Telegram and start a chat with **@BotFather**.
2. Send `/newbot` and follow the prompts to create a bot. Copy the bot token.
3. In Project Minder, go to **Settings → Integrations**.
4. Paste the bot token into the **Bot token** field and click **Save**.
5. Send `/start` to your new bot in Telegram.
6. Visit `https://api.telegram.org/bot<your-token>/getUpdates` to find your **chat ID** (numeric value inside `"chat": {"id": ...}`).
7. Enter the chat ID in the **Chat ID** field and click **Save**.
8. Click **Test connection** to verify a message arrives in Telegram.

## Enabling notifications

After setup, go to **Settings → Notifications** and enable the **telegram** toggle under the event you want notifications for.

## Security

Your bot token is stored in `~/.minder/secrets.json` and never returned to the browser. Only the chat ID is stored in the public config file.

## Troubleshooting

- **"No updates found"**: Make sure you sent `/start` to the bot before calling `getUpdates`.
- **Test connection fails**: Verify the bot token and chat ID are correct. Tokens look like `7654321098:AAF...`.
- **Messages stop arriving**: The bot may have been blocked. Send `/start` again.
