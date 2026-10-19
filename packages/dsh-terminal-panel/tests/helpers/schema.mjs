/**
 * Tiny JSON-Schema validator for the supported tool-schema subset
 * (type / oneOf / properties / required / additionalProperties / items /
 * enum / const). Test-only: the host relies on the DSH tools registry for the
 * real validation, and this helper lets unit tests prove that returned values
 * conform to the declared output schemas.
 */

/**
 * @param {any} schema schema node.
 * @param {any} value candidate value.
 * @param {string} [path] diagnostic path.
 * @returns {string[]} violations (empty means valid).
 */
export function validateValue(schema, value, path = 'value') {
  const violations = []
  if (schema === true || schema === undefined) return violations
  if (schema === null || typeof schema !== 'object') return [`${path}: schema is not an object`]
  if (Array.isArray(schema.oneOf)) {
    if (schema.type !== undefined) violations.push(`${path}: oneOf cannot be combined with type`)
    const matched = schema.oneOf.filter((branch) => validateValue(branch, value, path).length === 0).length
    if (matched !== 1) violations.push(`${path}: must match exactly one oneOf branch (matched ${matched})`)
    return violations
  }
  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    violations.push(`${path}: expected type ${schema.type}, got ${describe(value)}`)
    return violations
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    violations.push(`${path}: expected const ${JSON.stringify(schema.const)}`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => entry === value)) {
    violations.push(`${path}: expected one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`)
  }
  if (schema.type === 'object' && schema.properties !== undefined) {
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) {
      if (!Object.hasOwn(value, key)) violations.push(`${path}: missing required property "${key}"`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) violations.push(`${path}: unexpected property "${key}"`)
      }
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key)) violations.push(...validateValue(child, value[key], `${path}.${key}`))
    }
  }
  if (schema.type === 'array' && schema.items !== undefined && Array.isArray(value)) {
    value.forEach((entry, index) => violations.push(...validateValue(schema.items, entry, `${path}[${index}]`)))
  }
  return violations
}

/**
 * @param {string} type JSON schema type.
 * @param {any} value candidate.
 * @returns {boolean} whether the value matches.
 */
function matchesType(type, value) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return Number.isInteger(value)
    case 'null':
      return value === null
    default:
      return false
  }
}

/**
 * @param {any} value candidate.
 * @returns {string} short description for diagnostics.
 */
function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * The foreground branch of the built-in pwsh/bash tool output schema.
 * Kept in the test suite so a change in the returned value shape fails loudly.
 */
export const FOREGROUND_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'foreground' },
    cwd: { type: 'string' },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    timedOut: { type: 'boolean' },
    aborted: { type: 'boolean' },
    stopped: { type: 'string' },
    timeoutMs: { type: 'number' },
    stdout: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        spillPath: { type: 'string' },
      },
      required: ['text', 'truncated'],
    },
    stderr: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        spillPath: { type: 'string' },
      },
      required: ['text', 'truncated'],
    },
    sandbox: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string' },
        denied: { type: 'boolean' },
        enforcement: { type: 'string' },
        runnerFailed: { type: 'boolean' },
      },
      required: ['mode', 'denied'],
    },
  },
  required: ['kind', 'cwd', 'exitCode', 'signal', 'timedOut', 'aborted', 'timeoutMs', 'stdout', 'stderr'],
}
