import type { ConnectorKey } from './state'

/**
 * Maps each connector card to its real backend capabilities, so the Tier-2
 * routes (Read Now, real Disconnect) know what a given card can actually do
 * rather than pretending every card behaves the same.
 *
 * `service` groups cards that share a backend (both Gmail cards → gmail).
 * `backendOwned` is true only when there is a real OAuth/token flow behind the
 * card — those support a live status check and a real disconnect. The rest
 * (Drive, Calendar, Browser history, Animatics) are backend-less in this build:
 * their Connect/Disconnect is an honestly-persisted toggle and "Read Now" just
 * records the timestamp, because there is nothing to actually fetch yet.
 *
 * `readKind` tells the Read Now route how to trigger a real read:
 *   - 'gmail-scan'  → POST scan for that card id
 *   - 'slack-scan'  → POST scan for the slack card
 *   - 'wa-sync'     → dispatch the whatsapp sync
 *   - null          → no real read; timestamp only
 */
export type ReadKind = 'gmail-scan' | 'slack-scan' | 'wa-sync' | null

export interface ConnectorMeta {
  service: 'gmail' | 'slack' | 'whatsapp' | null
  backendOwned: boolean
  readKind: ReadKind
}

export const CONNECTOR_META: Record<ConnectorKey, ConnectorMeta> = {
  'gmail-personal': { service: 'gmail', backendOwned: true, readKind: 'gmail-scan' },
  'gmail-professional': { service: 'gmail', backendOwned: true, readKind: 'gmail-scan' },
  'slack-workspace': { service: 'slack', backendOwned: true, readKind: 'slack-scan' },
  whatsapp: { service: 'whatsapp', backendOwned: true, readKind: 'wa-sync' },
  'drive-personal': { service: null, backendOwned: false, readKind: null },
  'drive-professional': { service: null, backendOwned: false, readKind: null },
  calendar: { service: null, backendOwned: false, readKind: null },
  animatics: { service: null, backendOwned: false, readKind: null },
  'browser-history': { service: null, backendOwned: false, readKind: null },
}

export function connectorMeta(key: ConnectorKey): ConnectorMeta {
  return CONNECTOR_META[key]
}
