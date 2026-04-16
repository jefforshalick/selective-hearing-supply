import { env } from 'cloudflare:workers';

const SETTINGS_KEY = 'settings';

export interface ShipFromAddress {
  id: string;
  name: string; // short label, e.g. "Home"
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
}

export interface Settings {
  shipFromAddresses: ShipFromAddress[];
}

const defaultSettings: Settings = { shipFromAddresses: [] };

function getKV(): KVNamespace | null {
  return (env as any).INVENTORY ?? null;
}

export async function getSettings(): Promise<Settings> {
  const kv = getKV();
  if (!kv) return defaultSettings;
  const data = await kv.get(SETTINGS_KEY);
  if (!data) return defaultSettings;
  return JSON.parse(data) as Settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  const kv = getKV();
  if (!kv) throw new Error('KV not available');
  await kv.put(SETTINGS_KEY, JSON.stringify(settings));
}

export async function upsertShipFromAddress(address: ShipFromAddress): Promise<void> {
  const settings = await getSettings();
  const idx = settings.shipFromAddresses.findIndex((a) => a.id === address.id);
  if (idx >= 0) settings.shipFromAddresses[idx] = address;
  else settings.shipFromAddresses.push(address);
  await saveSettings(settings);
}

export async function deleteShipFromAddress(id: string): Promise<void> {
  const settings = await getSettings();
  settings.shipFromAddresses = settings.shipFromAddresses.filter((a) => a.id !== id);
  await saveSettings(settings);
}
