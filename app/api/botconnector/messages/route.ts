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
  logger.info({
    message: 'POST /botconnector/messages received',
    botSessionId: body.botSessionId,
    botId: body.botId,
    genesysConversationId: body.genesysConversationId
  });
  logger.debug({ message: 'Full incoming Genesys request body', body: JSON.stringify(body, null, 2) });

  const secret = req.headers.get('GENESYS_CONNECTION_SECRET');
  if (secret !== config.GENESYS_CONNECTION_SECRET) {
    logger.warn('Invalid connection secret');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const openaiApiKey = req.headers.get('OPENAI_API_KEY');
  if (!openaiApiKey) {
    logger.warn('Missing OPENAI_API_KEY');
    return NextResponse.json({ error: 'Missing OpenAI API key' }, { status: 400 });
  }

  try {
    const { botSessionId, inputMessage, genesysConversationId, botId, parameters, botSessionTimeout } = body;
    const sessionKey = botSessionId || new Date().toISOString();

    let previousResponseId: string | undefined;
    if (botSessionId) {
      previousResponseId = await sessionStore.get(sessionKey);
      logger.debug(`Retrieved previousResponseId: ${previousResponseId}`);
    }

    const input: OpenAI.Responses.ResponseCreateParams['input'] = inputMessage.text || '';
    logger.debug({ message: 'Processing as text-only input', text: input });

    if (!input.trim()) {
        logger.warn('Input text is empty, returning empty response to Genesys.');
        const genesysResponse: GenesysIncomingMessagesResponse = {
            botState: 'MoreData',
            replyMessages: [],
            intent: 'DefaultIntent',
            confidence: 1.0,
            entities: [],
            parameters: {},
        };
        return NextResponse.json(genesysResponse);
    }

    let model = config.DEFAULT_OPENAI_MODEL;
    let temperature = config.DEFAULT_OPENAI_TEMPERATURE;
    if (parameters) {
      if (parameters.openai_model) model = parameters.openai_model;
      if (parameters.openai_temperature) temperature = parseFloat(parameters.openai_temperature);
    }
    
    if (!parameters?.openai_model) {
      const bots = getBots();
      const bot = bots.find(b => b.id === botId);
      if (bot) model = bot.id;
    }

    const metadata = { genesys_conversation_id: genesysConversationId };

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
        logger.debug('Loaded MCP tools', { count: tools?.length || 0 });
      } catch (err) {
        logger.error({ msg: 'Failed to load MCP config', error: (err as Error).message });
      }
    }

    const openaiResponse = await openai.responses.create({
      model,
      input,
      previous_response_id: previousResponseId || undefined,
      temperature,
      metadata,
      tools,
    }, { headers: { Authorization: `Bearer ${openaiApiKey}` } });

    if (botSessionId && openaiResponse.id) {
      const ttl = botSessionTimeout ? botSessionTimeout * 60 : undefined;
      await sessionStore.set(sessionKey, openaiResponse.id, ttl);
      logger.debug(`Stored new response ID: ${openaiResponse.id} for session: ${sessionKey}, TTL: ${ttl}`);
    }

    let botState: GenesysBotState = 'MoreData';
    let replyMessages: GenesysReplyMessage[] = [];
    let errorInfo: GenesysErrorInfo | undefined;

    if (openaiResponse.status === 'completed') {
      const outputMessage = openaiResponse.output.find(o => o.type === 'message');
      
      if (outputMessage && outputMessage.content[0]?.type === 'output_text') {
        replyMessages = [{ type: 'Text', text: outputMessage.content[0].text }];
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

    logger.debug({ message: 'Sending response to Genesys', response: genesysResponse });
    return NextResponse.json(genesysResponse);
  } catch (err) {
    logger.error({ msg: 'Error processing message', error: (err as Error).message, stack: (err as Error).stack });
    const errorResponse: GenesysIncomingMessagesResponse = {
      botState: 'Failed',
      replyMessages: [],
      errorInfo: { errorCode: 'internal_error', errorMessage: (err as Error).message },
    };
    return NextResponse.json(errorResponse, { status: 500 });
  }
}
