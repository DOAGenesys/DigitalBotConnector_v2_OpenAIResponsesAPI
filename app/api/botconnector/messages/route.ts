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
  logger.debug({ message: 'Full incoming Genesys request body', body });

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
    let previousResponseId: string | undefined;
    if (body.botSessionId) {
      previousResponseId = await sessionStore.get(body.botSessionId);
      logger.debug(`Retrieved previousResponseId: ${previousResponseId}`);
    }

    let input: OpenAI.Responses.ResponseCreateParams['input'];
    const inputMessage = body.inputMessage;

    logger.debug({ message: 'Processing inputMessage', type: inputMessage.type, text: inputMessage.text, hasContent: !!inputMessage.content });

    if (inputMessage.content && inputMessage.content.length > 0) {
      logger.debug({ message: 'Message has content array', content: JSON.stringify(inputMessage.content) });
      inputMessage.content.forEach((item, index) => {
        logger.debug({ message: `Inspecting content item ${index}`, contentType: item.contentType, attachment: item.attachment });
      });
    }

    const attachment = inputMessage.content?.find(
      (c) => c.contentType === 'Attachment' && c.attachment?.mediaType === 'File'
    );

    if (attachment && attachment.attachment?.url) {
      logger.debug({ message: 'PDF attachment found', url: attachment.attachment.url });
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
              text: inputMessage.text || 'Please analyze the attached document.',
            },
          ],
        },
      ];
    } else {
      logger.debug('No PDF attachment found, processing as text message.');
      input = inputMessage.text || '';
    }
    
    logger.debug({ message: 'Final input payload for OpenAI', input: JSON.stringify(input) });

    let model = config.DEFAULT_OPENAI_MODEL;
    let temperature = config.DEFAULT_OPENAI_TEMPERATURE;
    if (body.parameters) {
      if (body.parameters.openai_model) model = body.parameters.openai_model;
      if (body.parameters.openai_temperature) temperature = parseFloat(body.parameters.openai_temperature);
    }
    
    if (!body.parameters?.openai_model) {
      const bots = getBots();
      const bot = bots.find(b => b.id === body.botId);
      if (bot) model = bot.id;
    }

    const metadata = { genesys_conversation_id: body.genesysConversationId };

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

    if (body.botSessionId && openaiResponse.id) {
      const ttl = body.botSessionTimeout ? body.botSessionTimeout * 60 : undefined;
      await sessionStore.set(body.botSessionId, openaiResponse.id, ttl);
      logger.debug(`Stored new response ID: ${openaiResponse.id}, TTL: ${ttl}`);
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
