import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import { FALLBACK_MODEL, isSupportedModel } from './bots';
import type { GenesysBotState, GenesysErrorInfo, GenesysReplyMessage } from '../types/genesys';

export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const VERBOSITY_LEVELS = ['low', 'medium', 'high'] as const;
export type Verbosity = (typeof VERBOSITY_LEVELS)[number];

export interface RequestDefaults {
  model: string;
  reasoningEffort: string;
  temperature: number;
  verbosity?: string;
}

export interface RequestSettings {
  model: string;
  reasoningEffort: ReasoningEffort;
  temperature?: number;
  verbosity?: Verbosity;
}

export interface GenesysTurnResult {
  botState: GenesysBotState;
  replyMessages: GenesysReplyMessage[];
  errorInfo?: GenesysErrorInfo;
  keepResponseId: boolean;
  warnings: string[];
}

export interface MappedError {
  httpStatus: number;
  errorInfo: GenesysErrorInfo;
}

function isReasoningEffort(value: string | undefined): value is ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort);
}

function isVerbosity(value: string | undefined): value is Verbosity {
  return VERBOSITY_LEVELS.includes(value as Verbosity);
}

function parseTemperature(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 2 ? parsed : undefined;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_\-*]{4,}/g, 'sk-***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/\-]+=*/gi, 'Bearer ***');
}

/**
 * Precedence: Genesys session variables, then the selected bot, then environment defaults.
 * Only models listed in lib/bots.ts are ever sent to OpenAI.
 */
export function resolveRequestSettings(
  botId: string | undefined,
  parameters: Record<string, string> | undefined,
  defaults: RequestDefaults,
): { settings: RequestSettings; warnings: string[] } {
  const warnings: string[] = [];
  const params = parameters ?? {};

  let model: string;
  if (isSupportedModel(params.openai_model)) {
    model = params.openai_model;
  } else {
    if (params.openai_model) {
      warnings.push(`openai_model "${params.openai_model}" is not supported and was ignored.`);
    }
    if (isSupportedModel(botId)) {
      model = botId;
    } else {
      model = isSupportedModel(defaults.model) ? defaults.model : FALLBACK_MODEL;
      if (!isSupportedModel(defaults.model)) {
        warnings.push(`DEFAULT_OPENAI_MODEL "${defaults.model}" is not supported; using "${FALLBACK_MODEL}".`);
      }
      if (botId) {
        warnings.push(`Unknown botId "${botId}"; using model "${model}".`);
      }
    }
  }

  let reasoningEffort: ReasoningEffort = 'none';
  if (isReasoningEffort(defaults.reasoningEffort)) {
    reasoningEffort = defaults.reasoningEffort;
  } else {
    warnings.push(`DEFAULT_OPENAI_REASONING_EFFORT "${defaults.reasoningEffort}" is not valid; using "none".`);
  }
  if (params.openai_reasoning_effort) {
    if (isReasoningEffort(params.openai_reasoning_effort)) {
      reasoningEffort = params.openai_reasoning_effort;
    } else {
      warnings.push(`openai_reasoning_effort "${params.openai_reasoning_effort}" is not valid and was ignored.`);
    }
  }

  // The API rejects temperature for GPT-6 models unless reasoning effort is "none".
  let temperature: number | undefined;
  if (reasoningEffort === 'none') {
    temperature = parseTemperature(defaults.temperature);
    if (temperature === undefined) {
      warnings.push('DEFAULT_OPENAI_TEMPERATURE is not a number between 0 and 2; using the OpenAI default.');
    }
    if (params.openai_temperature) {
      const override = parseTemperature(params.openai_temperature);
      if (override !== undefined) {
        temperature = override;
      } else {
        warnings.push(`openai_temperature "${params.openai_temperature}" is not a number between 0 and 2 and was ignored.`);
      }
    }
  } else if (params.openai_temperature) {
    warnings.push(
      `openai_temperature was ignored because reasoning effort is "${reasoningEffort}"; temperature requires reasoning effort "none".`,
    );
  }

  let verbosity: Verbosity | undefined;
  if (isVerbosity(defaults.verbosity)) {
    verbosity = defaults.verbosity;
  } else if (defaults.verbosity) {
    warnings.push(`DEFAULT_OPENAI_VERBOSITY "${defaults.verbosity}" is not valid and was ignored.`);
  }
  if (params.openai_verbosity) {
    if (isVerbosity(params.openai_verbosity)) {
      verbosity = params.openai_verbosity;
    } else {
      warnings.push(`openai_verbosity "${params.openai_verbosity}" is not valid and was ignored.`);
    }
  }

  return { settings: { model, reasoningEffort, temperature, verbosity }, warnings };
}

