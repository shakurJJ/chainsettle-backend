import 'reflect-metadata';
import { buildSchema, parse, validate, specifiedRules } from 'graphql';
import { computeComplexity, depthLimitRule, complexityLimitPlugin } from './graphql-limits';

const schema = buildSchema(`
  type Proof { id: ID! ipfsCid: String! }
  type Milestone { id: ID! name: String! proofSubmissions: [Proof!]! shipment: Shipment! }
  type Shipment { id: ID! status: String! milestones: [Milestone!]! }
  type Query { shipment(id: ID!): Shipment shipments(limit: Int): [Shipment!]! }
`);

const validateDepth = (q: string, max = 7) => validate(schema, parse(q), [...specifiedRules, depthLimitRule(max)]);

describe('GraphQL limits (#432)', () => {
  it('allows normal queries', () => {
    const q = '{ shipment(id: "1") { id milestones { id proofSubmissions { ipfsCid } } } }';
    expect(validateDepth(q)).toHaveLength(0);
    expect(computeComplexity(schema, parse(q))).toBeLessThan(1000);
  });

  it('rejects queries deeper than the limit', () => {
    const q = '{ shipment(id: "1") { milestones { shipment { milestones { shipment { milestones { shipment { id } } } } } } } }';
    const errors = validateDepth(q);
    expect(errors).toHaveLength(1);
    expect(errors[0].extensions).toMatchObject({ code: 'QUERY_TOO_DEEP', depth: 8, maxDepth: 7 });
  });

  it('counts fragments toward depth', () => {
    const q = 'fragment F on Milestone { shipment { milestones { id } } } { shipment(id: "1") { milestones { ...F } } }';
    expect(validateDepth(q, 5)).toHaveLength(0);
    expect(validateDepth(q, 4)).toHaveLength(1);
  });

  it('multiplies list costs by the requested limit', () => {
    const small = computeComplexity(schema, parse('{ shipments(limit: 2) { id } }'));
    const big = computeComplexity(schema, parse('{ shipments(limit: 200) { id } }'));
    expect(big).toBeGreaterThan(small);
  });

  it('rejects over-complex operations before execution with the computed cost', async () => {
    const plugin = complexityLimitPlugin(1000);
    const listeners: any = await plugin.requestDidStart!({ schema } as any);
    const document = parse('{ shipments(limit: 100) { milestones { proofSubmissions { id } } } }');
    await expect(listeners.didResolveOperation({ request: { variables: {} }, document })).rejects.toMatchObject({
      extensions: { code: 'QUERY_TOO_COMPLEX', maxComplexity: 1000 },
    });
    await expect(
      listeners.didResolveOperation({ request: { variables: {} }, document: parse('{ shipment(id: "1") { id } }') }),
    ).resolves.toBeUndefined();
  });
});
