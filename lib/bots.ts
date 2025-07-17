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
    id: 'gpt-4.1-mini',
    name: 'OpenAI GPT-4.1 mini',
    provider: 'OpenAI',
    description: 'A powerful and fast multimodal model from OpenAI.',
    versions: [
      {
        version: 'latest',
        supportedLanguages: ['en-us', 'es', 'fr', 'it'],
        intents: [{ name: 'DefaultIntent', entities: [] }],
      },
    ],
  },
  {
    id: 'gpt-4.1-nano',
    name: 'OpenAI GPT-4.1 nano',
    provider: 'OpenAI',
    description: 'A highly cost efficient LLM from OpenAI.',
    versions: [
      {
        version: 'latest',
        supportedLanguages: ['en-us', 'es', 'fr', 'it'],
        intents: [{ name: 'DefaultIntent', entities: [] }],
      },
    ],
  },
];

export function getBots(): GenesysBot[] {
  return bots;
}