export function buildResponseCreateParams(args: {
  settings: RequestSettings;
  input: string;
  previousResponseId?: string;
  metadata: Record<string, string>;
  tools: OpenAI.Responses.Tool[];
}): OpenAI.Responses.ResponseCreateParamsNonStreaming {
  const { settings, input, previousResponseId, metadata, tools } = args;
  return {
    model: settings.model,
    input,
    // previous_response_id only works for stored responses.
    store: true,
    reasoning: { effort: settings.reasoningEffort },
    metadata,
    ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
    ...(settings.verbosity ? { text: { verbosity: settings.verbosity } } : {}),
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/**
 * Returns one text per assistant message. Messages in the "commentary" phase (progress notes
 * the model writes while using tools) are skipped unless the response has no other messages.
 */
export function extractReplyTexts(output: OpenAI.Responses.ResponseOutputItem[]): string[] {
  const messages = output.filter(
    (item): item is OpenAI.Responses.ResponseOutputMessage => item.type === 'message',
  );
  const finalMessages = messages.filter(m => m.phase !== 'commentary');
  const selected = finalMessages.length > 0 ? finalMessages : messages;

  return selected
    .map(m => m.content.map(part => (part.type === 'output_text' ? part.text : part.refusal)).join(''))
    .filter(text => text.trim().length > 0);
}

export function mapResponseToGenesys(response: OpenAI.Responses.Response): GenesysTurnResult {
  const warnings: string[] = [];
  const replyMessages: GenesysReplyMessage[] = extractReplyTexts(response.output).map(text => ({
    type: 'Text',
    text,
  }));

  if (response.output.some(item => item.type === 'mcp_approval_request')) {
    warnings.push(
      'OpenAI returned an MCP approval request, which this connector cannot answer. Set "require_approval": "never" on the MCP tool.',
    );
  }

  switch (response.status) {
    case 'completed':
      if (replyMessages.length === 0) {
        warnings.push('OpenAI response completed without any assistant text.');
      }
      return { botState: 'MoreData', replyMessages, keepResponseId: true, warnings };

    case 'incomplete': {
      const reason = response.incomplete_details?.reason ?? 'unknown';
      if (reason === 'max_output_tokens' && replyMessages.length > 0) {
        warnings.push('OpenAI response hit max_output_tokens; returning the partial text.');
        return { botState: 'MoreData', replyMessages, keepResponseId: true, warnings };
      }
      return {
        botState: 'Failed',
        replyMessages: [],
        errorInfo: { errorCode: 'incomplete', errorMessage: `OpenAI response incomplete: ${reason}` },
        keepResponseId: false,
        warnings,
      };
    }

    case 'failed':
      return {
        botState: 'Failed',
        replyMessages: [],
        errorInfo: {
          errorCode: response.error?.code ?? 'failed',
          errorMessage: redactSecrets(response.error?.message ?? 'OpenAI response failed'),
        },
        keepResponseId: false,
        warnings,
      };

    default:
      return {
        botState: 'Failed',
        replyMessages: [],
        errorInfo: {
          errorCode: 'unexpected_status',
          errorMessage: `Unexpected OpenAI response status: ${response.status ?? 'unknown'}`,
        },
        keepResponseId: false,
        warnings,
      };
  }
}

/**
 * Genesys retries 5xx responses, so only transient OpenAI failures (timeouts, connection
 * errors, 429, 5xx) map to 500. Other OpenAI errors end the bot session via botState "Failed".
 */
export function mapOpenAIError(err: unknown): MappedError {
  if (err instanceof APIConnectionTimeoutError) {
    return { httpStatus: 500, errorInfo: { errorCode: 'openai_timeout', errorMessage: 'OpenAI request timed out' } };
  }
  if (err instanceof APIConnectionError) {
    return {
      httpStatus: 500,
      errorInfo: { errorCode: 'openai_connection_error', errorMessage: 'Could not reach the OpenAI API' },
    };
  }
  if (err instanceof APIError) {
    const status = err.status ?? 500;
    const retryable = status === 429 || status >= 500;
    return {
      httpStatus: retryable ? 500 : 200,
      errorInfo: { errorCode: err.code ?? `openai_http_${status}`, errorMessage: redactSecrets(err.message) },
    };
  }
  return {
    httpStatus: 500,
    errorInfo: { errorCode: 'internal_error', errorMessage: 'Internal error while processing the message' },
  };
}

export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof APIError) {
    return {
      errorType: err.name,
      status: err.status,
      code: err.code,
      type: err.type,
      requestId: err.requestID,
      message: redactSecrets(err.message),
    };
  }
  if (err instanceof Error) {
    return {
      errorType: err.name,
      message: redactSecrets(err.message),
      stack: err.stack ? redactSecrets(err.stack) : undefined,
    };
  }
  return { errorType: typeof err };
}
