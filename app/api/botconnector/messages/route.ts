import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getConfig } from '@/lib/config';
import logger from '@/lib/logger';
import { getSessionStore } from '@/lib/session-store';
import { GenesysIncomingMessagesRequest, GenesysIncomingMessagesResponse, GenesysReplyMessage, GenesysBotState, GenesysErrorInfo } from '@/types/genesys';
import { getBots } from '@/lib/bots';
import fs from 'fs/promises';
import path from 'path';

const config = getConfig();
const openai = new OpenAI({ apiKey: '' });
const sessionStore = getSessionStore();

export async function POST(req: NextRequest) {
  const body: GenesysIncomingMessagesRequest = await req.json();
  logger.info('POST /botconnector/messages', { botSessionId: body.botSessionId, botId: body.botId });

  // Validate connection secret
  const secret = req.headers.get('GENESYS_CONNECTION_SECRET');
  if (secret !== config.GENESYS_CONNECTION_SECRET) {
    logger.warn('Invalid connection secret');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Extract OpenAI API key
  const openaiApiKey = req.headers.get('OPENAI_API_KEY');
  if (!openaiApiKey) {
    logger.warn('Missing OPENAI_API_KEY');
    return NextResponse.json({ error: 'Missing OpenAI API key' }, { status: 400 });
  }

  try {
    // Get previous response ID
    let previousResponseId: string | undefined;
    if (body.botSessionId) {
      previousResponseId = await sessionStore.get(body.botSessionId);
      logger.debug(`Retrieved previousResponseId: ${previousResponseId}`);
    }

    // Transform input
    let input: OpenAI.Responses.ResponseCreateParams['input'];
    const inputMessage = body.inputMessage;
    if (inputMessage.type === 'Text') {
      input = inputMessage.text || '';
    } else if (inputMessage.type === 'Structured' && inputMessage.content) {
      // Handle attachments
      const attachment = inputMessage.content.find(c => c.contentType === 'Attachment');
      if (attachment && attachment.attachment?.url) {
        input = [
          {
            role: 'user',
            content: [
              {
                type: 'input_file',
                file_url: attachment.attachment.url,
              },
              {
                type: 'input_text',
                text: inputMessage.text || '',
              },
            ],
          },
        ];
      } else {
        input = inputMessage.text || '';
      }
    } else {
      throw new Error('Invalid inputMessage type');
    }

    // Overrides from parameters
    let model = config.DEFAULT_OPENAI_MODEL;
    let temperature = config.DEFAULT_OPENAI_TEMPERATURE;
    if (body.parameters) {
      if (body.parameters.openai_model) model = body.parameters.openai_model;
      if (body.parameters.openai_temperature) temperature = parseFloat(body.parameters.openai_temperature);
    }
    // Default from botId if not overridden
    if (!body.parameters?.openai_model) {
      const bots = getBots();
      const bot = bots.find(b => b.id === body.botId);
      if (bot) model = bot.id;
    }

    // Metadata
    const metadata = { genesys_conversation_id: body.genesysConversationId };

    // Tools
    let tools: OpenAI.Responses.ResponseCreateParams['tools'] = [];
    if (config.MCP_SERVERS_CONFIG_PATH) {
      try {
        const mcpConfigPath = path.join(process.cwd(), config.MCP_SERVERS_CONFIG_PATH);
        const mcpConfigFile = await fs.readFile(mcpConfigPath, 'utf-8');
        const mcpConfigJson = JSON.parse(mcpConfigFile);

        tools = mcpConfigJson.map((t: any) => ({
          type: 'mcp' as const,
          ...t,
        }));
        logger.debug('Loaded MCP tools', { count: tools.length });
      } catch (err) {
        logger.error('Failed to load MCP config', err);
      }
    }

    // Call OpenAI
    const openaiResponse = await openai.responses.create({
      model,
      input,
      previous_response_id: previousResponseId || undefined,
      temperature,
      metadata,
      tools,
    }, { headers: { Authorization: `Bearer ${openaiApiKey}` } });

    // Store new response ID
    if (body.botSessionId && openaiResponse.id) {
      const ttl = body.botSessionTimeout ? body.botSessionTimeout * 60 : undefined; // minutes to seconds
      await sessionStore.set(body.botSessionId, openaiResponse.id, ttl);
      logger.debug(`Stored new response ID: ${openaiResponse.id}, TTL: ${ttl}`);
    }

    // Transform response
    let botState: GenesysBotState = 'MoreData';
    let replyMessages: GenesysReplyMessage[] = [];
    let errorInfo: GenesysErrorInfo | undefined;

    if (openaiResponse.status === 'completed') {
      const output = openaiResponse.output.find(o => o.type === 'message' && o.content[0]?.type === 'output_text');
      if (output) {
        replyMessages = [{ type: 'Text', text: (output.content[0] as any).text }];
      }
    } else if (openaiResponse.status === 'failed') {
      botState = 'Failed';
      errorInfo = { errorCode: openaiResponse.error?.code || 'unknown', errorMessage: openaiResponse.error?.message || 'Unknown error' };
    } else {
      botState = 'Failed';
      errorInfo = { errorCode: 'incomplete', errorMessage: 'Response incomplete' };
    }

    const genesysResponse: GenesysIncomingMessagesResponse = {
      botState,
      replyMessages,
      intent: 'DefaultIntent',
      confidence: 1.0,
      entities: [],
      parameters: {},
      errorInfo,
    };

    return NextResponse.json(genesysResponse);
  } catch (err) {
    logger.error('Error processing message', err);
    const errorResponse: GenesysIncomingMessagesResponse = {
      botState: 'Failed',
      replyMessages: [],
      errorInfo: { errorCode: 'internal_error', errorMessage: (err as Error).message },
    };
    return NextResponse.json(errorResponse, { status: 500 });
  }
}
