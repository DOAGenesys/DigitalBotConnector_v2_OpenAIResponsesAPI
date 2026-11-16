import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getConfig } from '@/lib/config';
import logger from '@/lib/logger';
import { GenesysActionsClient } from '@/lib/genesys-actions';
import {
  END_SESSION_TOOL_NAME,
  buildEndSessionTool,
  buildFunctionToolFromSchemas,
  redactToolOutputFields,
} from '@/lib/openai-genesys-tools';
import {
  buildFollowUpQuestionParams,
  buildResponseCreateParams,
  describeError,
  extractReplyTexts,
  getFunctionCalls,
  mapOpenAIError,
  mapResponseToGenesys,
  resolveRequestSettings,
} from '@/lib/openai';
import { allowActionForKey } from '@/lib/rate-limit';
import { getSessionStore, mergeSessionVariables, type SessionData, type SessionVariables } from '@/lib/session-store';
import { loadConfiguredTools } from '@/lib/tools';
import type {
  GenesysBotState,
  GenesysErrorInfo,
  GenesysIncomingMessagesRequest,
  GenesysIncomingMessagesResponse,
  GenesysReplyMessage,
} from '@/types/genesys';

const config = getConfig();
const sessionStore = getSessionStore();

type FunctionCallOutput = OpenAI.Responses.ResponseInputItem.FunctionCallOutput;
type DataActionSchemas = NonNullable<SessionData['dataActionSchemas']>;

interface DataActionTools {
  tools: OpenAI.Responses.FunctionTool[];
  functionNameToId: Map<string, string>;
  schemas: DataActionSchemas;
}

