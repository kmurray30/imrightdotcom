import * as xai from './xai.js';

const REGISTRY = { [xai.PROVIDER_ID]: xai };

export function listProviders() {
  return Object.values(REGISTRY).map((p) => ({ id: p.PROVIDER_ID, label: p.PROVIDER_LABEL }));
}

export function getProviderAdapter(providerId) {
  const adapter = REGISTRY[providerId];
  if (!adapter) throw new Error(`Unknown or unimplemented provider: ${providerId}`);
  return adapter;
}
