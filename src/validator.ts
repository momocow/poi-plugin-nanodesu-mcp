export type JsonSchemaValidatorResult<T> =
  | { valid: true; data: T; errorMessage: undefined }
  | { valid: false; data: undefined; errorMessage: string }

export type SchemaValidatorProvider = {
  getValidator<T>(schema: Record<string, unknown>): (input: unknown) => JsonSchemaValidatorResult<T>
}

/**
 * Replaces the SDK's default Ajv-based validator.
 *
 * The SDK bundles ajv 8, but poi prepends its own node_modules to the module
 * search path for anything outside poi (see setAllowedPath in lib/module-path),
 * so `require('ajv')` inside the SDK's dependencies resolves poi's ajv 6
 * instead. ajv 6 keeps its options on `_opts` rather than `opts`, and
 * ajv-formats reads `ajv.opts.code` — so constructing an McpServer inside poi
 * threw `Cannot read properties of undefined (reading 'code')` on every
 * request.
 *
 * Passing any validator short-circuits that construction entirely
 * (`options?.jsonSchemaValidator ?? new AjvJsonSchemaValidator()`).
 *
 * This validator accepts everything, which is safe *only* because the SDK uses
 * it in exactly one place: validating a client's response to an elicitation
 * request. This server never elicits — it exposes three read-only tools and no
 * sampling or elicitation — so it is never called.
 *
 * If elicitation is ever added here, this must be replaced with a real
 * JSON Schema validator.
 */
export const passthroughValidator: SchemaValidatorProvider = {
  getValidator<T>(_schema: Record<string, unknown>) {
    return (input: unknown): JsonSchemaValidatorResult<T> => ({
      valid: true,
      data: input as T,
      errorMessage: undefined,
    })
  },
}
