# Per-user connector state (Connect toggle + settings)

This build makes two pieces of Connectors-tab state **persist per user**, so they
survive reloads and follow the user across devices:

1. **The Connect / Disconnect toggle of every card** — Gmail (Personal /
   Professional), Google Drive (Personal / Professional), Calendar, WhatsApp,
   Animatics, Slack, Browser history.
2. **Each card's settings modal values** — poll frequency (hours), initial
   ingestion backfill (days), total ingestion window (days). Saved only when the
   user clicks **Save settings** for that specific card.

Everything is scoped to the signed-in user's email, derived server-side from the
NextAuth session — never from client input.

## How it fits the existing architecture

Same email-keyed, service-layer-isolated model as the rest of Entwin:

- **Table** `connector_state`, keyed by `(user_email, connector_key)`, with a
  `connected` boolean and a `settings jsonb` column. RLS is enabled + forced
  with no policies, so only the `service_role` key (server routes) can read or
  write it. See `supabase/migrations/0010_connector_state.sql`.
- **Service layer** `lib/connectors/state.ts` — stable connector keys, settings
  defaults, and server-side clamping that mirrors the modal's stepper bounds
  (poll 1–24h, backfill 1–100d, window fixed 365d), plus
  `getAllConnectorState` / `getConnectorState` / `upsertConnectorState`.
- **API** `app/api/connectors/state/route.ts`:
  - `GET` → `{ states: { "<connectorKey>": { connected, settings } } }`
  - `PATCH { connectorKey, connected?, settings? }` → upserts one card.
    `connected` alone persists a Connect/Disconnect click; `settings` alone
    persists a **Save settings** click; either can be sent without disturbing
    the other.

## Frontend behaviour

- Each connector carries a stable `key` and a `settings` object.
- On mount, the Connectors tab loads all saved state and restores every card's
  toggle and settings. This runs **first**; the real-backend hydrators
  (Gmail return-flow, Slack status, WhatsApp status) run afterward and reconcile
  the `connected` flag for the cards they authoritatively own — so a connection
  revoked at the source can never show as connected just because it was saved.
- Every Connect/Disconnect path (grid cards and the modal's own toggle) writes
  the new value through `PATCH`.
- The settings modal seeds its steppers from the saved values and persists them
  on **Save settings** (with a brief "Saving…" state).

## Connector keys

```
gmail-personal | gmail-professional | drive-personal | drive-professional |
calendar | whatsapp | animatics | slack-workspace | browser-history
```

## Deployment

Apply the new migration to Supabase before using the feature:

```
supabase db push          # or run supabase/migrations/0010_connector_state.sql
```

No new environment variables are required — the route reuses the existing
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`.
