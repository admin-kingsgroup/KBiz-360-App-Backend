import { guardReadOnly } from '../crm.repo';

// The CRM read handle must pass reads through unchanged but refuse every write op, so a stray
// insert/update/delete can never mutate the shared CRM/ERP source-of-truth via the read path.
describe('CRM read-only guard', () => {
  const makeFake = () => ({
    find: jest.fn(() => 'cursor'),
    findOne: jest.fn(() => Promise.resolve({ ok: true })),
    countDocuments: jest.fn(() => Promise.resolve(3)),
    insertOne: jest.fn(),
    updateOne: jest.fn(),
    deleteMany: jest.fn(),
    bulkWrite: jest.fn(),
    drop: jest.fn(),
  });

  it('passes read methods straight through to the collection', () => {
    const fake = makeFake();
    const guarded = guardReadOnly(fake);
    expect(guarded.find({})).toBe('cursor');
    expect(fake.find).toHaveBeenCalledTimes(1);
    void guarded.countDocuments({});
    expect(fake.countDocuments).toHaveBeenCalledTimes(1);
  });

  it('throws on write methods instead of mutating the CRM', () => {
    const fake = makeFake();
    const guarded = guardReadOnly(fake);
    expect(() => guarded.insertOne({})).toThrow(/read-only/i);
    expect(() => guarded.updateOne({}, {})).toThrow(/read-only/i);
    expect(() => guarded.deleteMany({})).toThrow(/read-only/i);
    expect(() => guarded.bulkWrite([])).toThrow(/read-only/i);
    expect(() => guarded.drop()).toThrow(/read-only/i);
    // None of the underlying write ops were reached.
    expect(fake.insertOne).not.toHaveBeenCalled();
    expect(fake.updateOne).not.toHaveBeenCalled();
    expect(fake.deleteMany).not.toHaveBeenCalled();
  });
});
