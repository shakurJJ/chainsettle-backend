import { computeFieldChanges, extractChanges, isHiddenField } from './shipment-diff.util';

describe('shipment diff util (#436)', () => {
  it('records only changed fields for scalars and arrays', () => {
    const changes = computeFieldChanges(
      { description: 'a', referenceNumber: 'PO-1', tags: ['x', 'y'] },
      { description: 'b', referenceNumber: 'PO-1', tags: ['x', 'z'] },
      ['description', 'referenceNumber', 'tags'],
    );
    expect(changes).toEqual([
      { field: 'description', before: 'a', after: 'b' },
      { field: 'tags', before: ['x', 'y'], after: ['x', 'z'] },
    ]);
  });

  it('flattens nested metadata to dot paths', () => {
    const changes = computeFieldChanges(
      { metadata: { incoterms: 'FOB', port: { origin: 'SGP', dest: 'RTM' }, removed: 1 } },
      { metadata: { incoterms: 'FOB', port: { origin: 'SGP', dest: 'HAM' }, added: [1, 2] } },
      ['metadata'],
    );
    expect(changes).toEqual([
      { field: 'metadata.added', before: null, after: [1, 2] },
      { field: 'metadata.port.dest', before: 'RTM', after: 'HAM' },
      { field: 'metadata.removed', before: 1, after: null },
    ]);
  });

  it('handles metadata going from null to an object', () => {
    expect(computeFieldChanges({ metadata: null }, { metadata: { a: 1 } }, ['metadata'])).toEqual([
      { field: 'metadata.a', before: null, after: 1 },
    ]);
  });

  it('returns an empty diff for legacy entries without snapshots', () => {
    expect(extractChanges(null)).toEqual([]);
    expect(extractChanges({ previousTags: ['a'] })).toEqual([]);
    expect(extractChanges({ changes: [{ field: 'description', before: 'a', after: 'b' }] })).toEqual([
      { field: 'description', before: 'a', after: 'b' },
    ]);
  });

  it('hides private metadata keys', () => {
    expect(isHiddenField('metadata.internal.cost')).toBe(true);
    expect(isHiddenField('metadata._note')).toBe(true);
    expect(isHiddenField('metadata.port')).toBe(false);
    expect(isHiddenField('description')).toBe(false);
  });
});
