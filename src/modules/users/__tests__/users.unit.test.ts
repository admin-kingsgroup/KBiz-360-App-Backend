import { deriveInitials, validateDraft } from '../users.service';
import type { UserDraft } from '../../../domain/logic/validation';

const base: UserDraft = {
  name: '', email: '', role: 'EMPLOYEE', bizId: 'tk',
  branches: [], accessGroups: [], accessDepts: [], accessAlerts: [],
};

describe('Users module — validation parity (uses validateUserDraft verbatim)', () => {
  it('SUPER_ADMIN valid with just name + email', () => {
    expect(validateDraft({ ...base, role: 'SUPER_ADMIN', bizId: null, name: 'A', email: 'a@x.com' }).valid).toBe(true);
  });

  it('EMPLOYEE invalid until branch + group + dept + alert all selected', () => {
    let d: UserDraft = { ...base, name: 'Emp', email: 'e@x.com' };
    expect(validateDraft(d).valid).toBe(false);
    d = { ...d, branches: ['AMD'] };
    expect(validateDraft(d).valid).toBe(false);
    d = { ...d, accessGroups: ['AMD-Accounts'] };
    expect(validateDraft(d).valid).toBe(false);
    d = { ...d, accessDepts: ['AMD-Accounts'] };
    expect(validateDraft(d).valid).toBe(false);
    d = { ...d, accessAlerts: ['AMD-crm'] };
    expect(validateDraft(d).valid).toBe(true);
  });

  it('name/email required regardless of role', () => {
    expect(validateDraft({ ...base, role: 'SUPER_ADMIN', bizId: null, name: '', email: '' }).valid).toBe(false);
  });
});

describe('deriveInitials', () => {
  it('two words → first letter of each', () => {
    expect(deriveInitials('Afshin Dhanani')).toBe('AD');
  });
  it('one word → first two letters', () => {
    expect(deriveInitials('Rohan')).toBe('RO');
  });
  it('trims + collapses whitespace', () => {
    expect(deriveInitials('  Farhan   Aga ')).toBe('FA');
  });
});
