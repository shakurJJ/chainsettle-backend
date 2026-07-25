export const incotermsSchema = {
  type: 'object',
  properties: {
    incotermCode: { type: 'string', minLength: 3, maxLength: 3 },
    portOfOrigin: { type: 'string' },
    portOfDestination: { type: 'string' },
  },
  required: ['incotermCode'],
  additionalProperties: true,
};

export const customsSchema = {
  type: 'object',
  properties: {
    customsValue: { type: 'number' },
    hsCode: { type: 'string' },
    countryOfOrigin: { type: 'string' },
  },
  required: ['hsCode', 'customsValue'],
  additionalProperties: true,
};

export const metadataSchemas = {
  incoterms: incotermsSchema,
  customs: customsSchema,
};
