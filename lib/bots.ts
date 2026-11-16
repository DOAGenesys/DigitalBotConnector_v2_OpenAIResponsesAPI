export interface GenesysBot {
  id: string;
  name: string;
  provider: string;
  description: string;
  versions: {
    version: string;
    supportedLanguages: string[];
    intents: { name: string; entities: any[] }[];
  }[];
}

const bots: GenesysBot[] = [
  {
    id: 'gpt-6.1-terra',
    name: 'OpenAI GPT-6.1 Terra',
    provider: 'OpenAI',
    description: 'A fast, efficient model from OpenAI for visual reasoning and clear, natural writing.',
    versions: [
      {
        version: 'latest',
        supportedLanguages: ['en-us', 'es', 'fr', 'it'],
        intents: [{ name: 'DefaultIntent', entities: [] }],
      },
    ],
  },
  {
    id: 'gpt-6-luna',
    name: 'OpenAI GPT-6 Luna',
    provider: 'OpenAI',
    description: 'The most efficient OpenAI model, for focused, high-volume tasks.',
    versions: [
      {
        version: 'latest',
        supportedLanguages: ['en-us', 'es', 'fr', 'it'],
        intents: [{ name: 'DefaultIntent', entities: [] }],
      },
    ],
  },
];

export const FALLBACK_MODEL = bots[0].id;

export function getBots(): GenesysBot[] {
  return bots;
}

export function isSupportedModel(modelId: string | undefined): modelId is string {
  return bots.some(b => b.id === modelId);
}
