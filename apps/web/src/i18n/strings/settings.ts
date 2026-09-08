/** Admin system settings page. */
const en = {
  title: 'System settings',
  subtitle: 'Instance-wide configuration.',
  registration: 'Registration',
  registrationDesc:
    'When enabled, anyone can create an account. When disabled, only admins can add users.',
  allowPublicRegistration: 'Allow public registration',
  currentState: 'Current state:',
  open: 'Open',
  closed: 'Closed',
  registrationOpened: 'Registration opened',
  registrationClosed: 'Registration closed',
};

const zh: typeof en = {
  title: '系统设置',
  subtitle: '实例级配置。',
  registration: '注册',
  registrationDesc: '开启后，任何人都可以创建账户；关闭后，只有管理员能添加用户。',
  allowPublicRegistration: '允许公开注册',
  currentState: '当前状态：',
  open: '开放',
  closed: '关闭',
  registrationOpened: '已开放注册',
  registrationClosed: '已关闭注册',
};

export const settingsStrings = { en, zh };
