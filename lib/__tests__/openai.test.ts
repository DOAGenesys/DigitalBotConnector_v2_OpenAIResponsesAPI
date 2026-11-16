import OpenAI, { APIConnectionTimeoutError, APIError } from 'openai';
import {
  buildResponseCreateParams,
  extractReplyTexts,
  mapOpenAIError,
  mapResponseToGenesys,
  redactSecrets,
  RequestDefaults,
  resolveRequestSettings,
} from '../openai';

const defaults: RequestDefaults = { model: 'gpt-6.1-terra', reasoningEffort: 'none', temperature: 0.7 };

function message(text: string, phase?: 'commentary' | 'final_answer'): OpenAI.Responses.ResponseOutputMessage {
  return {
    id: `msg_${text.length}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    phase,
    content: [{ type: 'output_text', text, annotations: [] }],
  } as OpenAI.Responses.ResponseOutputMessage;
}

function response(overrides: Partial<OpenAI.Responses.Response>): OpenAI.Responses.Response {
  return {
    id: 'resp_test',
    object: 'response',
    status: 'completed',
    output: [],
    error: null,
    incomplete_details: null,
    ...overrides,
  } as OpenAI.Responses.Response;
}

describe('resolveRequestSettings', () => {
  it('uses the bot model and sends temperature when reasoning effort is none', () => {
    const { settings, warnings } = resolveRequestSettings('gpt-6-luna', undefined, defaults);
    expect(settings).toEqual({ model: 'gpt-6-luna', reasoningEffort: 'none', temperature: 0.7, verbosity: undefined });
    expect(warnings).toEqual([]);
  });

  it('lets session variables override model, effort and verbosity', () => {
    const { settings, warnings } = resolveRequestSettings(
      'gpt-6.1-terra',
      { openai_model: 'gpt-6-luna', openai_reasoning_effort: 'high', openai_verbosity: 'low' },
      defaults,
    );
    expect(settings).toEqual({ model: 'gpt-6-luna', reasoningEffort: 'high', temperature: undefined, verbosity: 'low' });
    expect(warnings).toEqual([]);
  });

  it('ignores models other than Luna and Terra', () => {
    const { settings, warnings } = resolveRequestSettings('gpt-6-luna', { openai_model: 'gpt-4o' }, defaults);
    expect(settings.model).toBe('gpt-6-luna');
    expect(warnings).toHaveLength(1);
  });

  it('falls back to the default model for unknown bots', () => {
    const { settings, warnings } = resolveRequestSettings('gpt-4.1-mini', undefined, defaults);
    expect(settings.model).toBe('gpt-6.1-terra');
    expect(warnings).toHaveLength(1);
  });

  it('replaces an unsupported default model with the fallback model', () => {
    const { settings } = resolveRequestSettings(undefined, undefined, { ...defaults, model: 'gpt-4o' });
    expect(settings.model).toBe('gpt-6.1-terra');
  });

  it('drops temperature when reasoning effort is not none', () => {
    const { settings, warnings } = resolveRequestSettings(
      'gpt-6-luna',
      { openai_reasoning_effort: 'low', openai_temperature: '0.2' },
      defaults,
    );
    expect(settings.temperature).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('applies a valid temperature override and rejects invalid values', () => {
    expect(resolveRequestSettings('gpt-6-luna', { openai_temperature: '0.2' }, defaults).settings.temperature).toBe(0.2);

    const invalid = resolveRequestSettings('gpt-6-luna', { openai_temperature: 'hot' }, defaults);
    expect(invalid.settings.temperature).toBe(0.7);
    expect(invalid.warnings).toHaveLength(1);
  });

  it('rejects unknown reasoning effort and verbosity values', () => {
    const { settings, warnings } = resolveRequestSettings(
      'gpt-6-luna',
      { openai_reasoning_effort: 'minimal', openai_verbosity: 'chatty' },
      defaults,
    );
    expect(settings.reasoningEffort).toBe('none');
    expect(settings.verbosity).toBeUndefined();
    expect(warnings).toHaveLength(2);
  });
});

describe('buildResponseCreateParams', () => {
  it('builds a stored request with reasoning and optional fields only when set', () => {
    const params = buildResponseCreateParams({
      settings: { model: 'gpt-6-luna', reasoningEffort: 'low' },
      input: 'Hello',
      metadata: { genesys_conversation_id: 'conv-1' },
      tools: [],
    });
    expect(params).toEqual({
      model: 'gpt-6-luna',
      input: 'Hello',
      store: true,
      reasoning: { effort: 'low' },
      metadata: { genesys_conversation_id: 'conv-1' },
    });
  });

  it('includes temperature, verbosity, previous_response_id and tools when provided', () => {
    const tools: OpenAI.Responses.Tool[] = [{ type: 'web_search' }];
    const params = buildResponseCreateParams({
      settings: { model: 'gpt-6.1-terra', reasoningEffort: 'none', temperature: 0.5, verbosity: 'low' },
      input: 'Hello',
      previousResponseId: 'resp_prev',
      metadata: { genesys_conversation_id: 'conv-1' },
      tools,
    });
    expect(params).toMatchObject({
      temperature: 0.5,
      text: { verbosity: 'low' },
      previous_response_id: 'resp_prev',
      tools,
    });
  });
});

describe('extractReplyTexts', () => {
  it('skips commentary messages when a final answer exists', () => {
    expect(extractReplyTexts([message('Checking...', 'commentary'), message('Here you go.', 'final_answer')])).toEqual([
      'Here you go.',
    ]);
  });

  it('keeps commentary when it is the only text and maps refusals', () => {
    const refusal = {
      ...message(''),
      content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
    } as OpenAI.Responses.ResponseOutputMessage;
    expect(extractReplyTexts([message('Only commentary', 'commentary')])).toEqual(['Only commentary']);
    expect(extractReplyTexts([refusal])).toEqual(['I cannot help with that.']);
  });
});

describe('mapResponseToGenesys', () => {
  it('maps a completed response to MoreData with text replies', () => {
    const result = mapResponseToGenesys(response({ output: [message('Hi there!')] }));
    expect(result).toMatchObject({
      botState: 'MoreData',
      replyMessages: [{ type: 'Text', text: 'Hi there!' }],
      keepResponseId: true,
    });
  });

  it('returns partial text for max_output_tokens and fails other incomplete reasons', () => {
    const truncated = mapResponseToGenesys(
      response({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [message('Partial')] }),
    );
    expect(truncated.botState).toBe('MoreData');
    expect(truncated.keepResponseId).toBe(true);

    const filtered = mapResponseToGenesys(
      response({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [message('Partial')] }),
    );
    expect(filtered).toMatchObject({ botState: 'Failed', replyMessages: [], keepResponseId: false });
    expect(filtered.errorInfo?.errorMessage).toContain('content_filter');
  });

  it('maps failed responses to Failed and does not keep the response ID', () => {
    const result = mapResponseToGenesys(
      response({ status: 'failed', error: { code: 'server_error', message: 'Something broke' } }),
    );
    expect(result).toMatchObject({
      botState: 'Failed',
      keepResponseId: false,
      errorInfo: { errorCode: 'server_error', errorMessage: 'Something broke' },
    });
  });

  it('warns when an MCP tool is waiting for approval', () => {
    const output = [{ type: 'mcp_approval_request', id: 'mcpr_1' }] as unknown as OpenAI.Responses.ResponseOutputItem[];
    expect(mapResponseToGenesys(response({ output })).warnings).toHaveLength(2);
  });
});

describe('mapOpenAIError', () => {
  it('returns 200 for non-retryable API errors and redacts keys from the message', () => {
    const err = APIError.generate(
      401,
      { error: { message: 'Incorrect API key provided: sk-test-xxxxxxxx1234.', code: 'invalid_api_key' } },
      undefined,
      new Headers(),
    );
    const mapped = mapOpenAIError(err);
    expect(mapped.httpStatus).toBe(200);
    expect(mapped.errorInfo.errorCode).toBe('invalid_api_key');
    expect(mapped.errorInfo.errorMessage).not.toContain('xxxxxxxx1234');
  });

  it('returns 500 for rate limits, timeouts and unknown errors', () => {
    const rateLimited = APIError.generate(429, { error: { message: 'Rate limit reached' } }, undefined, new Headers());
    expect(mapOpenAIError(rateLimited).httpStatus).toBe(500);
    expect(mapOpenAIError(new APIConnectionTimeoutError()).errorInfo.errorCode).toBe('openai_timeout');
    expect(mapOpenAIError(new Error('boom'))).toEqual({
      httpStatus: 500,
      errorInfo: { errorCode: 'internal_error', errorMessage: 'Internal error while processing the message' },
    });
  });
});

describe('redactSecrets', () => {
  it('masks API keys and bearer tokens', () => {
    expect(redactSecrets('key sk-proj-abc123def456 and Bearer abc.def-ghi')).toBe('key sk-*** and Bearer ***');
  });
});
