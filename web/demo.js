// Sample projects for "load demo data". Dates are days from today.
export const SAMPLE_PRIORITIES = {
  'AWS Solutions Architect Associate|Sit exam': 'high',
  'AWS Solutions Architect Associate|Practice exam 2': 'medium',
  'CKA - Kubernetes Admin|Build lab cluster': 'low',
};

export const SAMPLE_COSTS = {
  'AWS Solutions Architect Associate|Practice exam 1': 3300,
  'AWS Solutions Architect Associate|Sit exam': 20000,
  'CKA - Kubernetes Admin|Sit exam': 59000,
};

// Each milestone is [title, start days or null, due days, status].
export const SAMPLE_PROJECTS = [
  {
    name: 'AWS Solutions Architect Associate',
    description: 'Study plan for the SAA-C03 certification.',
    status: 'active', start: -30, target: 45, color: '#7aa2f7',
    milestones: [
      ['Finish video course', -30, -15, 'done'],
      ['Practice exam 1', -14, -5, 'done'],
      ['Practice exam 2', -4, 15, 'in_progress'],
      ['Book exam', null, 30, 'todo'],
      ['Sit exam', null, 45, 'todo'],
    ],
  },
  {
    name: 'CKA - Kubernetes Admin',
    description: 'Certified Kubernetes Administrator prep.',
    status: 'planned', start: 20, target: 110, color: '#9ece6a',
    milestones: [
      ['Build lab cluster', 20, 35, 'todo'],
      ['Finish networking and storage labs', null, 70, 'todo'],
      ['Sit exam', null, 110, 'todo'],
    ],
  },
  {
    name: 'Learn Rust basics',
    description: 'Ownership, traits, and a first small CLI.',
    status: 'done', start: -120, target: -20, color: '#bb9af7',
    milestones: [
      ['Read the first half of the book', null, -100, 'done'],
      ['Finish Rustlings exercises', null, -70, 'done'],
      ['Ship a small CLI tool', null, -35, 'done'],
    ],
  },
  {
    name: 'Homelab rebuild',
    description: 'Move services onto a new hypervisor.',
    status: 'paused', start: -60, target: 30, color: '#e0af68',
    milestones: [
      ['Set up Proxmox host', -60, -20, 'done'],
      ['Migrate services', null, 20, 'in_progress'],
    ],
  },
];
