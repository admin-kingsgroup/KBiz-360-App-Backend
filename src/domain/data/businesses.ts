import type { Branch, Business, Department } from '../types';

// Org structure used by access filters & validation. Values copied from source.
export const businesses: Business[] = [
  { id: 'tk',  code: 'TK',  name: 'Travkings',          color: '#9A6CF0', branches: 3, status: 'active', unread: 0, active: true },
  { id: 'qa',  code: 'QA',  name: 'Quin Aliza',         color: '#37B6A4', branches: 0, status: 'setup',  unread: 3 },
  { id: 'hk',  code: 'HK',  name: 'Hotel Kings Palace', color: '#4F8BFF', branches: 0, status: 'setup',  unread: 8 },
  { id: 'kd',  code: 'KD',  name: 'KB Developers',      color: '#E8A13A', branches: 0, status: 'setup',  unread: 0 },
  { id: 'adb', code: 'ADB', name: 'ADB',                color: '#E3674E', branches: 0, status: 'setup',  unread: 2 },
  { id: 'ndb', code: 'NDB', name: 'NDB',                color: '#2FB36B', branches: 0, status: 'setup',  unread: 0 },
  { id: 'kl',  code: 'KL',  name: 'Kings Logistics',    color: '#DB2777', branches: 0, status: 'setup',  unread: 0 },
];

const tkGroups = (codePfx: string) => ([
  { id: `${codePfx}-acc`, name: 'Accounts',  icon: '$',  color: '#E8A13A' },
  { id: `${codePfx}-tkt`, name: 'Ticketing', icon: '✈',  color: '#4F8BFF' },
  { id: `${codePfx}-hol`, name: 'Holidays',  icon: '☼',  color: '#37B6A4' },
  { id: `${codePfx}-bm`,  name: 'BM MGMT',   icon: 'BM', color: '#0C0E14' },
  { id: `${codePfx}-mkt`, name: 'MKTG',      icon: '★',  color: '#EC4899' },
]);

// Only Travkings (tk) has branches in the current app.
export const branches: Branch[] = [
  { id: 'amd', code: 'AMD', city: 'Ahmedabad', country: 'India', flag: '🇮🇳', tz: 'Asia/Kolkata',  lat: 23.0225, lng: 72.5714, radius: 150, wifi: 'TK-AMD-Office', color: '#9A6CF0', groups: tkGroups('amd') },
  { id: 'bom', code: 'BOM', city: 'Mumbai',    country: 'India', flag: '🇮🇳', tz: 'Asia/Kolkata',  lat: 19.0760, lng: 72.8777, radius: 150, wifi: 'TK-BOM-Office', color: '#37B6A4', groups: tkGroups('bom') },
  { id: 'nbo', code: 'NBO', city: 'Nairobi',   country: 'Kenya', flag: '🇰🇪', tz: 'Africa/Nairobi', lat: -1.2921, lng: 36.8219, radius: 150, wifi: 'TK-NBO-Office', color: '#E8A13A', groups: tkGroups('nbo') },
];

// branchesFor(bizId): only 'tk' has branches (preserves branchesFor helper behavior).
export const branchesFor = (bizId: string): Branch[] => (bizId === 'tk' ? branches : []);

export const businessDepts: Record<string, Department[]> = {
  tk: [
    { id: 'td1', name: 'Accounts',  icon: '$',  color: '#E8A13A' },
    { id: 'td2', name: 'Ticketing', icon: '✈',  color: '#4F8BFF' },
    { id: 'td3', name: 'Holidays',  icon: '☼',  color: '#37B6A4' },
    { id: 'td4', name: 'BM MGMT',   icon: 'BM', color: '#0C0E14' },
    { id: 'td5', name: 'MKTG',      icon: '★',  color: '#EC4899' },
  ],
  qa: [], hk: [], kd: [], adb: [], ndb: [], kl: [],
};
