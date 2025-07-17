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
    id: 'gpt-4o',
    name: 'OpenAI GPT-4o',
    provider: 'OpenAI',
    description: 'A powerful and fast multimodal model from OpenAI.',
    versions: [
      {
        version: 'latest',
        supportedLanguages: ['en-us', 'es', 'fr'],
        intents: [{ name: 'DefaultIntent', entities: [] }],
      },
    ],
  },
  {
    id: 'gpt-4.1',
    name: 'OpenAI GPT-4.1',
    provider: 'OpenAI',
    description: 'A highly capable model for complex reasoning from OpenAI.',
    versions: [
      {
        version: 'latest',
        supportedLanguages: ['en-us', 'es', 'fr'],
        intents: [{ name: 'DefaultIntent', entities: [] }],
      },
    ],
  },
];

export function getBots(): GenesysBot[] {
  return bots;
}