function isValidConnectionSecret(received: string | null): boolean {
  if (!received) return false;
  const expected = Buffer.from(config.GENESYS_CONNECTION_SECRET);
  const actual = Buffer.from(received);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function splitPipeList(value: string | undefined): string[] {
  return (value || '').split('|').map(s => s.trim());
}

function buildGenesysResponse(
  botState: GenesysBotState,
  replyMessages: GenesysReplyMessage[],
  errorInfo?: GenesysErrorInfo,
  parameters: Record<string, string> = {},
): GenesysIncomingMessagesResponse {
  return {
    botState,
    replyMessages,
    intent: 'DefaultIntent',
    confidence: 1.0,
    entities: [],
    parameters,
    ...(errorInfo ? { errorInfo } : {}),
  };
}

function parseEndSessionMessage(rawArguments: string): string {
  try {
    const args = JSON.parse(rawArguments || '{}');
    if (typeof args.message === 'string' && args.message.trim()) return args.message;
  } catch {
    logger.warn('Could not parse end_session arguments; using the default closing message.');
  }
  return 'Session ended.';
}

/** Builds one function tool per requested Genesys Data Action, reusing schemas cached in the session. */
async function buildDataActionTools(
  sessionVariables: SessionVariables,
  cachedSchemas: DataActionSchemas,
): Promise<DataActionTools> {
  const empty: DataActionTools = { tools: [], functionNameToId: new Map(), schemas: cachedSchemas };
  if (!config.ENABLE_GENESYS_FUNCTION_TOOLS) return empty;

  const requestedIds = splitPipeList(sessionVariables.data_action_ids).filter(Boolean);
  let actionIds = requestedIds;
  if (config.GENESYS_ALLOWED_DATA_ACTION_IDS) {
    const allowed = splitPipeList(config.GENESYS_ALLOWED_DATA_ACTION_IDS).filter(Boolean);
    actionIds = requestedIds.filter(id => allowed.includes(id));
    if (actionIds.length === 0) actionIds = allowed;
  }
  actionIds = actionIds.slice(0, config.MAX_GENESYS_TOOLS_PER_TURN);
  if (actionIds.length === 0) return empty;

  const descriptions = splitPipeList(sessionVariables.data_action_descriptions);
  const actionsClient = new GenesysActionsClient({});
  const schemas: DataActionSchemas = { ...cachedSchemas };

  const resolved = await Promise.all(
    actionIds.map(async id => {
      if (schemas[id]) return id;
      try {
        logger.info({ msg: 'Fetching schema for data action', id });
        const [input, success] = await Promise.all([
          actionsClient.getInputSchema(id),
          actionsClient.getSuccessSchema(id),
        ]);
        schemas[id] = { input, success };
        return id;
      } catch (e) {
        logger.warn({ msg: 'Skipping data action id due to schema fetch error', id, error: (e as Error).message });
        return undefined;
      }
    }),
  );

  const result: DataActionTools = { tools: [], functionNameToId: new Map(), schemas };
  for (const id of resolved) {
    if (!id) continue;
    const description = descriptions[requestedIds.indexOf(id)] || undefined;
    const tool = buildFunctionToolFromSchemas(id, schemas[id].input, description);
    result.functionNameToId.set(tool.name, id);
    result.tools.push(tool);
  }
  return result;
}

function buildInstructions(systemPrompt: string | undefined, dataActionTools: OpenAI.Responses.FunctionTool[]): string | undefined {
  const sections: string[] = [];
  if (systemPrompt?.trim()) sections.push(systemPrompt.trim());
  if (dataActionTools.length > 0) {
    sections.push(
      'When the user asks for ticket or booking details, call the most relevant provided function tool with only the required arguments, then incorporate the tool result in your reply.',
    );
    const listing = dataActionTools.map(tool => {
      const paramKeys = Object.keys((tool.parameters as { properties?: object } | null)?.properties ?? {});
      return `- ${tool.name} (params: ${paramKeys.join(', ')})`;
    });
    sections.push(`Available function tools for this turn:\n${listing.join('\n')}`);
  }
  return sections.join('\n\n') || undefined;
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

  const openaiApiKey = config.OPENAI_API_KEY || req.headers.get('OPENAI_API_KEY');
  if (!openaiApiKey) {
    logger.error(
      'No OpenAI API key: set the OPENAI_API_KEY environment variable or the OPENAI_API_KEY credential of the Genesys integration.',
    );
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

  let dataActionsExecuted = 0;
  try {
    const { botSessionId, inputMessage, genesysConversationId, botId, parameters, botSessionTimeout } = body;
    const ttl = botSessionTimeout ? botSessionTimeout * 60 : undefined;

    const userText = inputMessage?.text || '';
    if (!userText.trim()) {
      logger.warn('Input text is empty, returning empty response to Genesys.');
      return NextResponse.json(buildGenesysResponse('MoreData', []));
    }

    let storedSession: SessionData | undefined;
    let previousResponseId: string | undefined;
    if (botSessionId) {
      storedSession = await sessionStore.getSessionData(botSessionId);
      previousResponseId = storedSession?.previousResponseId ?? (await sessionStore.get(botSessionId));
    }
    const sessionVariables = mergeSessionVariables(storedSession?.sessionVariables, parameters);

    const { settings, warnings: settingsWarnings } = resolveRequestSettings(botId, sessionVariables, {
      model: config.DEFAULT_OPENAI_MODEL,
      reasoningEffort: config.DEFAULT_OPENAI_REASONING_EFFORT,
      temperature: config.DEFAULT_OPENAI_TEMPERATURE,
      verbosity: config.DEFAULT_OPENAI_VERBOSITY,
    });
    settingsWarnings.forEach(warning => logger.warn(warning));

    const dataActionTools = await buildDataActionTools(sessionVariables, storedSession?.dataActionSchemas ?? {});
    const tools: OpenAI.Responses.Tool[] = [
      ...(await loadConfiguredTools(config.MCP_SERVERS_CONFIG_PATH)),
      ...dataActionTools.tools,
      buildEndSessionTool(),
    ];
    const instructions = buildInstructions(sessionVariables.system_prompt, dataActionTools.tools);
    const metadata = { genesys_conversation_id: genesysConversationId };
    const promptCacheKey = config.PROMPT_CACHE_KEY_PREFIX
      ? `${config.PROMPT_CACHE_KEY_PREFIX}:${settings.model}`
      : undefined;
    logger.debug({ message: 'Calling OpenAI Responses API', ...settings, toolCount: tools.length });

    // A turn can make several OpenAI calls, and Genesys waits at most 60 seconds for the reply.
    const openai = new OpenAI({ apiKey: openaiApiKey, timeout: config.OPENAI_TIMEOUT_MS, maxRetries: 1 });

    const createResponse = (input: OpenAI.Responses.ResponseCreateParams['input'], previousId?: string) =>
      openai.responses.create(
        buildResponseCreateParams({
          settings,
          input,
          previousResponseId: previousId,
          metadata,
          tools,
          instructions,
          promptCacheKey,
        }),
      );

    const askFollowUpQuestion = async (
      question: string,
      contextResponseId: string,
      pendingToolOutputs: FunctionCallOutput[],
    ): Promise<string | undefined> => {
      const response = await openai.responses.create(
        buildFollowUpQuestionParams({ model: settings.model, question, previousResponseId: contextResponseId, pendingToolOutputs, metadata }),
      );
      if (response.status !== 'completed') return undefined;
      return extractReplyTexts(response.output).join('\n').trim() || undefined;
    };

    /** Ends the bot session, adding the conversation summary and task check to the output parameters. */
    const finishSession = async (args: {
      botState: 'Complete' | 'Failed';
      replyMessages: GenesysReplyMessage[];
      errorInfo?: GenesysErrorInfo;
      contextResponseId?: string;
      pendingToolOutputs?: FunctionCallOutput[];
    }) => {
      const outputParameters: Record<string, string> = {};
      if (args.contextResponseId) {
        const pending = args.pendingToolOutputs ?? [];
        const [summary, taskCheck] = await Promise.allSettled([
          askFollowUpQuestion(
            'Provide a concise summary of the entire conversation so far in less than 300 characters.',
            args.contextResponseId,
            pending,
          ),
          instructions
            ? askFollowUpQuestion(
                `Based on the conversation and the original instructions: "${instructions}", has the task been accomplished? Answer only "true" or "false".`,
                args.contextResponseId,
                pending,
              )
            : Promise.resolve(undefined),
        ]);
        if (summary.status === 'fulfilled' && summary.value) {
          outputParameters.summary_out = summary.value;
        } else if (summary.status === 'rejected') {
          logger.warn({ msg: 'Summary generation failed', ...describeError(summary.reason) });
        }
        if (taskCheck.status === 'fulfilled' && taskCheck.value) {
          outputParameters.task_achieved = taskCheck.value.toLowerCase().includes('true') ? 'true' : 'false';
        } else if (taskCheck.status === 'rejected') {
          logger.warn({ msg: 'Task accomplishment check failed', ...describeError(taskCheck.reason) });
        }
      }
      return NextResponse.json(buildGenesysResponse(args.botState, args.replyMessages, args.errorInfo, outputParameters));
    };

    const runDataAction = async (call: OpenAI.Responses.ResponseFunctionToolCall): Promise<string> => {
      const dataActionId = dataActionTools.functionNameToId.get(call.name);
      if (!dataActionId) {
        logger.warn({ msg: 'Unknown tool function name', functionName: call.name });
        return `Error: Unknown tool ${call.name}`;
      }
      if (Buffer.byteLength(call.arguments || '', 'utf8') > config.GENESYS_MAX_TOOL_ARGUMENT_BYTES) {
        logger.warn({ msg: 'Tool arguments exceed GENESYS_MAX_TOOL_ARGUMENT_BYTES', dataActionId });
        return 'Error: Tool arguments are too large';
      }
      let args: unknown;
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        logger.warn({ msg: 'Could not parse JSON arguments for tool', functionName: call.name });
        return 'Error: Could not parse JSON arguments';
      }
      if (dataActionsExecuted >= config.GENESYS_MAX_ACTION_CALLS_PER_TURN) {
        logger.warn({ msg: 'GENESYS_MAX_ACTION_CALLS_PER_TURN reached', dataActionId });
        return 'Error: Too many Data Action calls in this turn';
      }
      if (!allowActionForKey(genesysConversationId || botSessionId || 'unknown')) {
        logger.warn({ msg: 'GENESYS_ACTIONS_PER_MINUTE reached for this conversation', dataActionId });
        return 'Error: Data Action rate limit reached for this conversation, try again later';
      }

      dataActionsExecuted += 1;
      const startedAt = Date.now();
      try {
        logger.info({ msg: `Executing Genesys Data Action for tool: ${call.name}`, dataActionId });
        const result = await new GenesysActionsClient({}).executeActionTest(dataActionId, args);
        logger.info({ msg: 'Genesys Data Action executed successfully', dataActionId, durationMs: Date.now() - startedAt });
        return JSON.stringify(redactToolOutputFields(result, config.TOOL_OUTPUT_REDACTION_FIELDS));
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Action execution failed';
        logger.warn({ msg: 'Genesys action execution failed', dataActionId, error: message, durationMs: Date.now() - startedAt });
        return `Error: ${message}`;
      }
    };

    let lastResponse = await createResponse([{ role: 'user', content: userText }], previousResponseId);

    for (let iteration = 1; iteration <= config.GENESYS_TOOL_LOOP_MAX_ITERATIONS; iteration++) {
      const functionCalls = getFunctionCalls(lastResponse.output);
      if (lastResponse.status !== 'completed' || functionCalls.length === 0) break;
      logger.info({ msg: `[Turn ${iteration}] OpenAI response contains ${functionCalls.length} tool call(s).` });

      const toolOutputs: FunctionCallOutput[] = [];
      for (const call of functionCalls) {
        if (call.name === END_SESSION_TOOL_NAME) {
          logger.info({ msg: 'end_session tool called. Ending conversation.' });
          const pendingToolOutputs = functionCalls.map(
            pendingCall =>
              toolOutputs.find(output => output.call_id === pendingCall.call_id) ?? {
                type: 'function_call_output' as const,
                call_id: pendingCall.call_id,
                output: pendingCall === call ? 'Session ended.' : 'Not executed: the session ended.',
              },
          );
          return finishSession({
            botState: 'Complete',
            replyMessages: [{ type: 'Text', text: parseEndSessionMessage(call.arguments) }],
            contextResponseId: lastResponse.id,
            pendingToolOutputs,
          });
        }
        toolOutputs.push({ type: 'function_call_output', call_id: call.call_id, output: await runDataAction(call) });
      }

      logger.info({ msg: `[Turn ${iteration}] Sending ${toolOutputs.length} tool output(s) back to OpenAI.` });
      lastResponse = await createResponse(toolOutputs, lastResponse.id);
    }

    const unansweredCalls = lastResponse.status === 'completed' ? getFunctionCalls(lastResponse.output) : [];
    if (unansweredCalls.length > 0) {
      logger.warn({ msg: 'Tool loop exceeded max iterations.', maxIterations: config.GENESYS_TOOL_LOOP_MAX_ITERATIONS });
      return finishSession({
        botState: 'Failed',
        replyMessages: [],
        errorInfo: { errorCode: 'tool_loop_exceeded', errorMessage: 'Tool loop exceeded max iterations.' },
        contextResponseId: lastResponse.id,
        pendingToolOutputs: unansweredCalls.map(call => ({
          type: 'function_call_output' as const,
          call_id: call.call_id,
          output: 'Not executed: the tool call limit for this turn was reached.',
        })),
      });
    }

    const result = mapResponseToGenesys(lastResponse);
    result.warnings.forEach(warning => logger.warn({ responseId: lastResponse.id }, warning));

    if (result.botState === 'Failed') {
      return finishSession({
        botState: 'Failed',
        replyMessages: result.replyMessages,
        errorInfo: result.errorInfo,
        contextResponseId: previousResponseId,
      });
    }

    if (botSessionId && result.keepResponseId) {
      const sessionData: SessionData = {
        previousResponseId: lastResponse.id,
        sessionVariables,
        ...(Object.keys(dataActionTools.schemas).length > 0 ? { dataActionSchemas: dataActionTools.schemas } : {}),
      };
      await sessionStore.setSessionData(botSessionId, sessionData, ttl);
      logger.debug(`Stored new response ID: ${lastResponse.id} for session: ${botSessionId}, TTL: ${ttl}`);
    }

    return NextResponse.json(buildGenesysResponse(result.botState, result.replyMessages));
  } catch (err) {
    const mapped = mapOpenAIError(err);
    // Genesys retries 5xx responses, which would run the turn's Data Actions a second time.
    const httpStatus = dataActionsExecuted > 0 ? 200 : mapped.httpStatus;
    logger.error({ msg: 'Error processing message', dataActionsExecuted, ...describeError(err) });
    return NextResponse.json(buildGenesysResponse('Failed', [], mapped.errorInfo), { status: httpStatus });
  }
}
