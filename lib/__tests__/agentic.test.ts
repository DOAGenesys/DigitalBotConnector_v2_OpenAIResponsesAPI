import OpenAI from 'openai';
import { buildFollowUpQuestionParams, buildResponseCreateParams, getFunctionCalls } from '../openai';
import {
  buildEndSessionTool,
  buildFunctionToolFromSchemas,
  redactToolOutputFields,
  sanitizeFunctionName,
} from '../openai-genesys-tools';
import { mergeSessionVariables } from '../session-store';

describe('buildResponseCreateParams (tools and instructions)', () => {
  it('adds instructions, prompt cache key and sequential tool calls when tools are present', () => {
    const params = buildResponseCreateParams({
      settings: { model: 'gpt-6-luna', reasoningEffort: 'low' },
      input: [{ role: 'user', content: 'hi' }],
      previousResponseId: 'resp_prev',
      metadata: { genesys_conversation_id: 'conv-1' },
      tools: [buildEndSessionTool()],
      instructions: 'Be brief.',
      promptCacheKey: 'prefix:gpt-6-luna',
    });
    expect(params).toMatchObject({
      model: 'gpt-6-luna',
      store: true,
      reasoning: { effort: 'low' },
      previous_response_id: 'resp_prev',
      parallel_tool_calls: false,
      instructions: 'Be brief.',
      prompt_cache_key: 'prefix:gpt-6-luna',
    });
    expect(params).not.toHaveProperty('temperature');
  });

  it('omits tool and instruction fields when they are not set', () => {
    const params = buildResponseCreateParams({
      settings: { model: 'gpt-6.1-terra', reasoningEffort: 'none', temperature: 0.2 },
      input: 'hi',
      metadata: {},
      tools: [],
    });
    expect(params).not.toHaveProperty('tools');
    expect(params).not.toHaveProperty('parallel_tool_calls');
    expect(params).not.toHaveProperty('instructions');
    expect(params).not.toHaveProperty('prompt_cache_key');
    expect(params.temperature).toBe(0.2);
  });
});

describe('buildFollowUpQuestionParams', () => {
  it('answers pending function calls before the question and runs without reasoning', () => {
    const pending: OpenAI.Responses.ResponseInputItem.FunctionCallOutput[] = [
      { type: 'function_call_output', call_id: 'call_1', output: 'Session ended.' },
    ];
    const params = buildFollowUpQuestionParams({
      model: 'gpt-6.1-terra',
      question: 'Summarize.',
      previousResponseId: 'resp_1',
      pendingToolOutputs: pending,
      metadata: {},
    });
    expect(params.input).toEqual([pending[0], { role: 'user', content: 'Summarize.' }]);
    expect(params).toMatchObject({ store: false, reasoning: { effort: 'none' }, temperature: 0, previous_response_id: 'resp_1' });
  });
});

describe('getFunctionCalls', () => {
  it('returns only function_call items', () => {
    const output = [
      { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [] },
      { type: 'function_call', id: 'fc', call_id: 'call_1', name: 'end_session', arguments: '{}' },
    ] as unknown as OpenAI.Responses.ResponseOutputItem[];
    expect(getFunctionCalls(output).map(call => call.call_id)).toEqual(['call_1']);
  });
});

describe('mergeSessionVariables', () => {
  it('prefers values from the current turn and keeps stored ones otherwise', () => {
    const merged = mergeSessionVariables(
      { system_prompt: 'stored prompt', openai_model: 'gpt-6-luna' },
      { system_prompt: 'new prompt', data_action_ids: 'a|b', unrelated: 'x' },
    );
    expect(merged).toEqual({ system_prompt: 'new prompt', openai_model: 'gpt-6-luna', data_action_ids: 'a|b' });
  });
});

describe('Genesys Data Action tools', () => {
  it('builds a function tool with a sanitized name', () => {
    expect(sanitizeFunctionName('custom_-_1A2b')).toBe('custom_1a2b');
    const tool = buildFunctionToolFromSchemas(
      'custom_-_1A2b',
      { type: 'object', properties: { orderId: { type: 'string', description: 'Order number' } } },
      'Look up an order',
    );
    expect(tool).toMatchObject({ type: 'function', name: 'genesys_data_action_custom_1a2b', strict: false });
    expect(tool.description).toBe('Look up an order. Input fields: orderId: Order number');
  });

  it('redacts configured fields in tool outputs', () => {
    const redacted = redactToolOutputFields({ customer: { email: 'a@example.com', id: 1 }, status: 'ok' }, 'customer.email, missing.path');
    expect(redacted).toEqual({ customer: { email: '[REDACTED]', id: 1 }, status: 'ok' });
  });
});
