import type OpenAI from 'openai';
import { getConfig } from './config';

type JsonSchema = { [key: string]: any };

export const END_SESSION_TOOL_NAME = 'end_session';

export function sanitizeFunctionName(id: string): string {
  let name = id.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  name = name.replace(/_+/g, '_');
  if (!/^[a-z]/.test(name)) name = `a_${name}`;
  if (name.length > 60) name = name.substring(0, 60);
  return name;
}

export function buildEndSessionTool(): OpenAI.Responses.FunctionTool {
  return {
    type: 'function',
    name: END_SESSION_TOOL_NAME,
    description:
      'Ends the conversation with the user. This tool should be called when the user indicates they are finished, their request has been fully addressed, they ask to speak to a human agent, they express significant anger or frustration, or if they are abusing the service.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'A concluding message to the user, e.g., "Goodbye!" or "Your request has been processed."',
        },
      },
      required: ['message'],
    },
    strict: false,
  };
}

export function buildFunctionToolFromSchemas(
  id: string,
  inputSchema: JsonSchema,
  customDescription?: string,
): OpenAI.Responses.FunctionTool {
  const name = `genesys_data_action_${sanitizeFunctionName(id)}`;
  const fieldSummaries: string[] = [];
  if (inputSchema && inputSchema.properties && typeof inputSchema.properties === 'object') {
    for (const key of Object.keys(inputSchema.properties)) {
      const prop: any = inputSchema.properties[key];
      const desc = typeof prop.description === 'string' ? prop.description : '';
      fieldSummaries.push(`${key}${desc ? `: ${desc}` : ''}`);
    }
  }

  const description = customDescription
    ? `${customDescription}. Input fields: ${fieldSummaries.join('; ')}`
    : `Executes the Genesys Cloud Data Action ${id}. Use this when user requests data aligned to this action's domain. Input fields: ${fieldSummaries.join('; ')}`;

  const config = getConfig();
  const parameters = normalizeParametersSchema(inputSchema, config.GENESYS_TOOLS_STRICT_MODE === true);

  return {
    type: 'function',
    name,
    description,
    parameters,
    strict: config.GENESYS_TOOLS_STRICT_MODE === true,
  };
}

/** Replaces the values at the given dot paths (comma-separated) with "[REDACTED]". */
export function redactToolOutputFields(obj: unknown, redactPathsCsv?: string): unknown {
  if (!redactPathsCsv || obj === null || typeof obj !== 'object') return obj;
  const result = JSON.parse(JSON.stringify(obj));
  const paths = redactPathsCsv.split(',').map(s => s.trim()).filter(Boolean);
  for (const p of paths) {
    const parts = p.split('.');
    let curr: any = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (curr && typeof curr === 'object') curr = curr[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    if (curr && typeof curr === 'object' && Object.prototype.hasOwnProperty.call(curr, leaf)) {
      curr[leaf] = '[REDACTED]';
    }
  }
  return result;
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function enforceStrictObjectSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  const copy = deepClone(schema);
  if (copy.type === 'object') {
    // OpenAI strict mode requires additionalProperties: false
    copy.additionalProperties = false;
    if (!copy.properties || typeof copy.properties !== 'object') copy.properties = {};
    const props = copy.properties;

    // Recursively enforce strict mode on nested objects
    for (const k of Object.keys(props)) {
      props[k] = enforceStrictObjectSchema(props[k]);
    }

    // OpenAI strict mode requires ALL properties to be in required array
    copy.required = Object.keys(props);
  } else if (copy.type === 'array' && copy.items) {
    copy.items = enforceStrictObjectSchema(copy.items);
  }
  return copy;
}

function normalizeParametersSchema(inputSchema: any, strictMode: boolean): any {
  const base = {
    ...(inputSchema || {}),
    type: 'object',
    properties: (inputSchema && inputSchema.properties) || {},
  };
  if (!strictMode) return base;
  try {
    return enforceStrictObjectSchema(base);
  } catch {
    return base;
  }
}
