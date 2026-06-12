import { validateUserDraft } from '../logic/validation';
import type { UserDraft, ValidationCatalogs } from '../logic/validation';
import { branches, businessDepts } from '../data/businesses';
import { BIZ_MODULES, MODULES } from '../constants/modules';

const cat: ValidationCatalogs = { branches, businessDepts, bizModules: BIZ_MODULES, modules: MODULES };

const base: UserDraft = {
  name: '', email: '', role: 'EMPLOYEE', bizId: 'tk',
  branches: [], accessGroups: [], accessDepts: [], accessAlerts: [],
};

describe('user creation validation', () => {
  it('SUPER_ADMIN valid with just name + email (no grants needed)', () => {
    const r = validateUserDraft({ ...base, role: 'SUPER_ADMIN', bizId: null, name: 'A', email: 'a@x.com' }, cat);
    expect(r.valid).toBe(true);
  });

  it('EMPLOYEE invalid until branch + group + dept + alert all selected', () => {
    let d: UserDraft = { ...base, name: 'Emp', email: 'e@x.com' };
    expect(validateUserDraft(d, cat).valid).toBe(false);          // no branch
    d = { ...d, branches: ['AMD'] };
    const r = validateUserDraft(d, cat);
    expect(r.branchOK).toBe(true);
    expect(r.valid).toBe(false);                                  // groups/depts/alerts missing
    d = { ...d, accessGroups: ['AMD-Accounts'] };
    expect(validateUserDraft(d, cat).valid).toBe(false);          // depts/alerts missing
    d = { ...d, accessDepts: ['AMD-Accounts'] };
    expect(validateUserDraft(d, cat).valid).toBe(false);          // alerts missing
    d = { ...d, accessAlerts: ['AMD-crm'] };
    expect(validateUserDraft(d, cat).valid).toBe(true);           // complete
  });

  it('required branch selection enforced (tk has branches)', () => {
    const r = validateUserDraft({ ...base, name: 'X', email: 'x@x.com', branches: [] }, cat);
    expect(r.hasBranches).toBe(true);
    expect(r.branchOK).toBe(false);
  });

  it('availability is branch-qualified across selected branches', () => {
    const r = validateUserDraft({ ...base, name: 'X', email: 'x@x.com', branches: ['AMD', 'BOM'] }, cat);
    expect(r.groupsAvail).toContain('AMD-Accounts');
    expect(r.groupsAvail).toContain('BOM-MKTG');
    expect(r.deptsAvailIds).toContain('AMD-Ticketing');
    expect(r.alertsAvailIds).toContain('BOM-crm');
  });

  it('name/email required regardless of role', () => {
    expect(validateUserDraft({ ...base, role: 'SUPER_ADMIN', bizId: null, name: '', email: '' }, cat).valid).toBe(false);
  });
});
