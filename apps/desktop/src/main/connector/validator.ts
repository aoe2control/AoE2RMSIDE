export type ConnectorJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ConnectorJsonValue[]
  | { readonly [key: string]: ConnectorJsonValue };

export type ConnectorToolArguments = { readonly [key: string]: ConnectorJsonValue };

export interface ConnectorSchemaNode {
  type: 'object' | 'string' | 'integer' | 'boolean' | 'array';
  description?: string;
  default?: ConnectorJsonValue;
  enum?: readonly string[];
  properties?: Readonly<Record<string, ConnectorSchemaNode>>;
  required?: readonly string[];
  additionalProperties?: false;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  items?: ConnectorSchemaNode;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export type ConnectorValidation =
  { ok: true; value: ConnectorToolArguments } | { ok: false; field: string; message: string };

export const maximumArgumentDepth = 16;

const keywords: Readonly<Record<ConnectorSchemaNode['type'], readonly string[]>> = {
  object: ['properties', 'required', 'additionalProperties'],
  string: ['minLength', 'maxLength', 'pattern'],
  integer: ['minimum', 'maximum'],
  boolean: [],
  array: ['items', 'minItems', 'maxItems', 'uniqueItems'],
};
const commonKeywords = ['type', 'description', 'default', 'enum'];

class Invalid extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

class SchemaUnsupported extends Error {}

const patternCache = new Map<string, RegExp>();

function patternFor(source: string): RegExp {
  let pattern = patternCache.get(source);
  if (!pattern) {
    pattern = new RegExp(source, 'u');
    patternCache.set(source, pattern);
  }
  return pattern;
}

function checkKeywords(schema: ConnectorSchemaNode): void {
  const allowed = keywords[schema.type];
  if (!allowed) throw new SchemaUnsupported(`unsupported schema type ${String(schema.type)}`);
  for (const key of Object.keys(schema)) {
    if (!commonKeywords.includes(key) && !allowed.includes(key)) {
      throw new SchemaUnsupported(`unsupported schema keyword ${key}`);
    }
  }
}

export function codePoints(text: string): number {
  let count = text.length;
  for (let index = 0; index < text.length - 1; index += 1) {
    const unit = text.charCodeAt(index);
    const next = text.charCodeAt(index + 1);
    if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      count -= 1;
      index += 1;
    }
  }
  return count;
}

function describe(path: string): string {
  return path === '' ? 'the arguments' : path;
}

function validateNode(
  value: unknown,
  schema: ConnectorSchemaNode,
  path: string,
): ConnectorJsonValue {
  checkKeywords(schema);
  const field = describe(path);
  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Invalid(field, `${field} must be an object`);
      }
      const input = value as Record<string, unknown>;
      const properties = schema.properties ?? {};
      if (schema.additionalProperties !== false) {
        throw new SchemaUnsupported('object schemas must refuse additional properties');
      }
      for (const key of Object.keys(input)) {
        if (!Object.hasOwn(properties, key)) {
          const name = path === '' ? key : `${path}.${key}`;
          throw new Invalid(name, `${name} is not a known argument`);
        }
      }
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(input, key)) {
          const name = path === '' ? key : `${path}.${key}`;
          throw new Invalid(name, `${name} is required`);
        }
      }
      const output: Record<string, ConnectorJsonValue> = {};
      for (const [key, child] of Object.entries(properties)) {
        const name = path === '' ? key : `${path}.${key}`;
        if (Object.hasOwn(input, key)) {
          output[key] = validateNode(input[key], child, name);
        } else if (child.default !== undefined) {
          output[key] = structuredClone(child.default);
        }
      }
      return output;
    }
    case 'string': {
      if (typeof value !== 'string') throw new Invalid(field, `${field} must be a string`);
      if (schema.enum !== undefined) {
        if (!schema.enum.includes(value)) {
          const shown = schema.enum.length <= 16 ? `: ${schema.enum.join(', ')}` : '';
          throw new Invalid(field, `${field} must be one of the allowed values${shown}`);
        }
        return value;
      }
      const length = codePoints(value);
      if (schema.minLength !== undefined && length < schema.minLength) {
        throw new Invalid(field, `${field} must have at least ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && length > schema.maxLength) {
        throw new Invalid(field, `${field} must have at most ${schema.maxLength} characters`);
      }
      if (schema.pattern !== undefined && !patternFor(schema.pattern).test(value)) {
        throw new Invalid(field, `${field} is not in the expected form`);
      }
      return value;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new Invalid(field, `${field} must be an integer`);
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        throw new Invalid(field, `${field} must be at least ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        throw new Invalid(field, `${field} must be at most ${schema.maximum}`);
      }
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw new Invalid(field, `${field} must be true or false`);
      return value;
    case 'array': {
      if (!Array.isArray(value)) throw new Invalid(field, `${field} must be a list`);
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        throw new Invalid(field, `${field} must have at least ${schema.minItems} items`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        throw new Invalid(field, `${field} must have at most ${schema.maxItems} items`);
      }
      if (!schema.items) throw new SchemaUnsupported('array schemas must name their items');
      const items = value.map((item, index) =>
        validateNode(item, schema.items!, `${path}[${index}]`),
      );
      if (schema.uniqueItems === true) {
        const seen = new Set<string>();
        for (const [index, item] of items.entries()) {
          const key = JSON.stringify(item);
          if (seen.has(key)) {
            throw new Invalid(`${path}[${index}]`, `${field} must not repeat an item`);
          }
          seen.add(key);
        }
      }
      return items;
    }
  }
}

function nestsTooDeep(text: string, maximum: number): boolean {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charCodeAt(index);
    if (inString) {
      if (character === 0x5c) index += 1;
      else if (character === 0x22) inString = false;
    } else if (character === 0x22) {
      inString = true;
    } else if (character === 0x7b || character === 0x5b) {
      depth += 1;
      if (depth > maximum) return true;
    } else if (character === 0x7d || character === 0x5d) {
      depth -= 1;
    }
  }
  return false;
}

export function validateToolArguments(
  value: unknown,
  schema: ConnectorSchemaNode,
): ConnectorValidation {
  try {
    if (schema.type !== 'object')
      throw new SchemaUnsupported('tool input must be an object schema');
    return { ok: true, value: validateNode(value, schema, '') as ConnectorToolArguments };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, field: error.field, message: error.message };
    throw error;
  }
}

export function parseToolArguments(
  argumentsJson: string,
  schema: ConnectorSchemaNode,
  maximumBytes: number,
): ConnectorValidation {
  if (Buffer.byteLength(argumentsJson, 'utf8') > maximumBytes) {
    return { ok: false, field: 'the arguments', message: 'the arguments are too large' };
  }
  if (nestsTooDeep(argumentsJson, maximumArgumentDepth)) {
    return { ok: false, field: 'the arguments', message: 'the arguments nest too deeply' };
  }
  let value: unknown;
  try {
    value = JSON.parse(argumentsJson);
  } catch {
    return { ok: false, field: 'the arguments', message: 'the arguments are not valid JSON' };
  }
  return validateToolArguments(value, schema);
}
