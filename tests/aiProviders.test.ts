import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_PROVIDER_PRESETS, detectAiPreset, aiKeyRequired,
} from '../src/utils/aiProviders.ts';

test('Kimi uses the OpenAI-compatible Moonshot endpoint and a current model', () => {
  const kimi = AI_PROVIDER_PRESETS.find(p => p.id === 'kimi');
  assert.equal(kimi?.provider, 'openai');
  assert.equal(kimi?.baseUrl, 'https://api.moonshot.ai/v1');
  assert.equal(kimi?.model, 'kimi-k3.1-pro');
  assert.equal(kimi?.keyRequired, true);
});

test('preset detection ignores trailing slashes and distinguishes local servers', () => {
  assert.equal(detectAiPreset('openai', 'https://api.moonshot.ai/v1/')?.id, 'kimi');
  assert.equal(detectAiPreset('openai', 'http://localhost:11434/v1')?.id, 'ollama');
  assert.equal(detectAiPreset('openai', 'http://localhost:1234/v1')?.id, 'lmstudio');
  assert.equal(detectAiPreset('openai', 'https://example.test/v1'), undefined);
});

test('hosted presets require keys while local and custom OpenAI servers may be keyless', () => {
  assert.equal(aiKeyRequired('anthropic', 'https://api.anthropic.com'), true);
  assert.equal(aiKeyRequired('openai', 'https://api.moonshot.ai/v1'), true);
  assert.equal(aiKeyRequired('openai', 'http://localhost:11434/v1'), false);
  assert.equal(aiKeyRequired('openai', 'http://localhost:9999/v1'), false);
});
