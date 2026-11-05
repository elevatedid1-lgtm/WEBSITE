# Inner Circle signup service

A small Node service (no dependencies, Node 20+) that sits behind the
`/telegram-channel` landing page.

| What | How |
| --- | --- |
| Saves each signup | `POST /api/lead` from the page's details form (name, email, phone, Telegram username, ad source) |
| Sends it to GoHighLevel | Optional webhook, fired on signup, invite created, joined, and declined |
| Creates a personal invite link | `POST /api/admin/mark-paid`, called once a $50 payment is confirmed |
| Lets in only the right person | The bot approves a join request only if the Telegram username matches the one given at signup |

It does **not** take payment itself, and it does not yet receive payment
confirmations from Maverick. Until that is wired up, a team member marks a buyer
as paid by hand (see "Mark a buyer as paid").

## Deploy as its own Railway service

1. In Railway, open the existing project and choose **New, GitHub Repo**, select this repository.
2. In the new service's **Settings**, set **Root Directory** to `inner-circle-api`.
3. Add a **Volume** mounted at `/data` so signups survive redeploys, and set `DATA_DIR=/data`.
4. Add the variables below, then **Settings, Networking, Generate Domain**.
5. On the **website** service add `INNER_CIRCLE_API_ORIGIN` set to the new service's address (for example `https://inner-circle-api.up.railway.app`, no path). This lets the landing page talk to it.
6. In `public/telegram-channel.html` set `LEAD_API_URL` to the same address and merge. Until then the page keeps its "Checkout is opening soon" message, so merging early is safe.

## Variables

Set these in Railway only. Never commit them or paste them in chats.

| Variable | Needed | What it is |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | yes | Websites allowed to call the form endpoint, comma separated, for example `https://elevatedidentities.com,https://www.elevatedidentities.com` |
| `ADMIN_KEY` | yes | A long random password for the admin routes. Make one with `openssl rand -hex 24` |
| `DATA_DIR` | yes | Where leads are saved. Use the volume path, for example `/data` |
| `BOT_TOKEN` | for invites | The token BotFather gave for @ElevatedIDCircleBot |
| `CHANNEL_ID` | for invites | The Inner Circle channel's numeric id. In Telegram Web the channel's address ends in a number: use it as is if it starts with `-100`, otherwise put `-100` in front of the digits |
| `GHL_WEBHOOK_URL` | optional | A GoHighLevel "Inbound Webhook" trigger URL. Each event arrives with `event`, `name`, `email`, `phone`, `telegram_username`, `status`, `invite_link` and any ad source fields |
| `CHECKOUT_URL` | later | The Maverick payment page. When set, the form sends people there right after they submit |

Telegram needs the bot to be an admin of the channel with the **Add members** permission (it covers invite links and approving join requests). Nothing else is required.

## Mark a buyer as paid

When a $50 payment shows as approved in Maverick, run this (or ask a developer to).
It creates that buyer's personal invite link and sends the event to GoHighLevel:

```bash
curl -X POST https://YOUR-SERVICE/api/admin/mark-paid \
  -H "x-admin-key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"buyer@example.com"}'
```

Asking twice for the same buyer returns the same link and does not notify GoHighLevel again.

See everyone who signed up: `GET /api/admin/leads` with the same `x-admin-key` header.

## How the Telegram check works

The invite link is a *join request* link. When someone taps it Telegram asks the
bot instead of letting them straight in. The bot approves them only when their
Telegram username matches the one on their signup, and declines anyone else, so a
link passed to a friend does not work. People must have a Telegram username set
(Settings, Username) to be approved.

## What happens next (not built yet)

- Automatic confirmation from Maverick. Needs the gateway switched on and the
  webhook details from Maverick. Do not guess its format: it should call the same
  `markPaid` step once the payload and signature check are known.
- The thank-you page that shows the invite link after payment.

## Privacy

Signups contain names, emails and phone numbers. They are stored only in the
volume (`leads.json`), never in the repository (`data/` is git-ignored), and are
never written to the logs. The admin routes need `ADMIN_KEY`.
