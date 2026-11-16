import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getConfig } from '@/lib/config';
import logger from '@/lib/logger';
import { getSessionStore } from '@/lib/session-store';
import { loadConfiguredTools } from '@/lib/tools';
import {
  buildResponseCreateParams,
  describeError,
  mapOpenAIError,
  mapResponseToGenesys,
  resolveRequestSettings,
} from '@/lib/openai';
import { GenesysIncomingMessagesRequest, GenesysIncomingMessagesResponse } from '@/types/genesys';

const config = getConfig();
const sessionStore = getSessionStore();

function isValidConnectionSecret(received: string | null): boolean {
  if (!received) return false;
  const expected = Buffer.from(config.GENESYS_CONNECTION_SECRET);
  const actual = Buffer.from(received);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function POST(req: NextRequest) {
  if (!config.GENESYS_CONNECTION_SECRET) {
    logger.error('GENESYS_CONNECTION_SECRET is not set; rejecting request.');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!isValidConnectionSecret(req.headers.get('GENESYS_CONNECTION_SECRET'))) {
    logger.warn('Invalid connection secret');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const openaiApiKey = req.headers.get('OPENAI_API_KEY');
  if (!openaiApiKey) {
    logger.warn('Missing OPENAI_API_KEY');
    return NextResponse.json({ error: 'Missing OpenAI API key' }, { status: 400 });
  }

  let body: GenesysIncomingMessagesRequest;
  try {
    body = await req.json();
  } catch {
    logger.warn('Request body is not valid JSON');
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  logger.info({
    message: 'POST /botconnector/messages received',
    botSessionId: body.botSessionId,
    botId: body.botId,
    genesysConversationId: body.genesysConversationId,
  });
  logger.debug({ message: 'Full incoming Genesys request body', body: JSON.stringify(body, null, 2) });

  try {
    const { botSessionId, inputMessage, genesysConversationId, botId, parameters, botSessionTimeout } = body;

    const input = inputMessage?.text || '';
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

    const previousResponseId = botSessionId ? await sessionStore.get(botSessionId) : undefined;
    logger.debug(`Retrieved previousResponseId: ${previousResponseId}`);

    const { settings, warnings: settingsWarnings } = resolveRequestSettings(botId, parameters, {
      model: config.DEFAULT_OPENAI_MODEL,
      reasoningEffort: config.DEFAULT_OPENAI_REASONING_EFFORT,
      temperature: config.DEFAULT_OPENAI_TEMPERATURE,
      verbosity: config.DEFAULT_OPENAI_VERBOSITY,
    });
    settingsWarnings.forEach(warning => logger.warn(warning));

    const tools = await loadConfiguredTools(config.MCP_SERVERS_CONFIG_PATH);

    const requestParams = buildResponseCreateParams({
      settings,
      input,
      previousResponseId,
      metadata: { genesys_conversation_id: genesysConversationId },
      tools,
    });
    logger.debug({ message: 'Calling OpenAI Responses API', ...settings, toolCount: tools.length });

    // Genesys waits at most 60 seconds for a reply, so the client timeout and retries stay below that.
    const openai = new OpenAI({ apiKey: openaiApiKey, timeout: config.OPENAI_TIMEOUT_MS, maxRetries: 1 });
    const openaiResponse = await openai.responses.create(requestParams);

    const result = mapResponseToGenesys(openaiResponse);
    result.warnings.forEach(warning => logger.warn({ responseId: openaiResponse.id }, warning));

    if (botSessionId && result.keepResponseId) {
      const ttl = botSessionTimeout ? botSessionTimeout * 60 : undefined;
      await sessionStore.set(botSessionId, openaiResponse.id, ttl);
      logger.debug(`Stored new response ID: ${openaiResponse.id} for session: ${botSessionId}, TTL: ${ttl}`);
    }

    const genesysResponse: GenesysIncomingMessagesResponse = {
      botState: result.botState,
      replyMessages: result.replyMessages,
      intent: 'DefaultIntent',
      confidence: 1.0,
      entities: [],
      parameters: {},
      errorInfo: result.errorInfo,
    };

    logger.debug({ message: 'Sending response to Genesys', response: genesysResponse });
    return NextResponse.json(genesysResponse);
  } catch (err) {
    const { httpStatus, errorInfo } = mapOpenAIError(err);
    logger.error({ msg: 'Error processing message', ...describeError(err) });
    const errorResponse: GenesysIncomingMessagesResponse = {
      botState: 'Failed',
      replyMessages: [],
      errorInfo,
    };
    return NextResponse.json(errorResponse, { status: httpStatus });
  }
}
