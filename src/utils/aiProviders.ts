export type AiProtocol = 'anthropic' | 'openai';

export interface AiProviderPreset {
  id: string;
  label: string;
  provider: AiProtocol;
  baseUrl: string;
  model: string;
  keyRequired: boolean;
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  { id: 'anthropic', label: 'Anthropic', provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', keyRequired: true },
  { id: 'kimi', label: 'Kimi (Moonshot AI)', provider: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3.1-pro', keyRequired: true },
  { id: 'openai', label: 'OpenAI', provider: 'openai',
    baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', keyRequired: true },
  { id: 'ollama', label: 'Ollama (local)', provider: 'openai',
    baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder', keyRequired: false },
  { id: 'lmstudio', label: 'LM Studio (local)', provider: 'openai',
    baseUrl: 'http://localhost:1234/v1', model: 'local-model', keyRequired: false },
];

export function detectAiPreset(provider: string, baseUrl: string): AiProviderPreset | undefined {
  const normalized = baseUrl.trim().replace(/\/+$/, '').toLowerCase();
  return AI_PROVIDER_PRESETS.find(preset => preset.provider === provider
    && preset.baseUrl.toLowerCase() === normalized);
}

export function aiKeyRequired(provider: string, baseUrl: string): boolean {
  return detectAiPreset(provider, baseUrl)?.keyRequired ?? provider === 'anthropic';
}
